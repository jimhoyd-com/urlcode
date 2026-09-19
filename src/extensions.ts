import Ajv from 'ajv/dist/2020.js';
import { assert, HttpError } from './errors.ts';
import { loadDocument } from './config.ts';
import { prepareFunctionSnapshot } from './policy.ts';
import { validateHeaderName, validateHeaderValue } from './header-validation.ts';
import type { HandlerResult } from './http-response.ts';
import type { ProjectDocument, RouteConfig, TargetName } from './types.ts';
export type { HandlerResult } from './http-response.ts';
export interface ExtensionDeclaration { version:'1'; config:Record<string,unknown> }
export type ExtensionPolicies = Record<string,Record<string,unknown>|false>;
/**
 * `root` is the project's resolved absolute directory (the same value
 * `loadDocument()` computes and `functionFile()`/router.ts resolves
 * `function`/`middleware` `source` entries against). It is not the process's
 * `cwd()`: `--project`/`--host-file` are independent paths, a server can be
 * started from any working directory, and the JS API can load a project
 * programmatically with no relationship to `cwd()` at all. An extension that
 * resolves project-relative paths of its own (for example, an alternative
 * middleware source it loads by convention rather than through core's native
 * `middleware:` array) must resolve them against this field, never `cwd()`.
 */
export interface ExtensionActivation { origin:string; target:TargetName; projectSha256:string; mounts:readonly string[]; root:string }
export interface ExtensionRequest {
  method:string; target:string; path:string; query:URLSearchParams; headers:Headers;
  headerCounts:Record<string,number>; body:Uint8Array; origin:string; route:string;
  mount:string|null; client:string|null;
}
export interface ExtensionInstance {
  handle(request:ExtensionRequest):HandlerResult|Promise<HandlerResult>;
  authorize?(requirement:Readonly<Record<string,unknown>>,request:ExtensionRequest):HandlerResult|undefined|Promise<HandlerResult|undefined>;
  /**
   * Wrap semantics, not gate semantics: attached the same way as `authorize`
   * (policies.extensions.<name> on a route, `config` the same validated
   * per-route value `authorize`'s `requirement` receives), but given `next`,
   * a callable invoking the rest of the pipeline for this route (any other
   * declared extension `middleware()` after this one, then the route's own
   * native `middleware:` chain and handler) at most once. Calling it lets
   * this hook run code before and after the rest of the pipeline, inspecting
   * or mutating the `HandlerResult` it resolves to; skipping it short-circuits
   * the rest of the pipeline entirely, the same way `authorize` can. Never
   * touches the native `middleware:` array or its own sandboxed/trusted
   * dispatch, and never runs before `authorize` on the same route.
   */
  middleware?(config:Readonly<Record<string,unknown>>,request:ExtensionRequest,next:()=>Promise<HandlerResult>):HandlerResult|Promise<HandlerResult>;
  close?():void|Promise<void>;
}
/** Trusted operator code only. YAML declares names/configuration, never modules. */
/**
 * Content-hashed assets under `<mount><prefix>/` may be cached publicly. The
 * extension owns the hashed filename; the runtime only relaxes its no-store floor
 * for a GET/HEAD 200/304 that carries a strong ETag, sets no cookie and does not
 * vary on credentials. Everything else under the mount stays no-store.
 */
export interface ExtensionImmutableAssets { prefix:string }
export interface RuntimeExtension {
  name:string; version:'1'; projectSha256:string; targets:TargetName[];
  schema:object; policySchema?:object; credentialHeaders?:string[]; immutableAssets?:ExtensionImmutableAssets;
  /**
   * Reviewed, operator-declared cache sensitivity for `policies.extensions.<name>`
   * routes (never for an `extension:` mount, which is always treated as
   * sensitive). Omitted or `true`: the current, safe default — the runtime
   * forces `Cache-Control: no-store`, disables compression and applies the
   * extension response's header/size caps, exactly like `authorize`-gating
   * auth/admin extensions. `false` is an explicit, reviewed opt-in a generic,
   * cache-transparent extension (pure request/response middleware with no
   * gating semantics of its own) makes to say its
   * `middleware()` hook never depends on withholding the response from
   * shared caches: the wrapped route's own declared cache headers pass
   * through unchanged, exactly as the native `middleware:` array already
   * does. A route naming more than one extension is treated as sensitive if
   * any of them is (or leaves this unset) — this can only relax the no-store
   * floor, never weaken it, and it never changes whether `authorize()` runs.
   */
  cacheSensitive?:boolean;
  activate(config:Readonly<Record<string,unknown>>,context:ExtensionActivation):ExtensionInstance|Promise<ExtensionInstance>;
}
/** `urlcode init --with <name>` contract: what core hands `@jimhoyd/urlcode-<name>`'s `scaffold` export. Nothing is written by `scaffold`. */
export interface ScaffoldRequest {
  /** Absolute site directory core creates; `files` paths in the result are relative to it. */
  directory:string;
  /** Absolute route project directory (holds urlcode.yaml), `<directory>/app`. */
  project:string;
  /** Absolute path of the combined host module core writes, `<directory>/host.mjs`. */
  hostFile:string;
  /** Every extension name being scaffolded together, in `--with` order, including this one. */
  names:readonly string[];
}
export interface ScaffoldFile { path:string; content:string|Uint8Array; mode?:number }
export interface ScaffoldResult {
  /** Must equal the requested name. */
  name:string;
  /** Fragments merged into the project's top-level `extensions` and `routes`; duplicate keys are refused. */
  extensions:Record<string,unknown>; routes:Record<string,unknown>;
  /** Host module lines: imports, then setup statements, then entries of the `extensions` array, then `close` statements. */
  hostImports:string[]; hostSetup:string[]; hostEntries:string[]; hostClose?:string[];
  /** Files written relative to `directory` with their modes; never inside the project, never overwriting. */
  files:ScaffoldFile[];
  /** Markdown appended to README.md under a heading core adds; the numbered steps merged in `--with` order. */
  readme:string; nextSteps:string[];
  /** Environment variables the host reads, with one-line descriptions. */
  env?:Record<string,string>;
}
export interface ActiveExtension { instance:ExtensionInstance; policies:Map<string,Readonly<Record<string,unknown>>>; assetPrefixes:readonly string[] }
/** What the runtime knows about the request when it applies the privacy floor. */
export interface ExtensionAssetContext { method:string; path:string; prefixes:readonly string[] }
export interface ExtensionRegistry { entries:Map<string,ActiveExtension>; credentialHeaders:string[]; close():Promise<void> }
const namePattern=/^[a-z][a-z0-9-]{0,63}$/;
const cacheHeaders=new Set(['cache-control','cdn-cache-control','vercel-cdn-cache-control','surrogate-control']);
const segmentPattern=/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
export const immutableCacheControl='public, max-age=31536000, immutable';
/** A normalized absolute path prefix: literal segments only, no dot segments, no trailing slash. */
function validateAssetPrefix(prefix:unknown,name:string):string {
  assert(typeof prefix==='string'&&prefix.length>=2&&prefix.length<=256&&prefix.startsWith('/')&&!prefix.endsWith('/'),`Extension ${name} immutableAssets.prefix must be a normalized absolute path`);
  assert(prefix.slice(1).split('/').every(segment=>segmentPattern.test(segment)&&segment!=='.'&&segment!=='..'),`Extension ${name} immutableAssets.prefix must contain literal path segments only`);
  return prefix;
}
function frozen<T>(value:T):T {if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
/** Inspection alone grants nothing; operators must explicitly pin the returned revision. */
export async function inspectExtensionRevision(project:string):Promise<string> {return (await prepareFunctionSnapshot(await loadDocument(project))).projectSha256;}
export function effectiveExtensionPolicies(document:ProjectDocument,route:Pick<RouteConfig,'policies'>):Record<string,Record<string,unknown>> {
  const project=document.policies??{},local=route.policies??{};
  const layers=[project.profile?document.profiles?.[project.profile]:undefined,project,local.profile?document.profiles?.[local.profile]:undefined,local];
  const result:Record<string,Record<string,unknown>>=Object.create(null) as Record<string,Record<string,unknown>>;
  for(const layer of layers){if(layer?.extensions===false){for(const key of Object.keys(result))delete result[key];continue;}
    for(const [name,value]of Object.entries(layer?.extensions??{})) {if(value===false)delete result[name];else result[name]={...result[name],...value};}
  }
  return result;
}
export function hasExtensionPolicy(document:ProjectDocument,route:Pick<RouteConfig,'policies'>):boolean {return Object.keys(effectiveExtensionPolicies(document,route)).length>0;}
/**
 * Whether a route naming these `policies.extensions` names must be treated as
 * confidential (forced no-store, no compression, extension response caps).
 * `names` with no entries is never confidential. Without a `registrations`
 * list to consult (a build path with no operator host loaded), every name is
 * treated as sensitive: the safe default this can only relax, never weaken.
 * A name whose registration is missing, or declares no `cacheSensitive` (or
 * `true`), counts as sensitive; only an explicit `cacheSensitive: false`
 * excuses it, and one sensitive name among several makes the whole route
 * confidential.
 */
export function isSensitiveExtensionPolicy(names:readonly string[],registrations?:readonly Pick<RuntimeExtension,'name'|'cacheSensitive'>[]):boolean {
  if(!names.length)return false;
  if(!registrations)return true;
  const byName=new Map(registrations.map(registration=>[registration.name,registration.cacheSensitive]));
  return names.some(name=>byName.get(name)!==false);
}
export function prepareExtensions(document:ProjectDocument,routes:Record<string,RouteConfig>,registrations:RuntimeExtension[]|undefined,context:Omit<ExtensionActivation,'mounts'>): {activate():Promise<ExtensionRegistry>} {
  assert(registrations===undefined||Array.isArray(registrations)&&registrations.length<=16,'Extensions must be an array of at most 16 operator registrations');
  const provided=new Map<string,RuntimeExtension>(),entries=new Map<string,ActiveExtension>(),credentialHeaders=new Set<string>();
  for(const registration of registrations??[]){
    assert(registration&&typeof registration==='object'&&typeof registration.name==='string'&&namePattern.test(registration.name),'Invalid extension registration');
    assert(!provided.has(registration.name),'Duplicate extension provider');
    assert(registration.version==='1'&&typeof registration.activate==='function','Invalid extension version or activation hook');
    assert(Array.isArray(registration.targets)&&registration.targets.every(target=>['node','aws','vercel'].includes(target)),'Extension targets must be node, aws or vercel');
    assert(typeof registration.projectSha256==='string'&&/^[a-f0-9]{64}$/.test(registration.projectSha256),'Extension requires an explicit operator revision pin');
    provided.set(registration.name,registration);
  }
  const declarations=document.extensions??{};
  if(Object.keys(declarations).length){let origin:URL;try{origin=new URL(context.origin);}catch{throw new Error('Extensions require an explicit operator origin');}assert(['http:','https:'].includes(origin.protocol)&&!origin.username&&!origin.password&&origin.origin===context.origin,'Extensions require an explicit canonical HTTP(S) operator origin');}
  for(const route of Object.values(routes)){
    if(route.extension)assert(Object.hasOwn(declarations,route.extension),'Extension route has no declaration');
    for(const name of Object.keys(effectiveExtensionPolicies(document,route)))assert(Object.hasOwn(declarations,name),'Extension policy has no declaration');
  }
  const preparations:{name:string;registration:RuntimeExtension;config:Readonly<Record<string,unknown>>;policies:Map<string,Readonly<Record<string,unknown>>>;mounts:string[];assetPrefixes:string[]}[]=[];
  for(const [name,declaration]of Object.entries(declarations)){
      const registration=provided.get(name);assert(registration,`Missing operator extension: ${name}`);
      assert(registration.projectSha256===context.projectSha256,`Extension revision pin mismatch: ${name}`);
      assert(registration.targets.includes(context.target),`Extension ${name} refuses target ${context.target}`);
      assert(declaration.version===registration.version,`Extension contract version mismatch: ${name}`);
      const config=structuredClone(declaration.config);
      const ajv=new Ajv.default({strict:true,allErrors:false});
      assert(ajv.compile(registration.schema)(config),`Invalid extension configuration: ${name}`);
      const policyValidator=registration.policySchema?ajv.compile(registration.policySchema):undefined;
      const policies=new Map<string,Readonly<Record<string,unknown>>>();
      for(const [path,route]of Object.entries(routes)){const policy=effectiveExtensionPolicies(document,route)[name];if(policy){assert(policyValidator&&policyValidator(policy),`Invalid extension policy: ${name} at ${path}`);policies.set(path,frozen(structuredClone(policy)));}}
      const declaredHeaders=registration.credentialHeaders??[];
      assert(Array.isArray(declaredHeaders)&&declaredHeaders.length<=64,'Invalid extension credential headers');
      for(const header of declaredHeaders){assert(typeof header==='string'&&header.length<=128,'Invalid extension credential header');validateHeaderName(header);credentialHeaders.add(header.toLowerCase());}
      // Session and bearer credentials never cross into application guests.
      credentialHeaders.add('cookie');credentialHeaders.add('authorization');
      const mounts=Object.entries(routes).filter(([,route])=>route.extension===name).map(([path])=>path.endsWith('/*')?path.slice(0,-2):path);
      const assetPrefixes=registration.immutableAssets===undefined?[]:mounts.map(mount=>mount+validateAssetPrefix((registration.immutableAssets as ExtensionImmutableAssets).prefix,name)+'/');
      preparations.push({name,registration,config:frozen(config),policies,mounts,assetPrefixes});
  }
  return {async activate(){
    try{for(const {name,registration,config,policies,mounts,assetPrefixes}of preparations){
      const instance=await registration.activate(config,frozen({...context,mounts}));
      if(instance&&typeof instance==='object')entries.set(name,{instance,policies,assetPrefixes});
      assert(instance&&typeof instance.handle==='function'&&(!policies.size||typeof instance.authorize==='function'||typeof instance.middleware==='function'),`Extension ${name} lacks a required handler, authorization hook or middleware hook`);
      entries.set(name,{instance,policies,assetPrefixes});
    }}catch(error){for(const entry of [...entries.values()].reverse())try{await entry.instance.close?.();}catch{/* Keep the activation failure. */}throw error;}
    return {entries,credentialHeaders:[...credentialHeaders],async close(){for(const entry of [...entries.values()].reverse())try{await entry.instance.close?.();}catch{/* Operators own extension lifecycle diagnostics. */}}};
  }};
}
const header=(headers:readonly (readonly [string,string])[],name:string):string[]=>headers.filter(([key])=>key.toLowerCase()===name).map(([,value])=>value);
const maxAge=(value:string):number|undefined=>{const match=/(?:^|[\s,])max-age\s*=\s*"?(\d+)/i.exec(value);return match?Number(match[1]):undefined;};
/**
 * The runtime decides; the extension cannot opt in from a response alone. The
 * declared prefix, the GET/HEAD method, a 200/304 status, one strong ETag, no
 * Set-Cookie and no Vary on Cookie/Authorization are all required. A stricter
 * Cache-Control the extension set (no-store, no-cache, private or a shorter
 * max-age) is preserved.
 */
export function immutableAssetResponse(result:HandlerResult,asset:ExtensionAssetContext|undefined):boolean {
  if(!asset||!asset.prefixes.some(prefix=>asset.path.startsWith(prefix)))return false;
  if(asset.method!=='GET'&&asset.method!=='HEAD')return false;
  if(result.status!==200&&result.status!==304)return false;
  const etag=header(result.headers,'etag');
  if(etag.length!==1||!/^"[!#-~]+"$/.test(etag[0]!))return false;
  if(header(result.headers,'set-cookie').length)return false;
  if(header(result.headers,'vary').some(value=>value.split(',').some(field=>['cookie','authorization','*'].includes(field.trim().toLowerCase()))))return false;
  return true;
}
function assetCacheControl(result:HandlerResult):string {
  const declared=header(result.headers,'cache-control');
  if(declared.length!==1)return immutableCacheControl;
  const value=declared[0]!,lower=value.toLowerCase();
  if(/(?:^|[\s,])(?:no-store|no-cache|private)(?:$|[\s,=])/.test(lower))return value;
  const age=maxAge(value);
  return age!==undefined&&age<31536000?value:immutableCacheControl;
}
/** Mandatory privacy floor after trusted response hooks, with bounded output. */
export function extensionResponse(result:HandlerResult,asset?:ExtensionAssetContext):HandlerResult {
  assert(result&&Number.isInteger(result.status)&&result.status>=200&&result.status<=599&&Array.isArray(result.headers),'Invalid extension response');
  if(result.body&&Buffer.byteLength(result.body)>1048576)throw new HttpError(502,'Extension response exceeds limit');
  let bytes=0;assert(result.headers.length<=256,'Extension response has too many headers');
  for(const [name,value]of result.headers){validateHeaderName(name);validateHeaderValue(name,value);bytes+=Buffer.byteLength(name)+Buffer.byteLength(value)+4;}
  if(bytes>16384)throw new HttpError(502,'Extension response headers exceed limit');
  const cacheControl=immutableAssetResponse(result,asset)?assetCacheControl(result):'no-store';
  return {...result,headers:[...result.headers.filter(([name])=>!cacheHeaders.has(name.toLowerCase())),['cache-control',cacheControl]]};
}
