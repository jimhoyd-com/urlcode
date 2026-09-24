import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BUNDLE_CATALOG_NAMES, assertKnownBundleNames, bundleCachePath, extractBundle, githubBundleTransport, installBundle, loadExtensionBundle, parseBundleCatalog, readBundleLock, resolveBundleExecutable, type BundleTransport } from '../packages/core/src/extension-bundles.ts';
import { attestationDetail } from '../packages/core/src/extension-transport.ts';
import { ConfigError } from '../packages/core/src/errors.ts';
import { readBoundedTgz } from '../packages/core/src/extension-artifacts.ts';
import { verifyExtensionBundleRelease } from '../scripts/verify-extension-bundles.ts';

function tar(files:Record<string,string>):Buffer { const pieces:Buffer[]=[]; for(const [path,text] of Object.entries(files)) { const body=Buffer.from(text),header=Buffer.alloc(512);header.write(path);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;header.fill(32,148,156);const checksum=[...header].reduce((sum,byte)=>sum+byte,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);pieces.push(header,body,Buffer.alloc((512-body.length%512)%512)); }pieces.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(pieces)); }
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const coreVersion=(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
const modulePath='node_modules/@jimhoyd/urlcode-sample/dist/index.js';
function entry(bytes:Uint8Array){return {name:'sample',version:'1.2.3',asset:'official-1.2.3.tgz',sha256:sha(bytes),entry:modulePath};}
function archive(){const manifest={format:1,coreVersion,bundles:[{name:'sample',version:'1.2.3',entry:modulePath}]};return tar({'bundle.json':JSON.stringify(manifest),[modulePath]:'export const loaded = "verified";'});}

function ustar(path:string,body:string):Buffer { const pieces=path.split('/'),name=pieces.pop()!,prefix=pieces.join('/'),bytes=Buffer.from(body),header=Buffer.alloc(512);header.write(name,0,100);header.write(prefix,345,155);header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;header.write('ustar\0',257,6);header.write('00',263,2);header.fill(32,148,156);const checksum=[...header].reduce((sum,byte)=>sum+byte,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);return gzipSync(Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512),Buffer.alloc(1024)])); }

test('extension bundle extraction accepts a frozen module tree and rejects extra files',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});const bytes=archive(),item={...entry(bytes),coreVersion};
  await extractBundle(bytes,item,join(project,'installed'));assert.match(await readFile(join(project,'installed',modulePath),'utf8'),/verified/);
  const invalid=tar({'bundle.json':JSON.stringify({format:1,coreVersion,bundles:[{name:'sample',version:'1.2.3',entry:modulePath}]}),[modulePath]:'export{}','README.md':'not part of a module tree'});
  await assert.rejects(()=>extractBundle(invalid,{...entry(invalid),coreVersion},join(project,'invalid')),/outside its frozen module tree/);
});

test('signed bundle installation writes a lock and host loader imports only the verified entry',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-install-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});const bytes=archive(),item=entry(bytes),catalog=Buffer.from(JSON.stringify({format:1,tag:'extension-bundles@v1.0.0',commit:'a'.repeat(40),coreVersion,bundles:[item],revoked:[]})),verified:string[]=[];
  const transport:BundleTransport={release:async()=>[{name:'extension-bundles-catalog.json',url:'catalog'},{name:item.asset,url:'bundle'}],download:async url=>url==='catalog'?catalog:bytes,attest:async(_path,release)=>{verified.push(release);}};
  const lock=await installBundle(project,'extension-bundles@v1.0.0','sample',transport);assert.equal(lock.bundles[0]?.catalog.tag,'extension-bundles@v1.0.0');assert.deepEqual(verified,['extension-bundles@v1.0.0','extension-bundles@v1.0.0']);assert.equal((await loadExtensionBundle(project,'sample')).loaded,'verified');assert.equal((await readBundleLock(project)).bundles[0]?.sha256,item.sha256);
  await writeFile(join(bundleCachePath(project,item.sha256),modulePath),'export const loaded = "altered";');await assert.rejects(()=>loadExtensionBundle(project,'sample'),/modified/);
});

test('resolveBundleExecutable resolves a locked bundle\'s own packaged CLI from the verified cache, and it runs (#560,#594)',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-run-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});
  const binPath='node_modules/@jimhoyd/urlcode-sample/dist/cli.js',packageJsonPath='node_modules/@jimhoyd/urlcode-sample/package.json';
  const packageJson=JSON.stringify({name:'@jimhoyd/urlcode-sample',version:'1.2.3',bin:{'urlcode-sample':'dist/cli.js'}});
  const bytes=tar({'bundle.json':JSON.stringify({format:1,coreVersion,bundles:[{name:'sample',version:'1.2.3',entry:modulePath}]}),[modulePath]:'export const loaded = "verified";',[binPath]:'process.stdout.write(process.argv.slice(2).join(","));',[packageJsonPath]:packageJson});
  const item={name:'sample',version:'1.2.3',asset:'official-1.2.3.tgz',sha256:sha(bytes),entry:modulePath};
  const catalog=Buffer.from(JSON.stringify({format:1,tag:'extension-bundles@v1.0.0',commit:'a'.repeat(40),coreVersion,bundles:[item],revoked:[]}));
  const transport:BundleTransport={release:async()=>[{name:'extension-bundles-catalog.json',url:'catalog'},{name:item.asset,url:'bundle'}],download:async url=>url==='catalog'?catalog:bytes,attest:async()=>{}};
  await installBundle(project,'extension-bundles@v1.0.0','sample',transport);
  const script=await resolveBundleExecutable(project,'sample');
  assert.equal(script,join(bundleCachePath(project,item.sha256),binPath));
  const { execFileSync } = await import('node:child_process');
  assert.equal(execFileSync(process.execPath,[script,'--project','.','doctor'],{encoding:'utf8'}),'--project,.,doctor');
});

test('resolveBundleExecutable refuses a locked bundle that packages no command-line entry point',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-run-nobin-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});
  const bytes=archive(),item=entry(bytes),catalog=Buffer.from(JSON.stringify({format:1,tag:'extension-bundles@v1.0.0',commit:'a'.repeat(40),coreVersion,bundles:[item],revoked:[]}));
  const transport:BundleTransport={release:async()=>[{name:'extension-bundles-catalog.json',url:'catalog'},{name:item.asset,url:'bundle'}],download:async url=>url==='catalog'?catalog:bytes,attest:async()=>{}};
  await installBundle(project,'extension-bundles@v1.0.0','sample',transport);
  // The fixture's package.json (declared only inside bundle.json's manifest, not as a real node_modules file here) is
  // absent from the archive, so resolution fails on the missing manifest before it would even reach a missing bin.
  await assert.rejects(()=>resolveBundleExecutable(project,'sample'),/missing its package manifest/);
});

test('bundle catalog refuses tag changes, duplicate names and a core mismatch',()=>{
  const item={...entry(Buffer.from('bundle')),sha256:'b'.repeat(64)},base={format:1,tag:'extension-bundles@v1.0.0',commit:'a'.repeat(40),coreVersion,bundles:[item],revoked:[]};
  assert.equal(parseBundleCatalog(Buffer.from(JSON.stringify(base)),'extension-bundles@v1.0.0').bundles.length,1);
  assert.throws(()=>parseBundleCatalog(Buffer.from(JSON.stringify({...base,tag:'extension-bundles@v1.0.1'})),'extension-bundles@v1.0.0'));
  assert.throws(()=>parseBundleCatalog(Buffer.from(JSON.stringify({...base,bundles:[item,item]})),'extension-bundles@v1.0.0'),/more than once/);
  assert.throws(()=>parseBundleCatalog(Buffer.from(JSON.stringify({...base,bundles:[{...item,entry:'node_modules/@jimhoyd/urlcode-sample/dist/../../outside.js'}]})),'extension-bundles@v1.0.0'),/Invalid/);
});

test('bundle extraction accepts a standard USTAR prefix path',async()=>{
  const long=`node_modules/${'dependency/'.repeat(12)}module.js`, archive=ustar(long,'export{}');
  assert.equal(readBoundedTgz(archive,{archive:1024*1024,expanded:1024*1024,files:2,file:1024,label:'test'})[0]?.path,long);
});

test('installBundle lists the valid catalog names when the requested bundle is unknown',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-unknown-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});
  const bytes=archive(),item=entry(bytes),catalog=Buffer.from(JSON.stringify({format:1,tag:'extension-bundles@v1.0.0',commit:'a'.repeat(40),coreVersion,bundles:[item],revoked:[]}));
  const transport:BundleTransport={release:async()=>[{name:'extension-bundles-catalog.json',url:'catalog'}],download:async()=>catalog,attest:async()=>{}};
  await assert.rejects(()=>installBundle(project,'extension-bundles@v1.0.0','missing',transport),/Extension bundle missing is not in the signed catalog for extension-bundles@v1\.0\.0; valid names: sample/);
});

test('installBundle enriches a failed release fetch with --bundle-release and the known publish-timing gap',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-fetch-fail-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});
  const release='extension-bundles@v9.9.9';
  const transport:BundleTransport={release:async()=>{throw new Error(`Could not fetch extension bundle release ${release}`);},download:async()=>{throw new Error('unused');},attest:async()=>{}};
  await assert.rejects(()=>installBundle(project,release,'sample',transport),/Could not fetch extension bundle release extension-bundles@v9\.9\.9.*--bundle-release <tag>/s);
  // A differently-worded failure from a custom transport passes through unchanged rather than being misrepresented as this specific gap.
  const other:BundleTransport={release:async()=>{throw new Error('network is down');},download:async()=>{throw new Error('unused');},attest:async()=>{}};
  await assert.rejects(()=>installBundle(project,release,'sample',other),/^Error: network is down$/);
});

test('BUNDLE_CATALOG_NAMES lists every first-party bundle this release builds',()=>{
  assert.deepEqual(BUNDLE_CATALOG_NAMES.map(item=>item.name).sort(),['admin','auth','forms','store','ui']);
  for(const item of BUNDLE_CATALOG_NAMES)assert.ok(item.description.length>0);
});

test('bundle names are checked locally, with a suggestion, before the GitHub transport touches the network (#579)',async t=>{
  const project=await mkdtemp(join(tmpdir(),'urlcode-bundle-typo-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});
  const original=globalThis.fetch;let fetched=0;globalThis.fetch=(async()=>{fetched++;throw new Error('network must not be reached');}) as typeof fetch;t.after(()=>{globalThis.fetch=original;});
  await assert.rejects(()=>installBundle(project,'extension-bundles@v1.0.0','auht'),/Unknown extension bundle auht; did you mean auth\? Known bundles: ui, auth, admin, store, forms/);
  await assert.rejects(()=>installBundle(project,'extension-bundles@v1.0.0','formz'),/did you mean forms\?/);
  await assert.rejects(()=>installBundle(project,'extension-bundles@v1.0.0','zzz'),/Unknown extension bundle zzz\. Known bundles/);
  assert.equal(fetched,0);
  assert.doesNotThrow(()=>assertKnownBundleNames(['ui','auth','admin','store','forms']));
  assert.throws(()=>assertKnownBundleNames(['xy']),(error:unknown)=>error instanceof ConfigError&&!/did you mean/.test(error.message));
});

test('an unreachable GitHub is reported as a network failure naming the release, not a generic error (#579)',async t=>{
  const original=globalThis.fetch;globalThis.fetch=(async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'),{code:'ENOTFOUND'})});}) as typeof fetch;t.after(()=>{globalThis.fetch=original;});
  await assert.rejects(()=>githubBundleTransport.release('extension-bundles@v1.0.0'),(error:unknown)=>error instanceof ConfigError&&/^Could not reach GitHub to fetch extension bundle release extension-bundles@v1\.0\.0 \(ENOTFOUND\); check the network/.test(error.message));
  await assert.rejects(()=>githubBundleTransport.download('https://github.com/jimhoyd-com/urlcode/releases/download/extension-bundles%40v1.0.0/extension-bundles-catalog.json'),/Could not reach GitHub to fetch extension bundle release asset extension-bundles-catalog\.json \(ENOTFOUND\)/);
});

test('an attestation refusal excerpt is bounded, single-line and free of terminal control sequences (#579)',()=>{
  const raw='Loaded digest sha256:abc for file:///tmp/x\nLoaded 1 attestation from GitHub API\n\u001b[31mError: verifying with issuer "sigstore.dev"\u001b[0m\n\u001b[0;31mX\u001b[0m Failed to verify: expected SourceRepositoryRef to be refs/tags/extension-bundles@v0.5.9, got refs/heads/main\u0007\n';
  const detail=attestationDetail(raw);
  assert.match(detail,/expected SourceRepositoryRef to be refs\/tags\/extension-bundles@v0\.5\.9, got refs\/heads\/main/);
  assert.doesNotMatch(detail,/[\u0000-\u001f\u007f]/);
  assert.doesNotMatch(detail,/Loaded digest/);
  assert.ok(attestationDetail(`expected ${'x'.repeat(5000)}`).length<=600);
  assert.equal(attestationDetail('only\nuntelling\nlines\nhere'),'untelling | lines | here');
  assert.equal(attestationDetail(''),'');
});

test('the GitHub transport passes gh attestation output through when verification is refused (#579)',{skip:process.platform==='win32'&&'uses a POSIX shell script as a fake gh'},async t=>{
  const bin=await mkdtemp(join(tmpdir(),'urlcode-fake-gh-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(bin,{recursive:true,force:true}));});
  await writeFile(join(bin,'gh'),'#!/bin/sh\necho "Loaded 1 attestation from GitHub API"\necho "X Failed to verify: expected SourceRepositoryRef to be $9, got refs/heads/main" >&2\nexit 1\n',{mode:0o755});
  const path=process.env.PATH;process.env.PATH=`${bin}:${path??''}`;t.after(()=>{process.env.PATH=path;});
  await assert.rejects(()=>githubBundleTransport.attest(join(bin,'subject'),'extension-bundles@v0.5.9'),(error:unknown)=>error instanceof ConfigError&&/^GitHub attestation verification refused the extension bundle from extension-bundles@v0\.5\.9 \(policy: signer workflow jimhoyd-com\/urlcode\/\.github\/workflows\/extension-bundles\.yml, source ref refs\/tags\/extension-bundles@v0\.5\.9\): X Failed to verify: expected SourceRepositoryRef to be refs\/tags\/extension-bundles@v0\.5\.9, got refs\/heads\/main$/.test(error.message));
});

test('the release-side check verifies every asset with the CLI transport policy and refuses a catalog users could not install (#579)',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'urlcode-bundle-release-'));t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(dir,{recursive:true,force:true}));});
  const release='extension-bundles@v1.0.0',bundles:{name:string;version:string;asset:string;sha256:string;entry:string}[]=[];
  for(const {name} of BUNDLE_CATALOG_NAMES){const path=`node_modules/@jimhoyd/urlcode-${name}/dist/index.js`,bytes=tar({'bundle.json':JSON.stringify({format:1,coreVersion,bundles:[{name,version:'1.0.0',entry:path}]}),[path]:'export{}'});await writeFile(join(dir,`${name}-1.0.0.tgz`),bytes);bundles.push({name,version:'1.0.0',asset:`${name}-1.0.0.tgz`,sha256:sha(bytes),entry:path});}
  const writeCatalog=(list:typeof bundles)=>writeFile(join(dir,'extension-bundles-catalog.json'),JSON.stringify({format:1,tag:release,commit:'a'.repeat(40),coreVersion,bundles:list,revoked:[]}));
  await writeCatalog(bundles);
  const attested:string[]=[];
  assert.deepEqual(await verifyExtensionBundleRelease(dir,release,{attest:async(path,tag)=>{assert.equal(tag,release);attested.push(path.split(/[\\/]/).pop()!);}}),BUNDLE_CATALOG_NAMES.map(item=>item.name).sort());
  assert.deepEqual(attested.sort(),['extension-bundles-catalog.json',...bundles.map(item=>item.asset)].sort());
  await assert.rejects(()=>verifyExtensionBundleRelease(dir,release,{attest:async()=>{throw new ConfigError('GitHub attestation verification refused the extension bundle: expected SourceRepositoryRef to be refs/tags/extension-bundles@v1.0.0, got refs/heads/main');}}),/got refs\/heads\/main/);
  await writeCatalog(bundles.slice(1));
  await assert.rejects(()=>verifyExtensionBundleRelease(dir,release,{attest:async()=>{}}),/differ from the names this core validates locally/);
});
