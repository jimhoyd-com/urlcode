import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cachePath, describeArtifactCache, extractArtifact, inspectArtifacts, installArtifact, parseCatalog, readArtifactMember, type ArtifactTransport } from '../packages/core/src/extension-artifacts.ts';

function tar(files:Record<string,string>):Buffer { const pieces:Buffer[]=[]; for(const [path,text] of Object.entries(files)) { const body=Buffer.from(text), header=Buffer.alloc(512); header.write(path); header.write(body.length.toString(8).padStart(11,'0')+'\0',124); header[156]=48; header.fill(32,148,156); const checksum=[...header].reduce((sum,byte)=>sum+byte,0); header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148); pieces.push(header,body,Buffer.alloc((512-body.length%512)%512)); } pieces.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(pieces)); }
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const entry=(bytes:Uint8Array)=>({name:'sample',version:'1.2.3',asset:'sample-1.2.3.tgz',sha256:sha(bytes),kind:'declarative' as const});

test('extension artifact extraction accepts only signed declarative data',async t=>{
  const archive=tar({'extension.json':JSON.stringify({format:1,kind:'declarative',name:'sample',version:'1.2.3'}),'schemas/config.json':'{}'}), root=await mkdtemp(join(tmpdir(),'urlcode-artifact-')); t.after(async()=>{ await import('node:fs/promises').then(fs=>fs.rm(root,{recursive:true,force:true})); });
  await extractArtifact(archive,entry(archive),join(root,'installed'));
  assert.equal(JSON.parse(await readFile(join(root,'installed','extension.json'),'utf8')).name,'sample');
  const executable=tar({'extension.json':JSON.stringify({format:1,kind:'declarative',name:'sample',version:'1.2.3'}),'index.js':'export default 1'});
  await assert.rejects(()=>extractArtifact(executable,entry(executable),join(root,'bad')),/declarative data/);
  const malformed=Buffer.from(gzipSync(Buffer.alloc(1024)));
  await assert.rejects(()=>extractArtifact(malformed,entry(malformed),join(root,'malformed')),/declarative data|missing extension/);
});
test('catalog rejects a different tag, duplicate name, and executable kind',()=>{
  const base={format:1,tag:'extensions@v1.0.0',commit:'a'.repeat(40),revoked:[],artifacts:[{name:'sample',version:'1.2.3',asset:'sample.tgz',sha256:'b'.repeat(64),kind:'declarative'}]};
  assert.equal(parseCatalog(Buffer.from(JSON.stringify(base)),'extensions@v1.0.0').artifacts.length,1);
  assert.throws(()=>parseCatalog(Buffer.from(JSON.stringify({...base,tag:'extensions@v2.0.0'})),'extensions@v1.0.0'));
  assert.throws(()=>parseCatalog(Buffer.from(JSON.stringify({...base,unexpected:true})),'extensions@v1.0.0'),/unknown or missing/);
  assert.throws(()=>parseCatalog(Buffer.from(JSON.stringify({...base,artifacts:[...base.artifacts,{...base.artifacts[0]}]})),'extensions@v1.0.0'));
  assert.throws(()=>parseCatalog(Buffer.from(JSON.stringify({...base,artifacts:[{...base.artifacts[0],kind:'node'}]})),'extensions@v1.0.0'));
});
test('install verifies catalog and artifact attestations, honors revocation, and writes a lockfile',async t=>{
  const archive=tar({'extension.json':JSON.stringify({format:1,kind:'declarative',name:'sample',version:'1.2.3'})}), item=entry(archive), project=await mkdtemp(join(tmpdir(),'urlcode-artifact-install-')); t.after(async()=>{ await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true})); });
  const catalog=Buffer.from(JSON.stringify({format:1,tag:'extensions@v1.0.0',commit:'a'.repeat(40),revoked:[],artifacts:[item]})); const verified:string[]=[];
  const transport:ArtifactTransport={release:async()=>[{name:'extensions-catalog.json',url:'catalog'},{name:item.asset,url:'artifact'}],download:async url=>url==='catalog'?catalog:archive,attest:async(_path,release)=>{verified.push(release);}};
  const lock=await installArtifact(project,'extensions@v1.0.0','sample',transport); assert.equal(lock.artifacts[0]?.sha256,item.sha256); assert.equal(lock.artifacts[0]?.catalog.tag,'extensions@v1.0.0'); assert.deepEqual(verified,['extensions@v1.0.0','extensions@v1.0.0']); assert.equal((JSON.parse(await readFile(join(project,'urlcode.extensions.lock.json'),'utf8')) as {format:number}).format,1);
  assert.deepEqual((await inspectArtifacts(project)).cached,['sample']);
  const inventory=await describeArtifactCache(project); assert.equal(inventory.artifacts[0]?.status,'cached'); assert.deepEqual(inventory.artifacts[0]?.files,['extension.json']);
  const manifest=await readArtifactMember(project,'sample','extension.json'); assert.equal((manifest.content as {name:string}).name,'sample'); assert.equal(manifest.mediaType,'application/json');
  await assert.rejects(()=>readArtifactMember(project,'sample','../package.json'),/member path/);
  await writeFile(join(cachePath(project,item.sha256),'extension.json'),'{}');
  assert.deepEqual((await inspectArtifacts(project)).invalid,['sample']);
  await assert.rejects(()=>readArtifactMember(project,'sample','extension.json'),/modified/);
  const revoked=Buffer.from(JSON.stringify({format:1,tag:'extensions@v1.0.0',commit:'a'.repeat(40),revoked:[{sha256:item.sha256,reason:'withdrawn'}],artifacts:[item]}));
  await assert.rejects(()=>installArtifact(project,'extensions@v1.0.0','sample',{...transport,download:async url=>url==='catalog'?revoked:archive}),/revoked: withdrawn/);
});
test('installArtifact binds the catalog commit to the attestation source digest and fails closed on a mismatch (#577)',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-artifact-commit-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});
  const archive=tar({'extension.json':JSON.stringify({format:1,kind:'declarative',name:'sample',version:'1.2.3'})}), item=entry(archive), trueCommit='b'.repeat(40);
  // The catalog claims commit 'a'.repeat(40); the fake transport stands in for gh's unforgeable, cert-derived
  // `--source-digest` check and refuses whenever the caller passes a commit that disagrees with the real one.
  const mismatchedCatalog=Buffer.from(JSON.stringify({format:1,tag:'extensions@v1.0.0',commit:'a'.repeat(40),revoked:[],artifacts:[item]}));
  const seenRefused:(string|undefined)[]=[];
  const refusing:ArtifactTransport={release:async()=>[{name:'extensions-catalog.json',url:'catalog'},{name:item.asset,url:'artifact'}],download:async url=>url==='catalog'?mismatchedCatalog:archive,attest:async(_path:string,_release:string,commit?:string)=>{seenRefused.push(commit);if(commit!==undefined&&commit!==trueCommit)throw new Error(`GitHub attestation verification refused the extension artifact: source digest mismatch (expected ${trueCommit}, got ${commit})`);}};
  await assert.rejects(()=>installArtifact(project,'extensions@v1.0.0','sample',refusing),/source digest mismatch \(expected b{40}, got a{40}\)/);

  const matchingCatalog=Buffer.from(JSON.stringify({format:1,tag:'extensions@v1.0.0',commit:trueCommit,revoked:[],artifacts:[item]}));
  const seenAccepted:(string|undefined)[]=[];
  const accepting:ArtifactTransport={release:async()=>[{name:'extensions-catalog.json',url:'catalog'},{name:item.asset,url:'artifact'}],download:async url=>url==='catalog'?matchingCatalog:archive,attest:async(_path:string,_release:string,commit?:string)=>{seenAccepted.push(commit);if(commit!==undefined&&commit!==trueCommit)throw new Error('unexpected source digest');}};
  const lock=await installArtifact(project,'extensions@v1.0.0','sample',accepting);
  assert.equal(lock.artifacts[0]?.catalog.commit,trueCommit);

  // Caught on the catalog's own attestation (peeked ahead of the full parse), before the artifact asset is fetched;
  // the accepted install binds the same commit for both the catalog and the artifact attestations.
  assert.deepEqual(seenRefused,['a'.repeat(40)]);
  assert.deepEqual(seenAccepted,[trueCommit,trueCommit]);
});
