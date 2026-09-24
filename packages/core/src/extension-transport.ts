import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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
const COMMIT=/^[a-f0-9]{40}$/;
/**
 * Reads only the top-level `commit` field of a catalog JSON payload, before the full validated parse runs, so it
 * can be handed to `attest` as the expected `--source-digest` in the same verification call that checks the
 * catalog's signature, signer workflow and tag (#577). This peek is unauthenticated: a tampered value only makes
 * that attest call fail closed (GitHub's cert-embedded source digest, not this field, decides the outcome), it
 * never grants trust on its own.
 */
export function peekCatalogCommit(bytes:Uint8Array):string { let raw:unknown; try { raw=JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ConfigError('Catalog is not valid JSON'); } assert(isRecord(raw)&&typeof raw.commit==='string'&&COMMIT.test(raw.commit),'Catalog has no valid commit field to verify against its attestation'); return raw.commit; }
const MAX_CAPTURED_OUTPUT=16*1024, MAX_DETAIL=600;
/** Collects at most MAX_CAPTURED_OUTPUT bytes of a child's output; anything beyond is dropped rather than buffered. */
function boundedOutput():{push:(chunk:Buffer)=>void; text:()=>string} { const chunks:Buffer[]=[]; let size=0; return { push:(chunk:Buffer)=>{ if(size>=MAX_CAPTURED_OUTPUT) return; const part=chunk.subarray(0,MAX_CAPTURED_OUTPUT-size); chunks.push(part); size+=part.byteLength; }, text:()=>Buffer.concat(chunks).toString('utf8') }; }
/** A single-line, bounded excerpt of `gh` output for an error message: escape sequences and control characters removed, the lines that state the refusal preferred, and nothing beyond MAX_DETAIL characters. */
export function attestationDetail(raw:string):string {
  const lines=raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g,'').replace(/\u001b[\]P^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g,'').split(/\r?\n/).map(line=>line.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim()).filter(Boolean);
  const telling=lines.filter(line=>/expected|error|fail|refus|mismatch|not found|no attestations|unauthori[sz]ed|forbidden|auth login|rate limit/i.test(line));
  const detail=[...new Set((telling.length?telling:lines.slice(-3)))].join(' | ');
  return detail.length>MAX_DETAIL?`${detail.slice(0,MAX_DETAIL-3)}...`:detail;
}
/** Turns a transport-level fetch failure (DNS, refused connection, TLS, offline) into a message that says GitHub was unreachable, instead of an opaque TypeError the CLI can only report generically. */
async function reach(request:()=>Promise<Response>, what:string):Promise<Response> { try { return await request(); } catch(error) { const cause=error instanceof Error&&isRecord(error.cause)?error.cause:undefined, code=cause&&typeof cause.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(cause.code)?` (${cause.code})`:''; throw new ConfigError(`Could not reach GitHub to fetch ${what}${code}; check the network connection, proxy settings and https://www.githubstatus.com, then retry`); } }
interface GithubTransport { release(tag:string):Promise<ReleaseAsset[]>; download(url:string):Promise<Uint8Array>; attest(path:string,release:string,commit?:string):Promise<void>; }
interface GithubTransportConfig { repository:string; workflow:string; tagPattern:RegExp; exampleTag:string; maxAssetSize:number; itemLabel:string; }

/**
 * Runs `gh attestation verify` with the given argv (already carrying `--repo`/`--signer-workflow`/`--source-ref`/
 * `--deny-self-hosted-runners`, and for the local/offline transport a `--bundle <local sigstore bundle>`) and turns
 * a non-zero exit into a `ConfigError` naming the policy and a bounded excerpt of what `gh` said. Shared by the
 * network transport (which lets `gh` fetch attestations from the GitHub API) and the local transport (which points
 * `gh` at a bundle already on disk) so both go through the identical verification call and refusal wording.
 */
async function runAttestationVerify(argv:string[],itemLabel:string,release:string,workflow:string,commit?:string):Promise<void> { await new Promise<void>((resolveVerify,reject)=>{ const child=spawn('gh',argv,{stdio:['ignore','pipe','pipe']}); const output=boundedOutput(); child.stdout.on('data',output.push); child.stderr.on('data',output.push); child.on('error',()=>reject(new ConfigError(`GitHub CLI with attestation support is required to verify ${itemLabel}s`))); child.on('close',code=>{ if(code===0) { resolveVerify(); return; } const detail=attestationDetail(output.text()); const policy=`signer workflow ${workflow}, source ref refs/tags/${release}${commit?`, source commit ${commit}`:''}`; reject(new ConfigError(`GitHub attestation verification refused the ${itemLabel} from ${release} (policy: ${policy})${detail?`: ${detail}`:''}`)); }); }); }

/** A transport that accepts only GitHub Release asset URLs and verifies every downloaded subject. */
export function createGithubTransport(config:GithubTransportConfig):GithubTransport {
  const {repository,workflow,tagPattern,exampleTag,maxAssetSize,itemLabel}=config, releaseLabel=`${itemLabel} release`;
  const releaseUrl=(tagName:string):string=>`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tagName)}`;
  function downloadUrl(value:string):URL { const url=new URL(value); assert(url.protocol==='https:'&&(url.hostname==='github.com'||url.hostname.endsWith('.githubusercontent.com')),`${capitalize(releaseLabel)} redirect left GitHub`); return url; }
  async function download(value:string):Promise<Uint8Array> { let url=downloadUrl(value); for(let redirects=0;redirects<=3;redirects++) { const response=await reach(()=>fetch(url,{redirect:'manual'}),`${releaseLabel} asset ${url.pathname.split('/').pop()??''}`); if(response.status>=300&&response.status<400) { const location=response.headers.get('location'); assert(location&&redirects<3,`${capitalize(releaseLabel)} asset has an invalid redirect`); url=downloadUrl(new URL(location,url).href); continue; } assert(response.ok&&response.body,`Could not download ${releaseLabel} asset`); const length=response.headers.get('content-length'); assert(length===null||(/^\d+$/.test(length)&&Number(length)<=maxAssetSize),`${capitalize(releaseLabel)} asset exceeds the size limit`); const chunks:Uint8Array[]=[]; let size=0; for await(const chunk of response.body) { size+=chunk.byteLength; assert(size<=maxAssetSize,`${capitalize(releaseLabel)} asset exceeds the size limit`); chunks.push(chunk); } const body=new Uint8Array(size); let offset=0; for(const chunk of chunks) { body.set(chunk,offset); offset+=chunk.byteLength; } return body; } throw new ConfigError(`${capitalize(releaseLabel)} asset redirected too many times`); }
  return {
    async release(tagName) { assert(tagPattern.test(tagName),`Use an immutable ${releaseLabel} tag such as ${exampleTag}`); const response=await reach(()=>fetch(releaseUrl(tagName),{headers:{accept:'application/vnd.github+json'}}),`${releaseLabel} ${tagName}`); assert(response.ok,`Could not fetch ${releaseLabel} ${tagName}`); const raw:unknown=await response.json(); assert(isRecord(raw)&&Array.isArray(raw.assets),`${capitalize(releaseLabel)} has no asset inventory`); const seen=new Set<string>(); return raw.assets.map(item=>{ assert(isRecord(item)&&typeof item.name==='string'&&typeof item.browser_download_url==='string'&&!seen.has(item.name),`Invalid or duplicate ${releaseLabel} asset`); seen.add(item.name); const url=new URL(item.browser_download_url); assert(url.protocol==='https:'&&url.hostname==='github.com'&&url.pathname.startsWith(`/${repository}/releases/download/`),`${capitalize(releaseLabel)} asset is not a GitHub download`); return {name:item.name,url:url.href}; }); },
    download,
    async attest(path,release,commit) { assert(tagPattern.test(release),`Invalid ${itemLabel} release tag`); assert(commit===undefined||COMMIT.test(commit),`Invalid ${itemLabel} commit pin`); const argv=['attestation','verify',path,'--repo',repository,'--signer-workflow',workflow,'--source-ref',`refs/tags/${release}`,'--deny-self-hosted-runners',...(commit?['--source-digest',commit]:[])]; await runAttestationVerify(argv,itemLabel,release,workflow,commit); },
  };
}

const MAX_ATTESTATION_BUNDLE=8*1024*1024;
interface LocalGithubTransportConfig extends GithubTransportConfig { directory:string; }
/**
 * The offline counterpart to `createGithubTransport`: reads a release's catalog and asset tarballs from a local
 * directory shaped like a GitHub release (flat files, no subdirectories) instead of fetching them, and verifies
 * each one with the identical `gh attestation verify` policy (repo, signer workflow, source ref, no self-hosted
 * runners) -- pointed with `--bundle` at an attestation bundle already on disk instead of letting `gh` reach the
 * GitHub API. That bundle must be produced by `gh attestation download <asset-file> --repo <repo> -o <directory>`,
 * which names it `sha256-<digest>.jsonl`; this transport looks it up by that same convention, so nothing here
 * invents or weakens the check -- a missing bundle fails closed with the exact `gh` command that produces it.
 */
export function createLocalGithubTransport(config:LocalGithubTransportConfig):GithubTransport {
  const {repository,workflow,tagPattern,exampleTag,maxAssetSize,itemLabel,directory}=config, releaseLabel=`${itemLabel} release`;
  const root=resolve(directory);
  return {
    async release(tagName) {
      assert(tagPattern.test(tagName),`Use an immutable ${releaseLabel} tag such as ${exampleTag}`);
      let entries;
      try { entries=await readdir(root,{withFileTypes:true}); }
      catch { throw new ConfigError(`Local ${releaseLabel} directory not found or unreadable: ${root}`); }
      assert(entries.every(item=>item.isFile()),`Local ${releaseLabel} directory ${root} must contain only ordinary files (asset tarballs, the catalog and their .jsonl attestation bundles), no subdirectories or links`);
      const seen=new Set<string>();
      const assets=entries.filter(item=>!item.name.endsWith('.jsonl')).map(item=>{ assert(!seen.has(item.name),`Duplicate local ${releaseLabel} asset ${item.name}`); seen.add(item.name); return {name:item.name,url:join(root,item.name)}; });
      assert(assets.length>0,`Local ${releaseLabel} directory ${root} has no release assets (expected the catalog and its tarballs, as produced for a GitHub release)`);
      return assets;
    },
    async download(value) {
      const target=resolve(value);
      assert(target===value&&(target===root||target.startsWith(root+sep)),`${capitalize(releaseLabel)} asset path left its local release directory`);
      let info; try { info=await lstat(target); } catch { throw new ConfigError(`Could not read local ${releaseLabel} asset ${target}`); }
      assert(info.isFile(),`${capitalize(releaseLabel)} asset must be an ordinary file: ${target}`);
      assert(info.size<=maxAssetSize,`${capitalize(releaseLabel)} asset exceeds the size limit`);
      return await readFile(target);
    },
    async attest(path,release,commit) {
      assert(tagPattern.test(release),`Invalid ${itemLabel} release tag`);
      assert(commit===undefined||COMMIT.test(commit),`Invalid ${itemLabel} commit pin`);
      const digestValue=digestHex(await readFile(path)), bundlePath=join(root,`sha256-${digestValue}.jsonl`);
      let bundleInfo; try { bundleInfo=await lstat(bundlePath); } catch { throw new ConfigError(`Local ${releaseLabel} directory ${root} is missing the offline attestation bundle for this asset; produce it with: gh attestation download <the asset file> --repo ${repository} -o ${root} (expected sha256-${digestValue}.jsonl)`); }
      assert(bundleInfo.isFile()&&bundleInfo.size>0&&bundleInfo.size<=MAX_ATTESTATION_BUNDLE,`Local ${releaseLabel} attestation bundle sha256-${digestValue}.jsonl is invalid`);
      const argv=['attestation','verify',path,'--repo',repository,'--signer-workflow',workflow,'--source-ref',`refs/tags/${release}`,'--deny-self-hosted-runners','--bundle',bundlePath,...(commit?['--source-digest',commit]:[])];
      await runAttestationVerify(argv,itemLabel,release,workflow,commit);
    },
  };
}

/**
 * Downloads one named release asset and has the transport attest it before returning its bytes. `expectedCommit`
 * binds the attestation's `--source-digest` to a known-good commit: a fixed string (e.g. the catalog's own,
 * already-verified `commit` field, for a bundle/artifact archive) or a function of the downloaded bytes (to peek
 * the catalog's own `commit` field ahead of its full parse, so the catalog's attestation is bound in the same
 * call that checks its signature -- see `peekCatalogCommit`). Omit it only where no commit binding applies.
 */
export async function verifiedReleaseAsset(assets:ReleaseAsset[], asset:string, release:string, transport:GithubTransport, itemLabel:string, tempPrefix:string, expectedCommit?:string|((bytes:Uint8Array)=>string)):Promise<Uint8Array> { const found=assets.filter(item=>item.name===asset); assert(found.length===1,`${capitalize(itemLabel)} release is missing or repeats ${asset}`); const bytes=await transport.download(found[0]!.url); const temporary=join(tmpdir(),`${tempPrefix}-${process.pid}-${Math.random().toString(16).slice(2)}`); await writeFile(temporary,bytes,{flag:'wx'}); try { const commit=typeof expectedCommit==='function'?expectedCommit(bytes):expectedCommit; await transport.attest(temporary,release,commit); return bytes; } finally { await rm(temporary,{force:true}); } }
