import {open, realpath, stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname, resolve, relative, sep, extname} from 'node:path';
import {createHash} from 'node:crypto';
import {isBuiltin, stripTypeScriptTypes} from 'node:module';
import {init, parse} from 'es-module-lexer';
import {routeFunctions} from './function-sources.ts';
import type {FunctionRoute} from './function-sources.ts';

export interface TrustedDependencyInventory {
  files: {path:string;sha256:string}[];
  packages: string[];
  packageDeclarations: {name:string;lockfile:string;version?:string;integrity?:string}[];
  opaque: {source:string;reason:string}[];
  complete: boolean;
}
const limits={files:256,bytes:8*1024*1024,fileBytes:2*1024*1024};
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
export async function collectTrustedDependencies(routes:FunctionRoute[],root:string):Promise<TrustedDependencyInventory> {
  const result:TrustedDependencyInventory={files:[],packages:[],packageDeclarations:[],opaque:[],complete:true};
  if(!routes.length)return result;
  await init;
  root=await realpath(root);
  let bytes=0;
  const seen=new Set<string>(),packages=new Set<string>(),scopes=new Set<string>();
  const name=(file:string)=>relative(root,file).split(sep).join('/');
  const opaque=(source:string,reason:string)=>{result.complete=false;if(result.opaque.length<256)result.opaque.push({source,reason});};
  async function read(file:string):Promise<string|undefined>{
    const label=name(file);
    if(seen.has(file))return;
    if(seen.size>=limits.files){opaque(label,'file-count-limit');return;}
    seen.add(file);
    try{
      if(await realpath(file)!==file){opaque(label,'symlink');return;}
      const info=await stat(file);
      if(!info.isFile()){opaque(label,'not-a-file');return;}
      if(info.size>limits.fileBytes||bytes+info.size>limits.bytes){opaque(label,'byte-limit');return;}
      const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
      let data:Buffer;
      try{
        const buffer=Buffer.alloc(Math.min(limits.fileBytes,limits.bytes-bytes)+1);
        let count=0;
        while(count<buffer.length){const part=await handle.read(buffer,count,buffer.length-count,count);if(!part.bytesRead)break;count+=part.bytesRead;}
        data=buffer.subarray(0,count);
      }finally{await handle.close();}
      bytes+=data.length;
      if(data.length>limits.fileBytes||bytes>limits.bytes){opaque(label,'byte-limit');return;}
      result.files.push({path:label,sha256:hash(data)});
      return data.toString('utf8');
    }catch{opaque(label,'unresolved');return;}
  }
  async function walk(file:string):Promise<void>{
    const code=await read(file);if(code===undefined)return;
    const source=name(file);
    for(let base=dirname(file);base!==dirname(root);base=dirname(base)){
      const manifest=resolve(base,'package.json');
      if(!scopes.has(manifest)){scopes.add(manifest);try{await stat(manifest);await read(manifest);}catch{/* Absent package scope. */}}
      if(base===root)break;
    }
    if(extname(file)==='.json')return;
    if(/\brequire\s*\(|\bcreateRequire\b/.test(code))opaque(source,'commonjs-or-created-loader');
    let imports:ReturnType<typeof parse>[0];
    try{[imports]=parse(/\.[cm]?ts$/.test(file)?stripTypeScriptTypes(code,{mode:'strip'}):code);}catch{opaque(source,'unparsed-module');return;}
    for(const item of imports){
      if(item.type==='import-meta')continue;
      const specifier=item.specifier;
      if(typeof specifier!=='string'){opaque(source,'dynamic-import');continue;}
      if(isBuiltin(specifier))continue;
      if(specifier.startsWith('./')||specifier.startsWith('../')){
        const target=resolve(dirname(file),specifier);
        if(relative(root,target)==='..'||relative(root,target).startsWith('..'+sep)||specifier.includes('?')||specifier.includes('#')){opaque(source,'outside-project-or-url-import');continue;}
        if(relative(root,target).split(sep).includes('node_modules')){opaque(source,'package-path-not-inventoried');continue;}
        await walk(target);
      }else if(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/|$)/i.test(specifier)&&!specifier.includes(':')){
        const packageName=specifier.startsWith('@')?specifier.split('/').slice(0,2).join('/'):specifier.split('/')[0]!;
        if(packages.size<256&&packageName.length<=214)packages.add(packageName);else opaque(source,'package-count-or-name-limit');
      }else opaque(source,'unresolved-specifier');
    }
  }
  for(const definition of routes.flatMap(routeFunctions))await walk(definition.source);
  // Only the application and conventional parent site metadata, never arbitrary ancestors.
  for(const base of [root,dirname(root)])for(const filename of ['package.json','package-lock.json','npm-shrinkwrap.json']){
    const file=resolve(base,filename);
    try{await stat(file);}catch{continue;}
    const data=await read(file);
    if(data&&filename!=='package.json')try{
      const lock=JSON.parse(data) as {packages?:Record<string,{version?:unknown;integrity?:unknown}>};
      for(const packageName of [...packages].sort()){
        const entry=lock.packages?.['node_modules/'+packageName];
        if(entry)result.packageDeclarations.push({name:packageName,lockfile:name(file),...(typeof entry.version==='string'&&/^[a-z0-9.+_-]{1,128}$/i.test(entry.version)?{version:entry.version}:{}),...(typeof entry.integrity==='string'&&/^sha(?:256|384|512)-[a-z0-9+/=]{1,256}$/i.test(entry.integrity)?{integrity:entry.integrity}:{})});
      }
    }catch{opaque(name(file),'unparsed-lockfile');}
  }
  result.packages=[...packages].sort();
  if(packages.size)opaque('.', 'package-implementation-not-inventoried');
  if(packages.size&&!result.files.some(file=>/(?:package-lock|npm-shrinkwrap)\.json$/.test(file.path)))opaque('.', 'package-lock-unavailable');
  result.files.sort((a,b)=>compare(a.path,b.path));
  result.opaque.sort((a,b)=>compare(a.source,b.source)||compare(a.reason,b.reason));
  return result;
}
