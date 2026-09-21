import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { ConfigError, assert } from './errors.ts';

/** Offline, declarative extension bundles. These are deliberately not Node packages. */
export const ARTIFACT_REPOSITORY = 'jimhoyd-com/urlcode';
export const ARTIFACT_WORKFLOW = 'jimhoyd-com/urlcode/.github/workflows/extension-artifacts.yml';
const MAX_ARCHIVE = 16 * 1024 * 1024, MAX_EXPANDED = 32 * 1024 * 1024, MAX_FILES = 128, MAX_FILE = 2 * 1024 * 1024;
const MAX_TOOL_FILE = 512 * 1024;
const hex = /^[a-f0-9]{64}$/;
const name = /^[a-z][a-z0-9-]{0,63}$/;
const tag = /^extensions@v[0-9][0-9A-Za-z._-]{0,100}$/;

export interface ArtifactEntry { name:string; version:string; asset:string; sha256:string; kind:'declarative'; }
export interface Catalog { format:1; tag:string; commit:string; artifacts:ArtifactEntry[]; revoked: {sha256:string; reason:string}[]; }
export interface LockedArtifact extends ArtifactEntry { catalog:{tag:string;commit:string} }
export interface ExtensionLock { format:1; artifacts:LockedArtifact[]; }
type UnknownRecord = Record<string, unknown>;
const record=(v:unknown):v is UnknownRecord=>v !== null && typeof v==='object' && !Array.isArray(v);
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function text(value:unknown, what:string):string { assert(typeof value==='string' && value.length>0 && value.length<256,`Invalid ${what} in extension artifact metadata`); return value; }
function exactKeys(value:UnknownRecord, expected:readonly string[], what:string):void { const actual=Object.keys(value).sort(); assert(JSON.stringify(actual)===JSON.stringify([...expected].sort()),`${what} has unknown or missing fields`); }

/** Parse an untrusted catalog only after its GitHub attestation was verified by the caller. */
export function parseCatalog(bytes:Uint8Array, requestedTag:string):Catalog {
  let raw:unknown; try { raw=JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ConfigError('Extension catalog is not valid JSON'); }
  assert(record(raw) && raw.format===1,'Unsupported extension catalog format');
  exactKeys(raw,['format','tag','commit','artifacts','revoked'],'Extension catalog');
  const catalogTag=text(raw.tag,'catalog tag'), commit=text(raw.commit,'catalog commit');
  assert(tag.test(catalogTag) && catalogTag===requestedTag,'Extension catalog tag does not match the immutable requested release');
  assert(/^[a-f0-9]{40}$/.test(commit),'Extension catalog has an invalid commit pin');
  assert(Array.isArray(raw.artifacts) && Array.isArray(raw.revoked),'Extension catalog is incomplete');
  const seen=new Set<string>(), assets=new Set<string>(), digests=new Set<string>(), artifacts:ArtifactEntry[]=[];
  for(const value of raw.artifacts) {
    assert(record(value),'Invalid extension catalog artifact');
    exactKeys(value,['name','version','asset','sha256','kind'],'Extension catalog artifact');
    const item:ArtifactEntry={name:text(value.name,'artifact name'),version:text(value.version,'artifact version'),asset:text(value.asset,'artifact asset'),sha256:text(value.sha256,'artifact sha256'),kind:value.kind==='declarative'?'declarative':(() => { throw new ConfigError('Extension catalog permits declarative artifacts only'); })()};
    assert(name.test(item.name) && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(item.version) && /^[A-Za-z0-9._-]+\.tgz$/.test(item.asset) && hex.test(item.sha256),'Invalid extension catalog artifact');
    assert(!seen.has(item.name),`Extension catalog names ${item.name} more than once`); assert(!assets.has(item.asset)&&!digests.has(item.sha256),'Extension catalog repeats an artifact asset or digest'); seen.add(item.name); assets.add(item.asset); digests.add(item.sha256); artifacts.push(item);
  }
  const revoked:Catalog['revoked']=[], revokedDigests=new Set<string>();
  for(const value of raw.revoked) { assert(record(value),'Invalid extension revocation'); exactKeys(value,['sha256','reason'],'Extension revocation'); const sha256=text(value.sha256,'revocation sha256'), reason=text(value.reason,'revocation reason'); assert(hex.test(sha256)&&!revokedDigests.has(sha256),'Invalid or duplicate extension revocation'); revokedDigests.add(sha256); revoked.push({sha256,reason}); }
  return {format:1,tag:catalogTag,commit,artifacts,revoked};
}

export interface TarFile { path:string; bytes:Uint8Array }
export interface ArchiveLimits { archive:number; expanded:number; files:number; file:number; label:string }
function octal(bytes:Uint8Array):number { const value=new TextDecoder().decode(bytes).replace(/\0.*$/,'').trim(); assert(/^[0-7]*$/.test(value),'Malformed extension archive'); return value ? Number.parseInt(value,8) : 0; }
function archivePath(name:Uint8Array,prefix:Uint8Array):string {
  const decode=(bytes:Uint8Array)=>new TextDecoder().decode(bytes).replace(/\0.*$/,'');
  const base=decode(name), directory=decode(prefix), value=directory?`${directory}/${base}`:base;
  assert(base.length>0 && !value.includes('\\') && !value.startsWith('/') && !value.split('/').includes('..'),'Unsafe extension archive path');
  return value;
}
/** A minimal tar reader: only regular files are accepted, before any write occurs. */
export function readBoundedTgz(source:Uint8Array, limits:ArchiveLimits):TarFile[] {
  assert(source.byteLength>0 && source.byteLength<=limits.archive,`${limits.label} exceeds the size limit`);
  let bytes:Uint8Array; try { bytes=gunzipSync(source,{maxOutputLength:limits.expanded}); } catch { throw new ConfigError(`${limits.label} is not a valid bounded gzip tarball`); }
  const files:TarFile[]=[]; let ended=false;
  for(let at=0;at<bytes.length;) {
    const header=bytes.subarray(at,at+512); if(header.length===512&&header.every(byte=>byte===0)) { const second=bytes.subarray(at+512,at+1024); assert(second.length===512&&second.every(byte=>byte===0)&&bytes.subarray(at+1024).every(byte=>byte===0),`Malformed ${limits.label} terminator`); ended=true; break; }
    assert(header.length===512,`Truncated ${limits.label}`); const stored=octal(header.subarray(148,156)); let checksum=0; for(let index=0;index<header.length;index++) checksum+=index>=148&&index<156?32:header[index]!; assert(stored===checksum,`${limits.label} has an invalid tar checksum`); const size=octal(header.subarray(124,136)); const type=header[156] ?? 0;
    assert(type===0 || type===48,`${limits.label} may contain regular files only`); assert(size<=limits.file && at+512+size<=bytes.length,`Invalid ${limits.label} member`);
    const path=archivePath(header.subarray(0,100),header.subarray(345,500)); assert(!files.some(file=>file.path===path),`${limits.label} repeats a path`);
    files.push({path,bytes:bytes.slice(at+512,at+512+size)}); assert(files.length<=limits.files,`${limits.label} has too many files`); at+=512+Math.ceil(size/512)*512;
  }
  assert(ended,`${limits.label} has no complete tar terminator`);
  return files;
}
function readTgz(source:Uint8Array):TarFile[] { return readBoundedTgz(source,{archive:MAX_ARCHIVE,expanded:MAX_EXPANDED,files:MAX_FILES,file:MAX_FILE,label:'Extension archive'}); }
async function diskFiles(root:string,prefix=''):Promise<string[]> { const found:string[]=[]; for(const item of await readdir(join(root,prefix),{withFileTypes:true})) { const path=prefix?`${prefix}/${item.name}`:item.name; assert(item.isDirectory()||item.isFile(),'Extension cache contains a link or special file'); if(item.isDirectory()) found.push(...await diskFiles(root,path)); else found.push(path); } return found.sort(); }
async function validateCached(root:string, entry:ArtifactEntry):Promise<void> { const archive=await readFile(join(root,'.artifact.tgz')); assert(digest(archive)===entry.sha256,`Cached extension artifact ${entry.name} does not match its lockfile`); const files=readTgz(archive); validateFiles(files,entry); const expected=['.artifact.tgz',...files.map(file=>file.path)].sort(); assert(JSON.stringify(await diskFiles(root))===JSON.stringify(expected),`Cached extension artifact ${entry.name} has unexpected files`); for(const file of files) assert(digest(await readFile(join(root,file.path)))===digest(file.bytes),`Cached extension artifact ${entry.name} was modified`); }
function validateFiles(files:TarFile[], entry:ArtifactEntry):void {
  const allowed=/^(?:extension\.json|README\.md|schemas\/[A-Za-z0-9._-]+\.json|config\/[A-Za-z0-9._-]+\.json)$/;
  assert(files.length>0 && files.every(file=>allowed.test(file.path)),'Extension artifact contains a file type that is not declarative data');
  for(const file of files) if(file.path.endsWith('.json')) try { JSON.parse(new TextDecoder().decode(file.bytes)); } catch { throw new ConfigError(`Extension artifact contains invalid JSON in ${file.path}`); }
  const manifest=files.find(file=>file.path==='extension.json'); assert(manifest,'Extension artifact is missing extension.json');
  let raw:unknown; try { raw=JSON.parse(new TextDecoder().decode(manifest.bytes)); } catch { throw new ConfigError('extension.json is not valid JSON'); }
  assert(record(raw),'extension.json must be an object'); exactKeys(raw,['format','kind','name','version'],'extension.json');
  assert(record(raw) && raw.format===1 && raw.kind==='declarative' && raw.name===entry.name && raw.version===entry.version,'extension.json does not match its signed catalog entry');
}
export async function extractArtifact(bytes:Uint8Array, entry:ArtifactEntry, destination:string):Promise<void> {
  assert(digest(bytes)===entry.sha256,`Extension artifact ${entry.name} does not match its signed SHA-256`); const files=readTgz(bytes); validateFiles(files,entry);
  const root=resolve(destination), temporary=join(tmpdir(),`urlcode-extension-${process.pid}-${Math.random().toString(16).slice(2)}`); await mkdir(temporary,{recursive:true});
  try { for(const file of files) { const target=resolve(temporary,file.path); assert(relative(temporary,target) && !relative(temporary,target).startsWith('..'),'Unsafe extension archive path'); await mkdir(dirname(target),{recursive:true}); await writeFile(target,file.bytes,{flag:'wx'}); } await writeFile(join(temporary,'.artifact.tgz'),bytes,{flag:'wx'}); await mkdir(dirname(root),{recursive:true}); try { await rename(temporary,root); } catch { try { await validateCached(root,entry); return; } catch { throw new ConfigError(`Extension cache entry ${entry.sha256} already exists but is not identical`); } } } finally { await rm(temporary,{recursive:true,force:true}); }
}
export async function readLock(project:string):Promise<ExtensionLock> { let raw:unknown; try { const path=join(project,'urlcode.extensions.lock.json'), info=await lstat(path); assert(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1,'Extension artifact lockfile must be an ordinary file'); raw=JSON.parse(await readFile(path,'utf8')); } catch(error) { if(error instanceof ConfigError)throw error; throw new ConfigError('No extension artifact lockfile; install an artifact first'); } assert(record(raw)&&raw.format===1&&Array.isArray(raw.artifacts),'Invalid extension artifact lockfile'); exactKeys(raw,['format','artifacts'],'Extension artifact lockfile'); const seen=new Set<string>(),digests=new Set<string>(); const artifacts=raw.artifacts.map(value=>{ assert(record(value)&&record(value.catalog),'Invalid extension artifact lockfile'); exactKeys(value,['name','version','asset','sha256','kind','catalog'],'Extension artifact lock entry'); exactKeys(value.catalog,['tag','commit'],'Extension artifact lock catalog'); const item:LockedArtifact={name:text(value.name,'lockfile artifact'),version:text(value.version,'lockfile artifact'),asset:text(value.asset,'lockfile artifact'),sha256:text(value.sha256,'lockfile artifact'),kind:value.kind==='declarative'?'declarative':(()=>{throw new ConfigError('Invalid extension artifact lockfile');})(),catalog:{tag:text(value.catalog.tag,'lockfile tag'),commit:text(value.catalog.commit,'lockfile commit')}}; assert(name.test(item.name)&&/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(item.version)&&/^[A-Za-z0-9._-]+\.tgz$/.test(item.asset)&&hex.test(item.sha256)&&tag.test(item.catalog.tag)&&/^[a-f0-9]{40}$/.test(item.catalog.commit)&&!seen.has(item.name)&&!digests.has(item.sha256),'Invalid or duplicate extension artifact lock entry'); seen.add(item.name); digests.add(item.sha256); return item; }); return {format:1,artifacts}; }
export async function writeLock(project:string, lock:ExtensionLock):Promise<void> { const path=join(project,'urlcode.extensions.lock.json'), temporary=join(project,`.urlcode.extensions.lock.${process.pid}.${Math.random().toString(16).slice(2)}`); await writeFile(temporary,JSON.stringify(lock,null,2)+'\n',{flag:'wx'}); try { await rename(temporary,path); } finally { await rm(temporary,{force:true}); } }
export function cachePath(project:string, sha256:string):string { assert(hex.test(sha256),'Invalid extension digest'); return join(project,'.urlcode','extensions',sha256); }

export interface ReleaseAsset { name:string; url:string; }
export interface ArtifactTransport { release(tag:string):Promise<ReleaseAsset[]>; download(url:string):Promise<Uint8Array>; attest(path:string,release:string):Promise<void>; }
function releaseUrl(tagName:string):string { return `https://api.github.com/repos/${ARTIFACT_REPOSITORY}/releases/tags/${encodeURIComponent(tagName)}`; }
function githubDownloadUrl(value:string):URL { const url=new URL(value); assert(url.protocol==='https:'&&(url.hostname==='github.com'||url.hostname.endsWith('.githubusercontent.com')),'Extension release redirect left GitHub'); return url; }
async function githubDownload(value:string):Promise<Uint8Array> { let url=githubDownloadUrl(value); for(let redirects=0;redirects<=3;redirects++) { const response=await fetch(url,{redirect:'manual'}); if(response.status>=300&&response.status<400) { const location=response.headers.get('location'); assert(location&&redirects<3,'Extension release asset has an invalid redirect'); url=githubDownloadUrl(new URL(location,url).href); continue; } assert(response.ok&&response.body,'Could not download extension release asset'); const length=response.headers.get('content-length'); assert(length===null||(/^\d+$/.test(length)&&Number(length)<=MAX_ARCHIVE),'Extension release asset exceeds the size limit'); const chunks:Uint8Array[]=[]; let size=0; for await(const chunk of response.body) { size+=chunk.byteLength; assert(size<=MAX_ARCHIVE,'Extension release asset exceeds the size limit'); chunks.push(chunk); } const body=new Uint8Array(size); let offset=0; for(const chunk of chunks) { body.set(chunk,offset); offset+=chunk.byteLength; } return body; } throw new ConfigError('Extension release asset redirected too many times'); }
/** The default transport accepts only GitHub Release asset URLs and verifies every downloaded subject. */
export const githubTransport:ArtifactTransport={
  async release(tagName) { assert(tag.test(tagName),'Use an immutable extension release tag such as extensions@v1.0.0'); const response=await fetch(releaseUrl(tagName),{headers:{accept:'application/vnd.github+json'}}); assert(response.ok,`Could not fetch extension release ${tagName}`); const raw:unknown=await response.json(); assert(record(raw)&&Array.isArray(raw.assets),'Extension release has no asset inventory'); const seen=new Set<string>(); return raw.assets.map(item=>{ assert(record(item)&&typeof item.name==='string'&&typeof item.browser_download_url==='string'&&!seen.has(item.name),'Invalid or duplicate extension release asset'); seen.add(item.name); const url=new URL(item.browser_download_url); assert(url.protocol==='https:'&&url.hostname==='github.com'&&url.pathname.startsWith(`/${ARTIFACT_REPOSITORY}/releases/download/`),'Extension release asset is not a GitHub download'); return {name:item.name,url:url.href}; }); },
  async download(url) { return githubDownload(url); },
  async attest(path,release) { assert(tag.test(release),'Invalid extension artifact release tag'); await new Promise<void>((resolveVerify,reject)=>{ const child=spawn('gh',['attestation','verify',path,'--repo',ARTIFACT_REPOSITORY,'--signer-workflow',ARTIFACT_WORKFLOW,'--source-ref',`refs/tags/${release}`,'--deny-self-hosted-runners'],{stdio:'ignore'}); child.on('error',()=>reject(new ConfigError('GitHub CLI with attestation support is required to verify extension artifacts'))); child.on('exit',code=>code===0?resolveVerify():reject(new ConfigError('GitHub attestation verification refused the extension artifact'))); }); },
};
async function verifiedAsset(assets:ReleaseAsset[], asset:string, release:string, transport:ArtifactTransport):Promise<Uint8Array> { const found=assets.filter(item=>item.name===asset); assert(found.length===1,`Extension release is missing or repeats ${asset}`); const bytes=await transport.download(found[0]!.url); const temporary=join(tmpdir(),`urlcode-attest-${process.pid}-${Math.random().toString(16).slice(2)}`); await writeFile(temporary,bytes,{flag:'wx'}); try { await transport.attest(temporary,release); return bytes; } finally { await rm(temporary,{force:true}); } }
export async function resolveCatalog(release:string, transport:ArtifactTransport=githubTransport):Promise<{catalog:Catalog;assets:ReleaseAsset[]}> { const assets=await transport.release(release); const bytes=await verifiedAsset(assets,'extensions-catalog.json',release,transport); return {catalog:parseCatalog(bytes,release),assets}; }
export async function installArtifact(project:string, release:string, artifactName:string, transport:ArtifactTransport=githubTransport):Promise<ExtensionLock> {
  assert(name.test(artifactName),'Invalid extension artifact name'); const {catalog,assets}=await resolveCatalog(release,transport); const entry=catalog.artifacts.find(item=>item.name===artifactName); assert(entry,`Extension artifact ${artifactName} is not in the signed catalog`); const revoked=catalog.revoked.find(item=>item.sha256===entry.sha256); assert(!revoked,`Extension artifact ${artifactName} is revoked: ${revoked?.reason ?? 'unknown reason'}`);
  const bytes=await verifiedAsset(assets,entry.asset,release,transport); await extractArtifact(bytes,entry,cachePath(project,entry.sha256));
  let prior:ExtensionLock|undefined; try { prior=await readLock(project); } catch { /* first install */ }
  const artifacts=(prior?.artifacts ?? []).filter(item=>item.name!==entry.name); artifacts.push({...entry,catalog:{tag:catalog.tag,commit:catalog.commit}}); artifacts.sort((a,b)=>a.name.localeCompare(b.name)); const lock:ExtensionLock={format:1,artifacts}; await writeLock(project,lock); return lock;
}
export async function inspectArtifacts(project:string):Promise<{lock:ExtensionLock;cached:string[];missing:string[];invalid:string[]}> { const lock=await readLock(project), cached:string[]=[], missing:string[]=[], invalid:string[]=[]; for(const item of lock.artifacts) { const root=cachePath(project,item.sha256); try { await validateCached(root,item); cached.push(item.name); } catch { try { await lstat(root); invalid.push(item.name); } catch { missing.push(item.name); } } } return {lock,cached,missing,invalid}; }

/** Read-only inventory for authoring tools. Paths come from the verified archive, never from an arbitrary filesystem argument. */
export async function describeArtifactCache(project:string):Promise<{format:1;artifacts:(LockedArtifact&{status:'cached'|'missing'|'invalid';files:string[]})[]}> {
  const report=await inspectArtifacts(project), cached=new Set(report.cached), missing=new Set(report.missing);
  const artifacts=[];
  for(const item of report.lock.artifacts) {
    const status:'cached'|'missing'|'invalid'=cached.has(item.name)?'cached':missing.has(item.name)?'missing':'invalid';
    let files:string[]=[];
    if(status==='cached') {
      const archive=await readFile(join(cachePath(project,item.sha256),'.artifact.tgz'));
      assert(digest(archive)===item.sha256,`Cached extension artifact ${item.name} does not match its lockfile`);
      const members=readTgz(archive); validateFiles(members,item); files=members.map(file=>file.path).sort();
    }
    artifacts.push({...item,status,files});
  }
  return {format:1,artifacts};
}

/** Return one bounded text/JSON member from a verified cached artifact for MCP/agent consumers. */
export async function readArtifactMember(project:string,artifactName:string,path:string):Promise<{format:1;artifact:LockedArtifact;path:string;mediaType:'application/json'|'text/markdown';content:unknown}> {
  assert(name.test(artifactName),'Invalid extension artifact name');
  const allowed=/^(?:extension\.json|README\.md|schemas\/[A-Za-z0-9._-]+\.json|config\/[A-Za-z0-9._-]+\.json)$/;
  assert(allowed.test(path),'Invalid extension artifact member path');
  const lock=await readLock(project), artifact=lock.artifacts.find(item=>item.name===artifactName);
  assert(artifact,`Extension artifact ${artifactName} is not locked`);
  const root=cachePath(project,artifact.sha256); await validateCached(root,artifact);
  const archive=await readFile(join(root,'.artifact.tgz'));
  assert(digest(archive)===artifact.sha256,`Cached extension artifact ${artifact.name} does not match its lockfile`);
  const files=readTgz(archive); validateFiles(files,artifact); const member=files.find(file=>file.path===path);
  assert(member,`Extension artifact ${artifactName} has no ${path}`); assert(member.bytes.byteLength<=MAX_TOOL_FILE,'Extension artifact member exceeds the tooling output limit');
  let textValue:string; try { textValue=new TextDecoder('utf-8',{fatal:true}).decode(member.bytes); } catch { throw new ConfigError(`Extension artifact ${path} is not UTF-8 text`); }
  const json=path.endsWith('.json'); return {format:1,artifact,path,mediaType:json?'application/json':'text/markdown',content:json?JSON.parse(textValue):textValue};
}
