import Ajv from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assert, ConfigError, HttpError } from './errors.ts';
import { functionFile, loadDocument } from './config.ts';
import { prepareFunctionSnapshot } from './policy.ts';
import { validateHeaderName, validateHeaderValue } from './header-validation.ts';
import type { HandlerResult } from './http-response.ts';
import type { ProjectDocument, RouteConfig, TargetName } from './types.ts';
import type { AddonAgentTooling } from './addon-manifest.ts';
export type { HandlerResult } from './http-response.ts';
/**
 * The same conservative regex admission core uses for route and body
 * patterns (docs/RUNTIME-IMPLEMENTATION.md), exposed so a workspace package
 * that accepts author-supplied patterns admits them by the identical rule
 * instead of maintaining its own copy that can drift. `maxPatternInputLength`
 * is the input-length bound the guard's cost model assumes; callers must
 * enforce it themselves (for example as a JSON Schema `maxLength`) on any
 * value the pattern will run against.
 */
export { assertSafePattern, maxPatternInputLength } from './pattern-guard.ts';
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
/**
 * The reserved header namespace an `authorize()`/`middleware()` hook can write into
 * `ExtensionRequest.headers` to hand data forward into the route's own trusted
 * `function`/`middleware` context (docs/RUNTIME-IMPLEMENTATION.md `RIM-EXT-CONTEXT-001`,
 * urlcode#618). The runtime always strips this namespace from *inbound* request
 * headers before an extension, a route's guest code, or a proxied upstream ever sees
 * them (`stripReservedContextHeaders`), so a client can never inject or spoof a value
 * here — only trusted, operator-installed extension code writes into it. This is
 * generic core infrastructure: core never reads or interprets a value written here,
 * and the namespace carries no auth-specific meaning.
 *
 * This is not a credential channel. `credentialHeaders` (`cookie`, `authorization`,
 * and any extension-declared name) are stripped from the guest-facing projection
 * built from these headers exactly as they always were — writing a raw session token
 * or bearer credential into this namespace does not exempt it from that rule, and an
 * extension must not do so; write a derived, non-secret value (for example a
 * principal id, name and scopes) instead. See "Session and bearer credentials never
 * cross into application guests" below and SECURITY.md.
 */
export const extensionContextHeaderPrefix='x-urlcode-context-';
/** Whether `name` falls in the reserved `extensionContextHeaderPrefix` namespace, case-insensitively. */
export function isReservedContextHeader(name:string):boolean {return name.toLowerCase().startsWith(extensionContextHeaderPrefix);}
/** Deletes every header in the reserved `extensionContextHeaderPrefix` namespace from `headers` in place, and returns it. Applied to every inbound request before any extension or guest code can observe its headers, so a client can never inject or spoof a value there. */
export function stripReservedContextHeaders(headers:Headers):Headers {for(const [name] of [...headers.entries()])if(isReservedContextHeader(name))headers.delete(name);return headers;}
export interface ExtensionRequest {
  method:string; target:string; path:string; query:URLSearchParams;
  /**
   * A per-request clone (mutating it never affects the original inbound request).
   * The reserved `extensionContextHeaderPrefix` namespace has already been stripped
   * of any client-supplied value by the time an extension's `authorize()`/`middleware()`
   * receives it; writing into that namespace here (for example
   * `request.headers.set('x-urlcode-context-auth-principal', JSON.stringify(principal))`)
   * carries the value forward into the route's own guest-facing headers/context — but
   * never into a proxied upstream request, which `validateProxy` refuses to name a
   * reserved-namespace header in — see `extensionContextHeaderPrefix`.
   */
  headers:Headers;
  headerCounts:Record<string,number>; body:Uint8Array; origin:string; route:string;
  mount:string|null; client:string|null;
  /** The id this request is answered with in the `X-Request-Id` response header and the request log. */
  requestId:string;
  /**
   * The matched route's compiled `env` bindings: the same values a function route's `context.env`
   * receives, resolved from the route's `env:` block under the operator's revision-pinned
   * `permissions.routes[pattern].env` grant. Empty when the route declares none. Route `secrets`
   * are never included. An injection convenience for trusted extension code, not a restriction on it.
   */
  env:Readonly<Record<string,string>>;
}
/**
 * The generic second argument every extension hook loaded by `loadExtensionHooks` receives. Packages
 * extend it with their own fields (the mcp extension adds `server`, `tool` and `kind`).
 * `requestId` is `null` and `env` empty when the hook does not run on behalf of a request.
 */
export interface ExtensionHookContext { requestId:string|null; env:Readonly<Record<string,string>> }
/** The generic hook context for `request`, or the request-less context when there is none. */
export function extensionHookContext(request?:Pick<ExtensionRequest,'requestId'|'env'>):ExtensionHookContext {
  return request?{requestId:request.requestId,env:request.env}:{requestId:null,env:{}};
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
export interface ExtensionHookReference { source:string; export?:string; sandbox?:boolean; sandboxReason?:string }
export type ExtensionHookConfig=string|ExtensionHookReference;
export type ExtensionHookKind='filter'|'action';
/** Machine-readable contract for one project hook an extension exposes. */
export interface ExtensionHookContract {
  name:string;
  kind:ExtensionHookKind;
  description:string;
  inputSchema:object;
  outputSchema?:object;
}
export type ExtensionAuthoringKind='configuration'|'theme'|'copy'|'component'|'template'|'stylesheet'|'hook'|'extension';
/** One project-owned customization surface, shown to people and authoring agents by CLI/MCP inspection. */
export interface ExtensionAuthoringSurface {
  kind:ExtensionAuthoringKind;
  name:string;
  description:string;
  /** Project-relative convention or configuration path, when the surface has one. */
  path?:string;
  /** A bounded local command that discovers, previews or checks the surface. */
  command?:string;
}
/**
 * Machine-readable guidance for changing an installed extension without
 * copying its behavior into the application. This is descriptive only: it
 * grants nothing and is never executed by the runtime.
 */
export interface ExtensionAuthoringContract {
  description:string;
  surfaces:readonly ExtensionAuthoringSurface[];
  fastChecks?:readonly string[];
}
export type LoadedExtensionHooks<T extends string=string,C extends ExtensionHookContext=ExtensionHookContext>=Partial<Record<T,(input:unknown,context:C)=>unknown>>;
/** Shared schema for project hook references. Omission means trusted execution. */
export const extensionHookReferenceSchema={
  oneOf:[
    {type:'string',minLength:1,maxLength:1024},
    {type:'object',additionalProperties:false,required:['source'],properties:{
      source:{type:'string',minLength:1,maxLength:1024},
      export:{type:'string',pattern:'^[A-Za-z_][A-Za-z0-9_]*$'},
      sandbox:{type:'boolean'},
      sandboxReason:{type:'string',minLength:1,maxLength:512},
    }},
  ],
} as const;
/** Builds the strict `config.hooks` schema from an extension's declared hook names. */
export function extensionHooksSchema(contracts:readonly ExtensionHookContract[]):object {
  return {type:'object',additionalProperties:false,properties:Object.fromEntries(contracts.map(contract=>[contract.name,extensionHookReferenceSchema]))};
}
/**
 * Loads project hooks once per activation. Project hooks are trusted first-party
 * code by default, matching function/middleware routes. Sandboxed arbitrary-value
 * hooks are not part of contract v1 and are refused rather than run trusted.
 * Every loaded hook is called as `hook(input, context)`: `input` is validated
 * against the contract, `context` is an `ExtensionHookContext` (or a package's
 * extension of it) the caller supplies and the hook receives as a frozen copy.
 */
export async function loadExtensionHooks<T extends string,C extends ExtensionHookContext=ExtensionHookContext>(config:Readonly<Record<string,unknown>>|undefined,contracts:readonly ExtensionHookContract[],context:Pick<ExtensionActivation,'root'>):Promise<LoadedExtensionHooks<T,C>> {
  const known=new Map(contracts.map(contract=>[contract.name,contract]));
  const hooks:Record<string,(input:unknown,context:C)=>unknown>=Object.create(null) as Record<string,(input:unknown,context:C)=>unknown>;
  if(config===undefined)return hooks as LoadedExtensionHooks<T,C>;
  assert(config&&typeof config==='object'&&!Array.isArray(config),'Extension hooks must be an object');
  const epoch=randomUUID();
  for(const [name,raw] of Object.entries(config)){
    const contract=known.get(name);assert(contract,`Unknown extension hook: ${name}`);
    assert(typeof raw==='string'||raw&&typeof raw==='object'&&!Array.isArray(raw),`Invalid extension hook: ${name}`);
    const reference:ExtensionHookReference=typeof raw==='string'?{source:raw}:raw as ExtensionHookReference;
    if(reference.sandbox===true)throw new Error(`hook ${name}: sandbox: true is not supported for extension hooks; hooks run trusted by default`);
    const exportName=reference.export??'default';
    let modulePath:string;
    try{modulePath=await functionFile(context.root,reference.source);}
    catch(error){throw new Error(`hook ${name}: failed to load module "${reference.source}"`,{cause:error});}
    let module:Record<string,unknown>;
    try{module=await import(pathToFileURL(modulePath).href+'?urlcode-extension-hook-epoch='+epoch) as Record<string,unknown>;}
    catch(error){throw new Error(`hook ${name}: failed to load module "${reference.source}"`,{cause:error});}
    const fn=module[exportName];
    if(typeof fn!=='function')throw new Error(`hook ${name}: export "${exportName}" in "${reference.source}" is not a function`);
    const ajv=new Ajv.default({strict:false,allErrors:false});
    const validateInput=ajv.compile(contract.inputSchema);
    const validateOutput=contract.outputSchema?ajv.compile(contract.outputSchema):undefined;
    hooks[name]=(input:unknown,hookContext:C):unknown=>{
      assert(validateInput(input),`Invalid extension hook input: ${name}`);
      assert(hookContext&&typeof hookContext==='object'&&(hookContext.requestId===null||typeof hookContext.requestId==='string')&&hookContext.env&&typeof hookContext.env==='object',`Invalid extension hook context: ${name}`);
      const validate=(output:unknown):unknown=>{if(validateOutput)assert(validateOutput(output),`Invalid extension hook output: ${name}`);return output;};
      // A fresh frozen copy per call: a hook cannot mutate what the next call, or its caller, sees.
      const frozen=Object.freeze({...hookContext,env:Object.freeze({...hookContext.env})});
      const output=(fn as (value:unknown,context:C)=>unknown)(input,frozen);
      return output instanceof Promise?output.then(validate):validate(output);
    };
  }
  return hooks as LoadedExtensionHooks<T,C>;
}
export interface RuntimeExtension {
  name:string; version:'1'; projectSha256:string; targets:TargetName[];
  schema:object; policySchema?:object; credentialHeaders?:string[]; immutableAssets?:ExtensionImmutableAssets;
  /** Project customization points, exposed by CLI/MCP for authors and agents. */
  hooks?:readonly ExtensionHookContract[];
  /** Supported project-owned customization surfaces, exposed by CLI/MCP. */
  authoring?:ExtensionAuthoringContract;
  /** Add-on-owned, inert local references for agents; never executable. */
  agent?:AddonAgentTooling;
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
/**
 * What core hands an extension definition's `scaffold` when `urlcode extensions add <name>` (or `init --with`)
 * adds it to a site. `scaffold` writes nothing: it returns the configuration, routes and operator files core
 * writes for it.
 */
export interface ScaffoldRequest {
  /** Absolute site directory (holds package.json and host.mjs); `files` paths in the result are relative to it. */
  site:string;
  /** Absolute route project directory, `<site>/app`, holding urlcode.yaml. */
  project:string;
  /** Every extension installed in the site after this add, including this one, sorted. */
  installed:readonly string[];
  /**
   * Operator acknowledgements from repeated `--ack <extension>:<id>` flags, sorted and de-duplicated; empty when none. Core treats
   * them as opaque strings and never invents one. An extension reads only the ones qualified with its own name. To require one, throw
   * an Error carrying `acknowledgement: '<name>:<id>'` whose message states the risk; core appends the exact re-run command with
   * `--ack <name>:<id>`. List each one the scaffold used in `ScaffoldResult.acknowledged`.
   */
  acknowledgements:readonly string[];
}
export interface ScaffoldFile { path:string; content:string|Uint8Array; mode?:number }
export interface ScaffoldResult {
  /** The `config` of this extension's `extensions.<name>` block in urlcode.yaml. */
  config:Record<string,unknown>;
  /** Routes written to `app/routes/<name>.yaml`; empty writes no file. Duplicate keys are refused. */
  routes:Record<string,unknown>;
  /** Operator files written relative to the site, never inside `app/`. An existing file is kept, never overwritten. */
  files?:ScaffoldFile[];
  /** Environment variables the host reads, with one-line descriptions. */
  env?:Record<string,string>;
  /** The `<name>:<id>` acknowledgements this scaffold consumed. Core refuses any passed `--ack` that no scaffold lists here. */
  acknowledged?:string[];
  /** One-line comments written above this extension's routes (for example the selected access model). */
  routeNotes?:string[];
  /** One-line next steps printed after the add. */
  notes?:string[];
}
/**
 * What `composeHost` gives an extension's `host()`. `get(name)` returns what an extension this one `requires`
 * exported from its own `host()`; `contributions(name)` collects every installed extension's
 * `contributes[name]` value, so an extension activated first (ui) still receives what later ones add to it.
 */
export interface HostContext {
  projectSha256:string;
  /** Absolute site directory: the directory of host.mjs. */
  site:string;
  get<T=unknown>(name:string):T;
  contributions<T=unknown>(name:string):T[];
}
export interface HostedExtension {
  registration:RuntimeExtension;
  /** Shared with extensions that require this one, through `HostContext.get`. */
  exports?:unknown;
  /** Releases what `host()` opened; called in reverse activation order. */
  close?():void|Promise<void>;
}
/**
 * One extension, declared once. The static fields (`name` to `authoring`) are what the build writes into the
 * package's `urlcode.json`, which core and tooling read without running any extension code; `scaffold` adds the
 * extension to a site and `host` builds its runtime registration from the operator's `host.mjs`.
 */
export interface ExtensionDefinition<Options=Record<string,never>> {
  name:string;
  description:string;
  requires?:readonly string[];
  schema:object;
  policySchema?:object;
  hooks?:readonly ExtensionHookContract[];
  authoring?:ExtensionAuthoringContract;
  /** Add-on-owned, inert local references for agents; emitted into urlcode.json. */
  agent?:AddonAgentTooling;
  /** Static values handed to another installed extension, keyed by its name (for example templates for `ui`). */
  contributes?:Readonly<Record<string,unknown>>;
  scaffold?(request:ScaffoldRequest):ScaffoldResult|Promise<ScaffoldResult>;
  host(context:HostContext,options:Options):HostedExtension|Promise<HostedExtension>;
}
export interface ExtensionEntry { readonly definition:ExtensionDefinition<unknown>; readonly options:unknown }
export type DefinedExtension<Options>=((options?:Options)=>ExtensionEntry)&{ readonly definition:ExtensionDefinition<Options> };
/** The default export of every extension package's `./extension` entry. Calling it in host.mjs selects operator options. */
export function defineExtension<Options=Record<string,never>>(definition:ExtensionDefinition<Options>):DefinedExtension<Options> {
  assert(definition&&typeof definition==='object'&&typeof definition.name==='string'&&namePattern.test(definition.name),'Extension definition needs a lowercase name');
  assert(typeof definition.description==='string'&&definition.description.length>0&&definition.description.length<=300,`Extension ${definition.name} needs a one-line description`);
  assert(definition.schema&&typeof definition.schema==='object'&&typeof definition.host==='function',`Extension ${definition.name} needs a schema and a host function`);
  assert((definition.requires??[]).every(name=>namePattern.test(name)&&name!==definition.name),`Extension ${definition.name} requires must list other extension names`);
  const entry=(options?:Options):ExtensionEntry=>Object.freeze({definition:definition as ExtensionDefinition<unknown>,options:options??{}});
  return Object.assign(entry,{definition}) as DefinedExtension<Options>;
}
export interface ActiveExtension { instance:ExtensionInstance; policies:Map<string,Readonly<Record<string,unknown>>>; assetPrefixes:readonly string[] }
/** What the runtime knows about the request when it applies the privacy floor. */
export interface ExtensionAssetContext { method:string; path:string; prefixes:readonly string[] }
export interface ExtensionRegistry { entries:Map<string,ActiveExtension>; credentialHeaders:string[]; close():Promise<void> }
const namePattern=/^[a-z][a-z0-9-]{0,63}$/;
const hookNamePattern=/^[a-z][A-Za-z0-9]{0,63}$/;
const authoringNamePattern=/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,127}$/;
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
    const hookNames=new Set<string>();
    for(const hook of registration.hooks??[]){
      assert(hook&&typeof hook==='object'&&hookNamePattern.test(hook.name)&&!hookNames.has(hook.name),'Invalid extension hook contract');
      assert(['filter','action'].includes(hook.kind)&&typeof hook.description==='string'&&hook.description.length>=1&&hook.description.length<=512,'Invalid extension hook contract');
      assert(hook.inputSchema&&typeof hook.inputSchema==='object'&&(!hook.outputSchema||typeof hook.outputSchema==='object'),'Invalid extension hook contract');
      hookNames.add(hook.name);
    }
    if(registration.authoring!==undefined){
      const authoring=registration.authoring;
      assert(authoring&&typeof authoring==='object'&&typeof authoring.description==='string'&&authoring.description.length>=1&&authoring.description.length<=1024,'Invalid extension authoring contract');
      assert(Array.isArray(authoring.surfaces)&&authoring.surfaces.length<=64,'Invalid extension authoring surfaces');
      const surfaceNames=new Set<string>();
      for(const surface of authoring.surfaces){
        assert(surface&&typeof surface==='object'&&['configuration','theme','copy','component','template','stylesheet','hook','extension'].includes(surface.kind),'Invalid extension authoring surface kind');
        assert(typeof surface.name==='string'&&authoringNamePattern.test(surface.name)&&!surfaceNames.has(surface.name),'Invalid extension authoring surface name');
        assert(typeof surface.description==='string'&&surface.description.length>=1&&surface.description.length<=1024,'Invalid extension authoring surface description');
        assert(surface.path===undefined||typeof surface.path==='string'&&surface.path.length>=1&&surface.path.length<=1024,'Invalid extension authoring surface path');
        assert(surface.command===undefined||typeof surface.command==='string'&&surface.command.length>=1&&surface.command.length<=2048,'Invalid extension authoring surface command');
        surfaceNames.add(surface.name);
      }
      assert(authoring.fastChecks===undefined||Array.isArray(authoring.fastChecks)&&authoring.fastChecks.length<=32&&authoring.fastChecks.every(check=>typeof check==='string'&&check.length>=1&&check.length<=2048),'Invalid extension authoring fast checks');
    }
    provided.set(registration.name,registration);
  }
  const declarations=document.extensions??{};
  if(Object.keys(declarations).length){let origin:URL;try{origin=new URL(context.origin);}catch{throw new ConfigError('Extensions require an explicit operator origin; pass --origin https://your.site (the public origin the site is served from)');}assert(['http:','https:'].includes(origin.protocol)&&!origin.username&&!origin.password&&origin.origin===context.origin,'Extensions require an explicit canonical HTTP(S) operator origin');}
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
