import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ARCHIVE=128*1024*1024, MAX_EXPANDED=512*1024*1024, MAX_FILES=12000, MAX_FILE=32*1024*1024;
const tagPattern=/^extension-bundles@v[0-9][0-9A-Za-z._-]{0,100}$/;
const revisionPattern=/^[a-f0-9]{40}$/;
const packageNames=['ui','auth','admin','store','forms'] as const;
type BundleName=typeof packageNames[number];
type SourceFile={path:string;bytes:Buffer};
type PackageRecord={name:string;version:string;filename:string};
export interface PreparedBundleCatalog { format:1;tag:string;commit:string;coreVersion:string;bundles:{name:BundleName;version:string;asset:string;sha256:string;entry:string}[];revoked:{sha256:string;reason:string}[]; }

function assert(condition:unknown,message:string):asserts condition { if(!condition)throw new Error(message); }
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function run(command:string,args:string[],cwd:string):void { const result=spawnSync(command,args,{cwd,stdio:'inherit',shell:false});if(result.error||result.status!==0)throw new Error(`${command} ${args[0]??''} failed`); }
function octal(header:Buffer,offset:number,length:number,value:number):void { const encoded=value.toString(8).padStart(length-1,'0')+'\0';assert(encoded.length===length,'Bundle tar field overflow');header.write(encoded,offset,length,'ascii'); }
function tarPath(path:string):{name:string;prefix:string}{
  assert(Buffer.byteLength(path,'utf8')<=255,'Extension bundle path exceeds the USTAR limit');
  if(Buffer.byteLength(path,'utf8')<=100)return {name:path,prefix:''};
  const pieces=path.split('/'); let name=pieces.pop()!;
  while(pieces.length&&Buffer.byteLength(name,'utf8')<=100){const prefix=pieces.join('/');if(Buffer.byteLength(prefix,'utf8')<=155)return {name,prefix};name=`${pieces.pop()}/${name}`;}
  throw new Error(`Extension bundle path cannot be represented by USTAR: ${path}`);
}
function tar(files:readonly SourceFile[]):Buffer { const parts:Buffer[]=[];for(const file of files){const path=tarPath(file.path),header=Buffer.alloc(512);header.write(path.name,0,100,'utf8');header.write(path.prefix,345,155,'utf8');octal(header,100,8,0o644);octal(header,108,8,0);octal(header,116,8,0);octal(header,124,12,file.bytes.byteLength);octal(header,136,12,0);header.fill(32,148,156);header[156]=48;header.write('ustar\0',257,6,'ascii');header.write('00',263,2,'ascii');const checksum=[...header].reduce((sum,byte)=>sum+byte,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');parts.push(header,file.bytes,Buffer.alloc((512-file.bytes.byteLength%512)%512));}parts.push(Buffer.alloc(1024));const result=Buffer.concat(parts);assert(result.byteLength<=MAX_EXPANDED,'Extension bundle exceeds the expanded size limit');return result; }
let crcTable:Uint32Array|undefined;
function crc32(bytes:Uint8Array):number { crcTable??=Uint32Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^value>>>1:value>>>1;return value>>>0;});let crc=0xffffffff;for(const byte of bytes)crc=crcTable[(crc^byte)&0xff]!^crc>>>8;return (crc^0xffffffff)>>>0; }
/** Deterministic gzip, deliberately using stored DEFLATE blocks. */
function gzip(bytes:Buffer):Buffer { const chunks:Buffer[]=[Buffer.from([0x1f,0x8b,0x08,0,0,0,0,0,0,0xff])];for(let offset=0;;){const size=Math.min(0xffff,bytes.byteLength-offset),final=offset+size===bytes.byteLength,header=Buffer.alloc(5);header[0]=final?1:0;header.writeUInt16LE(size,1);header.writeUInt16LE((~size)&0xffff,3);chunks.push(header,bytes.subarray(offset,offset+size));offset+=size;if(final)break;}const trailer=Buffer.alloc(8);trailer.writeUInt32LE(crc32(bytes),0);trailer.writeUInt32LE(bytes.byteLength>>>0,4);chunks.push(trailer);const result=Buffer.concat(chunks);assert(result.byteLength<=MAX_ARCHIVE,'Extension bundle exceeds the archive size limit');return result; }
async function files(root:string,prefix=''):Promise<SourceFile[]> { const found:SourceFile[]=[];const entries=await readdir(join(root,prefix),{withFileTypes:true});entries.sort((left,right)=>left.name.localeCompare(right.name));for(const item of entries){const path=prefix?`${prefix}/${item.name}`:item.name;if(item.name==='.bin'||item.name==='.package-lock.json')continue;assert(item.isDirectory()||item.isFile(),`Bundle module tree contains a link or special file at ${path}`);if(item.isDirectory())found.push(...await files(root,path));else {const bytes=await readFile(join(root,path));assert(bytes.byteLength<=MAX_FILE,`Bundle member exceeds the file size limit: ${path}`);found.push({path,bytes});}}return found; }
function packageManifest(value:unknown,what:string):{name:string;version:string}{assert(value!==null&&typeof value==='object'&&!Array.isArray(value),`Invalid ${what}`);const item=value as {name?:unknown;version?:unknown};assert(typeof item.name==='string'&&typeof item.version==='string',`Invalid ${what}`);return {name:item.name,version:item.version};}
function dependencySet(bundle:BundleName):BundleName[]{return bundle==='ui'?['ui']:bundle==='auth'?['ui','auth']:bundle==='admin'?['ui','auth','admin']:bundle==='forms'?['ui','forms']:['store'];}
function entryFor(bundle:BundleName):string{return `node_modules/@jimhoyd/urlcode-${bundle}/dist/${bundle==='ui'?'host/index':'index'}.js`;}

/** Build executable first-party extension bundles from one clean reviewed checkout. Nothing is published. */
export async function prepareExtensionBundles(root:string,output:string,tag:string,commit:string):Promise<PreparedBundleCatalog>{
  assert(tagPattern.test(tag),'Use an immutable extension bundle tag such as extension-bundles@v1.0.0');assert(revisionPattern.test(commit),'Use the exact 40-character source commit');
  const repository=resolve(root),destination=resolve(output);assert(relative(repository,destination).startsWith('..')||isAbsolute(relative(repository,destination)),'Extension bundle output must be outside the repository');await mkdir(destination);
  const temporary=await mkdtemp(join(tmpdir(),'urlcode-extension-bundles-'));
  try {
    const sources=join(temporary,'sources');run(process.execPath,[join(repository,'scripts','pack-sources.mjs'),'--repo',repository,'--revision',commit,'--out',sources],repository);
    const packed=JSON.parse(await readFile(join(sources,'source-manifest.json'),'utf8')) as {revision?:unknown;packages?:unknown};assert(packed.revision===commit&&Array.isArray(packed.packages),'Invalid source package manifest');
    const records=new Map<string,PackageRecord>();for(const value of packed.packages){const item=value as PackageRecord;assert(typeof item?.name==='string'&&typeof item.version==='string'&&typeof item.filename==='string'&&basename(item.filename)===item.filename, 'Invalid packed source package');records.set(item.name,item);}
    const core=records.get('@jimhoyd/urlcode');assert(core,'Source package manifest is missing core');const catalogBundles:PreparedBundleCatalog['bundles']=[];
    for(const bundle of packageNames){
      const selected=dependencySet(bundle), staging=join(temporary,bundle);await mkdir(staging);const dependencies:Record<string,string>={[core.name]:`file:${join(sources,core.filename)}`};
      for(const name of selected){const record=records.get(`@jimhoyd/urlcode-${name}`);assert(record,`Source package manifest is missing ${name}`);dependencies[record.name]=`file:${join(sources,record.filename)}`;}
      await writeFile(join(staging,'package.json'),`${JSON.stringify({name:'urlcode-extension-bundle-stage',private:true,version:'0.0.0',dependencies},null,2)}\n`,{flag:'wx'});
      run(process.platform==='win32'?'npm.cmd':'npm',['install','--ignore-scripts','--no-audit','--no-fund','--omit=dev','--package-lock=false'],staging);
      const tree=await files(staging,'node_modules');assert(tree.length>0&&tree.length<=MAX_FILES,`Extension bundle ${bundle} has an invalid file count`);
      const packageFile=tree.find(file=>file.path===`node_modules/@jimhoyd/urlcode-${bundle}/package.json`);assert(packageFile,`Extension bundle ${bundle} is missing its package manifest`);const manifest=packageManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(packageFile.bytes)),`${bundle} package manifest`);assert(manifest.name===`@jimhoyd/urlcode-${bundle}`,`Extension bundle ${bundle} has the wrong package manifest`);const entry=entryFor(bundle);assert(tree.some(file=>file.path===entry),`Extension bundle ${bundle} is missing its entry module`);
      const bundleJson=Buffer.from(`${JSON.stringify({format:1,coreVersion:core.version,bundles:[{name:bundle,version:manifest.version,entry}]},null,2)}\n`);const archive=gzip(tar([{path:'bundle.json',bytes:bundleJson},...tree]));const asset=`${bundle}-${manifest.version}.tgz`;await writeFile(join(destination,asset),archive,{flag:'wx'});catalogBundles.push({name:bundle,version:manifest.version,asset,sha256:sha256(archive),entry});
    }
    const catalog:PreparedBundleCatalog={format:1,tag,commit,coreVersion:core.version,bundles:catalogBundles,revoked:[]};await writeFile(join(destination,'extension-bundles-catalog.json'),`${JSON.stringify(catalog,null,2)}\n`,{flag:'wx'});return catalog;
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
function argumentsFrom(values:string[]):{tag:string;commit:string;output:string}{assert(values.length===6,'Use --tag <extension-bundles@v...> --commit <sha> --output <directory>');const options=new Map<string,string>();for(let index=0;index<values.length;index+=2){const flag=values[index]!,value=values[index+1]!;assert(['--tag','--commit','--output'].includes(flag)&&!options.has(flag),'Use --tag, --commit and --output exactly once');options.set(flag,value);}return {tag:options.get('--tag')!,commit:options.get('--commit')!,output:options.get('--output')!};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const options=argumentsFrom(process.argv.slice(2));await prepareExtensionBundles(process.cwd(),options.output,options.tag,options.commit);}
