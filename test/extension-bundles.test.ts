import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleCachePath, extractBundle, installBundle, loadExtensionBundle, parseBundleCatalog, readBundleLock, type BundleTransport } from '../src/extension-bundles.ts';
import { readBoundedTgz } from '../src/extension-artifacts.ts';

function tar(files:Record<string,string>):Buffer { const pieces:Buffer[]=[]; for(const [path,text] of Object.entries(files)) { const body=Buffer.from(text),header=Buffer.alloc(512);header.write(path);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;header.fill(32,148,156);const checksum=[...header].reduce((sum,byte)=>sum+byte,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);pieces.push(header,body,Buffer.alloc((512-body.length%512)%512)); }pieces.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(pieces)); }
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const modulePath='node_modules/@jimhoyd/urlcode-sample/dist/index.js';
function entry(bytes:Uint8Array){return {name:'sample',version:'1.2.3',asset:'official-1.2.3.tgz',sha256:sha(bytes),entry:modulePath};}
function archive(){const manifest={format:1,coreVersion:'0.4.9',bundles:[{name:'sample',version:'1.2.3',entry:modulePath}]};return tar({'bundle.json':JSON.stringify(manifest),[modulePath]:'export const loaded = "verified";'});}

function ustar(path:string,body:string):Buffer { const pieces=path.split('/'),name=pieces.pop()!,prefix=pieces.join('/'),bytes=Buffer.from(body),header=Buffer.alloc(512);header.write(name,0,100);header.write(prefix,345,155);header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;header.write('ustar\0',257,6);header.write('00',263,2);header.fill(32,148,156);const checksum=[...header].reduce((sum,byte)=>sum+byte,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);return gzipSync(Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512),Buffer.alloc(1024)])); }

test('extension bundle extraction accepts a frozen module tree and rejects extra files',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});const bytes=archive(),item={...entry(bytes),coreVersion:'0.4.9'};
  await extractBundle(bytes,item,join(project,'installed'));assert.match(await readFile(join(project,'installed',modulePath),'utf8'),/verified/);
  const invalid=tar({'bundle.json':JSON.stringify({format:1,coreVersion:'0.4.9',bundles:[{name:'sample',version:'1.2.3',entry:modulePath}]}),[modulePath]:'export{}','README.md':'not part of a module tree'});
  await assert.rejects(()=>extractBundle(invalid,{...entry(invalid),coreVersion:'0.4.9'},join(project,'invalid')),/outside its frozen module tree/);
});

test('signed bundle installation writes a lock and host loader imports only the verified entry',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-install-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});const bytes=archive(),item=entry(bytes),catalog=Buffer.from(JSON.stringify({format:1,tag:'extension-bundles@v1.0.0',commit:'a'.repeat(40),coreVersion:'0.4.9',bundles:[item],revoked:[]})),verified:string[]=[];
  const transport:BundleTransport={release:async()=>[{name:'extension-bundles-catalog.json',url:'catalog'},{name:item.asset,url:'bundle'}],download:async url=>url==='catalog'?catalog:bytes,attest:async(_path,release)=>{verified.push(release);}};
  const lock=await installBundle(project,'extension-bundles@v1.0.0','sample',transport);assert.equal(lock.bundles[0]?.catalog.tag,'extension-bundles@v1.0.0');assert.deepEqual(verified,['extension-bundles@v1.0.0','extension-bundles@v1.0.0']);assert.equal((await loadExtensionBundle(project,'sample')).loaded,'verified');assert.equal((await readBundleLock(project)).bundles[0]?.sha256,item.sha256);
  await writeFile(join(bundleCachePath(project,item.sha256),modulePath),'export const loaded = "altered";');await assert.rejects(()=>loadExtensionBundle(project,'sample'),/modified/);
});

test('bundle catalog refuses tag changes, duplicate names and a core mismatch',()=>{
  const item={...entry(Buffer.from('bundle')),sha256:'b'.repeat(64)},base={format:1,tag:'extension-bundles@v1.0.0',commit:'a'.repeat(40),coreVersion:'0.4.9',bundles:[item],revoked:[]};
  assert.equal(parseBundleCatalog(Buffer.from(JSON.stringify(base)),'extension-bundles@v1.0.0').bundles.length,1);
  assert.throws(()=>parseBundleCatalog(Buffer.from(JSON.stringify({...base,tag:'extension-bundles@v1.0.1'})),'extension-bundles@v1.0.0'));
  assert.throws(()=>parseBundleCatalog(Buffer.from(JSON.stringify({...base,bundles:[item,item]})),'extension-bundles@v1.0.0'),/more than once/);
  assert.throws(()=>parseBundleCatalog(Buffer.from(JSON.stringify({...base,bundles:[{...item,entry:'node_modules/@jimhoyd/urlcode-sample/dist/../../outside.js'}]})),'extension-bundles@v1.0.0'),/Invalid/);
});

test('bundle extraction accepts a standard USTAR prefix path',async()=>{
  const long=`node_modules/${'dependency/'.repeat(12)}module.js`, archive=ustar(long,'export{}');
  assert.equal(readBoundedTgz(archive,{archive:1024*1024,expanded:1024*1024,files:2,file:1024,label:'test'})[0]?.path,long);
});
