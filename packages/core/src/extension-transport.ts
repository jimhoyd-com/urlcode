import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, assert } from './errors.ts';
import { isRecord } from './object-guards.ts';
import type { UnknownRecord } from './object-guards.ts';

/** Shared GitHub release/cache/lockfile plumbing for extension-artifacts.ts and extension-bundles.ts. No opinion on what content is allowed or executable; that trust boundary stays local to each caller (#441). */

export { isRecord };
export type { UnknownRecord };
export const digestHex=(bytes:Uint8Array):string=>createHash('sha256').update(bytes).digest('hex');
export function textField(value:unknown, what:string):string { assert(typeof value==='string' && value.length>0 && value.length<256,`Invalid ${what}`); return value; }
export function exactKeys(value:UnknownRecord, expected:readonly string[], what:string):void { const actual=Object.keys(value).sort(); assert(JSON.stringify(actual)===JSON.stringify([...expected].sort()),`${what} has unknown or missing fields`); }
const capitalize=(value:string):string=>value.charAt(0).toUpperCase()+value.slice(1);

/** Sorted, recursive listing of an extension cache directory; refuses links and special files. */
export async function listCachedFiles(root:string, itemLabel:string, prefix=''):Promise<string[]> { const found:string[]=[]; for(const item of await readdir(join(root,prefix),{withFileTypes:true})) { const path=prefix?`${prefix}/${item.name}`:item.name; assert(item.isDirectory()||item.isFile(),`${capitalize(itemLabel)} cache contains a link or special file`); if(item.isDirectory()) found.push(...await listCachedFiles(root,itemLabel,path)); else found.push(path); } return found.sort(); }

/** Atomic write-then-rename for a JSON lockfile, refusing to clobber a concurrent writer. */
export async function writeLockAtomic(path:string, temporary:string, data:unknown):Promise<void> { await writeFile(temporary,JSON.stringify(data,null,2)+'\n',{flag:'wx'}); try { await rename(temporary,path); } finally { await rm(temporary,{force:true}); } }

export interface ReleaseAsset { name:string; url:string; }
export interface GithubTransport { release(tag:string):Promise<ReleaseAsset[]>; download(url:string):Promise<Uint8Array>; attest(path:string,release:string):Promise<void>; }
export interface GithubTransportConfig { repository:string; workflow:string; tagPattern:RegExp; exampleTag:string; maxAssetSize:number; itemLabel:string; }

/** A transport that accepts only GitHub Release asset URLs and verifies every downloaded subject. */
export function createGithubTransport(config:GithubTransportConfig):GithubTransport {
  const {repository,workflow,tagPattern,exampleTag,maxAssetSize,itemLabel}=config, releaseLabel=`${itemLabel} release`;
  const releaseUrl=(tagName:string):string=>`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`;
  function downloadUrl(value:string):URL { const url=new URL(value); assert(url.protocol==='https:'&&(url.hostname==='github.com'||url.hostname.endsWith('.githubusercontent.com')),`${capitalize(releaseLabel)} redirect left GitHub`); return url; }
  async function download(value:string):Promise<Uint8Array> { let url=downloadUrl(value); for(let redirects=0;redirects<=3;redirects++) { const response=await fetch(url,{redirect:'manual'}); if(response.status>=300&&response.status<400) { const location=response.headers.get('location'); assert(location&&redirects<3,`${capitalize(releaseLabel)} asset has an invalid redirect`); url=downloadUrl(new URL(location,url).href); continue; } assert(response.ok&&response.body,`Could not download ${releaseLabel} asset`); const length=response.headers.get('content-length'); assert(length===null||(/^\d+$/.test(length)&&Number(length)<=maxAssetSize),`${capitalize(releaseLabel)} asset exceeds the size limit`); const chunks:Uint8Array[]=[]; let size=0; for await(const chunk of response.body) { size+=chunk.byteLength; assert(size<=maxAssetSize,`${capitalize(releaseLabel)} asset exceeds the size limit`); chunks.push(chunk); } const body=new Uint8Array(size); let offset=0; for(const chunk of chunks) { body.set(chunk,offset); offset+=chunk.byteLength; } return body; } throw new ConfigError(`${capitalize(releaseLabel)} asset redirected too many times`); }
  return {
    async release(tagName) { assert(tagPattern.test(tagName),`Use an immutable ${releaseLabel} tag such as ${exampleTag}`); const response=await fetch(releaseUrl(tagName),{headers:{accept:'application/vnd.github+json'}}); assert(response.ok,`Could not fetch ${releaseLabel} ${tagName}`); const raw:unknown=await response.json(); assert(isRecord(raw)&&Array.isArray(raw.assets),`${capitalize(releaseLabel)} has no asset inventory`); const seen=new Set<string>(); return raw.assets.map(item=>{ assert(isRecord(item)&&typeof item.name==='string'&&typeof item.browser_download_url==='string'&&!seen.has(item.name),`Invalid or duplicate ${releaseLabel} asset`); seen.add(item.name); const url=new URL(item.browser_download_url); assert(url.protocol==='https:'&&url.hostname==='github.com'&&url.pathname.startsWith(`/${repository}/releases/download/`),`${capitalize(releaseLabel)} asset is not a GitHub download`); return {name:item.name,url:url.href}; }); },
    download,
    async attest(path,release) { assert(tagPattern.test(release),`Invalid ${itemLabel} release tag`); await new Promise<void>((resolveVerify,reject)=>{ const child=spawn('gh',['attestation','verify',path,'--repo',repository,'--signer-workflow',workflow,'--source-ref',`refs/tags/${release}`,'--deny-self-hosted-runners'],{stdio:'ignore'}); child.on('error',()=>reject(new ConfigError(`GitHub CLI with attestation support is required to verify ${itemLabel}s`))); child.on('exit',code=>code===0?resolveVerify():reject(new ConfigError(`GitHub attestation verification refused the ${itemLabel}`))); }); },
  };
}

/** Downloads one named release asset and has the transport attest it before returning its bytes. */
export async function verifiedReleaseAsset(assets:ReleaseAsset[], asset:string, release:string, transport:GithubTransport, itemLabel:string, tempPrefix:string):Promise<Uint8Array> { const found=assets.filter(item=>item.name===asset); assert(found.length===1,`${capitalize(itemLabel)} release is missing or repeats ${asset}`); const bytes=await transport.download(found[0]!.url); const temporary=join(tmpdir(),`${tempPrefix}-${process.pid}-${Math.random().toString(16).slice(2)}`); await writeFile(temporary,bytes,{flag:'wx'}); try { await transport.attest(temporary,release); return bytes; } finally { await rm(temporary,{force:true}); } }
