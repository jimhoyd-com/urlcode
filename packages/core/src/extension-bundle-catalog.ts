import { ConfigError, assert } from './errors.ts';
import { type UnknownRecord as RecordValue, isRecord as record, textField, exactKeys as sharedExactKeys } from './extension-transport.ts';
import type { TarFile } from './extension-artifacts.ts';

export const bundleTagPattern=/^extension-bundles@v[0-9][0-9A-Za-z._-]{0,100}$/;
export const bundleNamePattern=/^[a-z][a-z0-9-]{0,63}$/;
export const bundleVersionPattern=/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
export const bundleDigestPattern=/^[a-f0-9]{64}$/;
const entry=/^node_modules\/@jimhoyd\/urlcode-[a-z][a-z0-9-]{0,63}\/dist\/[A-Za-z0-9._/-]+\.js$/;
const safeEntry=(value:string):boolean=>entry.test(value)&&value.split('/').every(segment=>segment!=='.'&&segment!=='..');
export const bundleText=(value:unknown,what:string):string=>textField(value,`${what} in extension bundle metadata`);
export const bundleExact=(value:RecordValue,keys:readonly string[],what:string):void=>sharedExactKeys(value,keys,what);

export const bundleArchiveLimits={archive:128*1024*1024,expanded:512*1024*1024,files:12000,file:32*1024*1024,label:'Extension bundle archive'};
export interface BundleEntry { name:string; version:string; asset:string; sha256:string; entry:string; }
export interface BundleCatalog { format:1; tag:string; commit:string; coreVersion:string; bundles:BundleEntry[]; revoked:{sha256:string;reason:string}[]; }
export interface LockedBundle extends BundleEntry { catalog:{tag:string;commit:string}; coreVersion:string; }
export interface BundleLock { format:1; bundles:LockedBundle[]; }
export interface BundleTransport { release(tag:string):Promise<{name:string;url:string}[]>; download(url:string):Promise<Uint8Array>; attest(path:string,release:string,commit?:string):Promise<void>; }

export function parseBundleEntry(value:unknown,what:string,strict=true):BundleEntry {
  assert(record(value),`Invalid ${what}`); if(strict)bundleExact(value,['name','version','asset','sha256','entry'],what);
  const item={name:bundleText(value.name,'bundle name'),version:bundleText(value.version,'bundle version'),asset:bundleText(value.asset,'bundle asset'),sha256:bundleText(value.sha256,'bundle SHA-256'),entry:bundleText(value.entry,'bundle entry')};
  assert(bundleNamePattern.test(item.name)&&bundleVersionPattern.test(item.version)&&/^[A-Za-z0-9._-]+\.tgz$/.test(item.asset)&&bundleDigestPattern.test(item.sha256)&&safeEntry(item.entry),`Invalid ${what}`);
  return item;
}
/** Parse only a catalog whose attestation was already verified against the requested immutable tag. */
export function parseBundleCatalog(bytes:Uint8Array,requested:string):BundleCatalog {
  let raw:unknown;try{raw=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new ConfigError('Extension bundle catalog is not valid JSON');}
  assert(record(raw)&&raw.format===1,'Unsupported extension bundle catalog format');bundleExact(raw,['format','tag','commit','coreVersion','bundles','revoked'],'Extension bundle catalog');
  const catalogTag=bundleText(raw.tag,'catalog tag'),commit=bundleText(raw.commit,'catalog commit'),coreVersion=bundleText(raw.coreVersion,'catalog core version');
  assert(bundleTagPattern.test(catalogTag)&&catalogTag===requested,'Extension bundle catalog tag does not match the immutable requested release');assert(/^[a-f0-9]{40}$/.test(commit)&&bundleVersionPattern.test(coreVersion),'Extension bundle catalog has an invalid pin');assert(Array.isArray(raw.bundles)&&Array.isArray(raw.revoked),'Extension bundle catalog is incomplete');
  const names=new Set<string>(),bundles=raw.bundles.map(value=>{const item=parseBundleEntry(value,'extension bundle catalog entry');assert(!names.has(item.name),`Extension bundle catalog names ${item.name} more than once`);names.add(item.name);return item;});
  const revoked:BundleCatalog['revoked']=[],digests=new Set<string>();for(const value of raw.revoked){assert(record(value),'Invalid extension bundle revocation');bundleExact(value,['sha256','reason'],'Extension bundle revocation');const sha256=bundleText(value.sha256,'revocation SHA-256'),reason=bundleText(value.reason,'revocation reason');assert(bundleDigestPattern.test(sha256)&&!digests.has(sha256),'Invalid or duplicate extension bundle revocation');digests.add(sha256);revoked.push({sha256,reason});}
  return {format:1,tag:catalogTag,commit,coreVersion,bundles,revoked};
}
interface BundleManifest { format:1; coreVersion:string; bundles:{name:string;version:string;entry:string}[]; }
function bundleManifest(files:TarFile[]):BundleManifest {
  const member=files.find(file=>file.path==='bundle.json');assert(member,'Extension bundle is missing bundle.json');let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(member.bytes));}catch{throw new ConfigError('Extension bundle bundle.json is not valid UTF-8 JSON');}
  assert(record(raw)&&raw.format===1,'Unsupported extension bundle manifest format');bundleExact(raw,['format','coreVersion','bundles'],'Extension bundle manifest');const coreVersion=bundleText(raw.coreVersion,'bundle core version');assert(bundleVersionPattern.test(coreVersion)&&Array.isArray(raw.bundles)&&raw.bundles.length>0,'Invalid extension bundle manifest');const seen=new Set<string>();const bundles=raw.bundles.map(value=>{assert(record(value),'Invalid extension bundle manifest entry');bundleExact(value,['name','version','entry'],'Extension bundle manifest entry');const item={name:bundleText(value.name,'bundle name'),version:bundleText(value.version,'bundle version'),entry:bundleText(value.entry,'bundle entry')};assert(bundleNamePattern.test(item.name)&&bundleVersionPattern.test(item.version)&&safeEntry(item.entry)&&!seen.has(item.name),'Invalid or duplicate extension bundle manifest entry');seen.add(item.name);return item;});return {format:1,coreVersion,bundles};
}
export function validateBundleFiles(files:TarFile[],item:Pick<BundleEntry,'name'|'version'|'entry'>,coreVersion:string):void {
  assert(files.length>1&&files.every(file=>file.path==='bundle.json'||file.path.startsWith('node_modules/')),'Extension bundle contains a file outside its frozen module tree');const manifest=bundleManifest(files);assert(manifest.coreVersion===coreVersion,'Extension bundle core version does not match its signed catalog');assert(manifest.bundles.some(value=>value.name===item.name&&value.version===item.version&&value.entry===item.entry),'Extension bundle manifest does not match its signed catalog entry');assert(files.some(file=>file.path===item.entry),'Extension bundle is missing its declared entry module');
}
