import Ajv from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { assert, boundedLine, ConfigError, extensionError, HttpError } from './errors.ts';
import { extensionConfigError, extensionPolicyError, functionFile, loadDocument } from './config.ts';
import { prepareFunctionSnapshot } from './policy.ts';
import { validateHeaderName, validateHeaderValue } from './header-validation.ts';
import type { HandlerResult } from './http-response.ts';
import type { LogFn, ProjectDocument, RouteAuthShortForm, RouteConfig, TargetName } from './types.ts';
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
/**
 * The one same-origin match every extension uses (docs/EXTENSIONS.md "Site origins"):
 * whether an `Origin` value names the canonical origin or one of the operator's alias origins.
 */
export { isSiteOrigin, maxAliasOrigins } from './site-origins.ts';
/**
 * The address key a per-client limit counts under: an IPv4 address as is, an IPv6 address widened to its
 * `clientKeyIpv6Prefix` (/64) network, `undefined` for a missing or malformed value. Pass `request.client`.
 */
export { clientKey, clientKeyIpv6Prefix } from './client-address.ts';
/** Bounded request reading, JSON responses, cookie reading and same-origin admission (RIM-EXT-HTTP-001). */
export { ExtensionHttpError, readBody, readFields, jsonResponse, wantsJson, readCookie, isSameOriginRequest } from './extension-http.ts';
export type { ExtensionHttpErrorCode, BodyKind, ReadBodyOptions, RequestBody, ReadFieldsOptions, SameOriginOptions } from './extension-http.ts';
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
export interface ExtensionActivation {
  /** The canonical operator origin (`--origin`): the one to build absolute URLs, redirects, emails and links from. */
  origin:string;
  /**
   * Every origin the site is served from: `origin` first, then the operator's alias origins
   * (`--alias-origin`, `aliasOrigins`), validated and serialized. The runtime always sets it; it is
   * optional only so an activation built by hand (a test) keeps meaning the canonical origin alone.
   * Compare an `Origin`/`Referer` value against it with `isSiteOrigin(context, value)`, never by hand.
   */
  origins?:readonly string[];
  /**
   * The operator's shared passkey (WebAuthn) relying-party ID (`--passkey-rp-id`, `passkeyRpId`,
   * `URLCODE_PASSKEY_RP_ID`): a lowercase registrable domain that core has checked equals, or is a parent domain of,
   * the host of every entry in `origins`, and is not an IP address or a known public suffix. Absent unless the
   * operator set it; an extension that runs WebAuthn ceremonies then keeps its own default (the canonical host and
   * the canonical origin alone). When present, a ceremony uses it as the RP ID and may accept any entry of
   * `origins` as the client origin. Changing it invalidates every passkey registered under the previous RP ID.
   */
  passkeyRpId?:string;
  target:TargetName; projectSha256:string; mounts:readonly string[]; root:string;
  /**
   * The subset of `mounts` whose route carries an effective `policies.extensions` entry for at least one extension
   * whose registration declares `providesPrincipal: true` (RIM-EXT-PRINCIPAL-001): the mounts where a request can
   * arrive with a `principal`. It says nothing about whether a given request will have one (a provider may allow
   * without setting it); an extension that needs one still refuses a request whose `principal` is `null`. The
   * runtime always sets it; treat an absent value as empty (fail closed).
   */
  principalMounts?:readonly string[];
  /**
   * Reports a condition the operator should act on that does not stop the site (RIM-EXT-WARN-001): for example
   * stored data that no longer matches the operator's configuration. The runtime writes it to the operator's log as
   * one `{"event":"extension_warning","extension":"<name>","message":"..."}` record, the same log `validate`, `test`,
   * `dev` and `serve` startup print to; it never reaches an HTTP response. The message is cut to one line of at most
   * 500 characters, at most `maxExtensionWarnings` are recorded per extension per activation (then one line saying
   * the rest were suppressed), and a call after `activate()` has settled is ignored: it is an activation channel,
   * not a request log. Write counts and configuration names only, never user data, credentials or secrets. The
   * runtime always sets it; it is optional only so an activation built by hand (a test) can leave it out.
   */
  warn?:(message:string)=>void;
}
/** How many `warn()` calls one extension activation records before a single "further warnings suppressed" line. */
export const maxExtensionWarnings=20;
/**
 * The activation-time `warn()` channel for one extension (RIM-EXT-WARN-001). `close()` ends it once `activate()` has
 * settled, so later calls (request time, timers) are ignored. Logging failures never fail activation.
 */
export function activationWarnings(name:string,log:LogFn|undefined):{warn:(message:string)=>void;close:()=>void} {
  let recorded=0,open=true;
  const warn=(message:string):void=>{
    if(!open||recorded>maxExtensionWarnings)return;
    recorded++;
    const text=recorded>maxExtensionWarnings?`further warnings suppressed after ${maxExtensionWarnings} in this activation`:boundedLine(typeof message==='string'?message:'')||'warning with no message';
    try{log?.({event:'extension_warning',extension:name,message:text});}catch{/* Logging cannot fail activation. */}
  };
  return {warn,close(){open=false;}};
}
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
   * The request's opaque, authenticated principal (RIM-EXT-PRINCIPAL-001): `null` until an extension that declares
   * `providesPrincipal: true` sets it from its own `authorize()` on this route and then allows the request. Core
   * sets it only through `setPrincipal`, never from a header, cookie, query value or YAML, and it is frozen. A
   * later `authorize()`, every `middleware()` and the mount's `handle()` on the same route read it here. Optional
   * only so a request built by hand (a test) may omit it; absent means no principal.
   */
  readonly principal?:ExtensionPrincipal|null;
  /**
   * Sets `principal`. Callable only while the runtime is awaiting the `authorize()` of an extension that declares
   * `providesPrincipal: true`, at most once per call, and only when no other extension has already set one for this
   * request; any other call throws. The value is committed only if that `authorize()` then allows the request
   * (returns `undefined`). See `ExtensionPrincipalInput` for what is accepted.
   */
  readonly setPrincipal?:(principal:ExtensionPrincipalInput)=>void;
  /**
   * The matched route's compiled `env` bindings: the same values a function route's `context.env`
   * receives, resolved from the route's `env:` block under the operator's revision-pinned
   * `permissions.routes[pattern].env` grant. Empty when the route declares none. Route `secrets`
   * are never included. An injection convenience for trusted extension code, not a restriction on it.
   */
  env:Readonly<Record<string,string>>;
}
/**
 * What a principal-providing extension passes to `ExtensionRequest.setPrincipal`: a plain object whose only own key
 * is `id`, a stable opaque identifier matching `principalIdPattern` (1 to 128 characters: ASCII letters and digits,
 * then also `.`, `_`, `:` and `-`). Use a stable account or credential id, never an email address, name, session
 * token or secret. Core knows nothing else about it.
 */
export interface ExtensionPrincipalInput { id:string }
/** The frozen principal core carries on a request: the provider's `id`, and `provider`, the extension name core stamped (never the provider's choice). */
export interface ExtensionPrincipal { readonly id:string; readonly provider:string }
export const principalIdPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Validates a principal a provider passed to `setPrincipal` and freezes it with core's `provider` stamp. */
export function validatePrincipal(value:unknown,provider:string):ExtensionPrincipal {
  assert(value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value) as object|null),`Extension ${provider} set an invalid principal: expected a plain object`);
  const keys=Reflect.ownKeys(value);
  assert(keys.length===1&&keys[0]==='id',`Extension ${provider} set an invalid principal: its only key must be id`);
  const id=(value as {id:unknown}).id;
  assert(typeof id==='string'&&principalIdPattern.test(id),`Extension ${provider} set an invalid principal id`);
  return Object.freeze({id,provider});
}
/**
 * Installs the request's principal slot (RIM-EXT-PRINCIPAL-001) on a freshly built `ExtensionRequest`: a read-only
 * `principal` (initially `null`) and a `setPrincipal` that works only inside `authorize(name, providesPrincipal, call)`.
 * The runtime routes every `authorize()` call on the route through the returned `authorize`, in route order. A
 * value staged by the running provider is committed only when its `authorize()` allows the request; a denial or a
 * throw discards it. A second extension trying to set a principal once one is committed is refused (it throws, and
 * the request fails with a server error), as is a set from any extension that does not declare `providesPrincipal`,
 * from `middleware()`/`handle()`, after `authorize()` has returned, or twice in one call. The slot is per request.
 * Extensions are trusted in-process code: this is a contract that fails closed on mistakes, not a sandbox.
 */
export function installPrincipalSlot(request:ExtensionRequest):{authorize(name:string,providesPrincipal:boolean,call:()=>HandlerResult|undefined|Promise<HandlerResult|undefined>):Promise<HandlerResult|undefined>} {
  let committed:ExtensionPrincipal|null=null;
  interface Frame { name:string; provides:boolean; open:boolean; staged?:ExtensionPrincipal; set:(value:ExtensionPrincipalInput)=>void }
  let frame:Frame|null=null;
  const closed=():never=>{throw new Error('setPrincipal is only callable from a principal-providing extension\'s authorize()');};
  const refuseSecond=(name:string,holder:ExtensionPrincipal):never=>{throw new Error(`Extension ${name} cannot set a principal: extension ${holder.provider} already set one for this request`);};
  Object.defineProperty(request,'principal',{get:()=>committed,enumerable:true,configurable:false});
  Object.defineProperty(request,'setPrincipal',{get:()=>frame?.open?frame.set:closed,enumerable:false,configurable:false});
  return {async authorize(name,providesPrincipal,call){
    const current:Frame={name,provides:providesPrincipal,open:true,set:value=>{
      if(!current.open)closed();
      if(!current.provides)throw new Error(`Extension ${name} does not declare providesPrincipal and cannot set a principal`);
      if(current.staged)throw new Error(`Extension ${name} already set a principal for this request`);
      if(committed)refuseSecond(name,committed);
      current.staged=validatePrincipal(value,name);
    }};
    frame=current;
    let result:HandlerResult|undefined;
    try{result=await call();}
    finally{current.open=false;if(frame===current)frame=null;}
    if(result===undefined&&current.staged){
      if(committed)refuseSecond(name,committed);
      committed=current.staged;
    }
    return result;
  }};
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
  /**
   * Declares that this extension's `authorize()` may set the request's opaque principal through
   * `ExtensionRequest.setPrincipal` (RIM-EXT-PRINCIPAL-001). Only a registration that declares it can set one, and
   * only a route naming it in `policies.extensions` counts toward another extension's `principalMounts`. An
   * extension that declares it and is named in a route policy must implement `authorize()`.
   */
  providesPrincipal?:boolean;
  activate(config:Readonly<Record<string,unknown>>,context:ExtensionActivation):ExtensionInstance|Promise<ExtensionInstance>;
}
/**
 * What core hands an extension definition's `scaffold` (and `example`) when `urlcode extensions add <name>` (or
 * `init --with`) adds it to a site. Neither writes anything: each returns the configuration, routes and operator
 * files core writes for it.
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
 * One value another extension contributes, as `HostContext.contributions` returns it. Core stamps `from`, the
 * contributing definition's registered `name`; the contributor supplies only `value`, so a contribution can never
 * claim another extension's name. The entry is frozen; core never inspects, copies or freezes `value` itself.
 */
export interface Contribution<T=unknown> {
  readonly from:string;
  readonly value:T;
}
/**
 * What `composeHost` gives an extension's `host()`. `get(name)` returns what an extension this one `requires` (or
 * `uses`) exported from its own `host()`; `contributions(name)` collects every installed extension's
 * `contributes[name]` value as `{from, value}` in host.mjs order, so an extension activated first (ui) still
 * receives what later ones add to it, and a receiver that keys by namespace can check it against `from`.
 */
export interface HostContext {
  projectSha256:string;
  /** Absolute site directory: the directory of host.mjs. */
  site:string;
  /**
   * The exports of a `requires` extension, or of an installed `uses` extension; `undefined` for a `uses` extension
   * that is not installed. Throws for any name outside `requires` and `uses`.
   */
  get<T=unknown>(name:string):T;
  /** A new frozen list per call; each entry is frozen `{from, value}`, `from` stamped by core. */
  contributions<T=unknown>(name:string):readonly Contribution<T>[];
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
  /**
   * Extensions this one reads through `ctx.get` only when installed: an optional edge. An installed one is hosted
   * (and activated) before this one, like a `requires` entry; an absent one makes `ctx.get(name)` return
   * `undefined`. Must not name itself or repeat a `requires` entry.
   */
  uses?:readonly string[];
  schema:object;
  policySchema?:object;
  hooks?:readonly ExtensionHookContract[];
  authoring?:ExtensionAuthoringContract;
  /** Add-on-owned, inert local references for agents; emitted into urlcode.json. */
  agent?:AddonAgentTooling;
  /** Static values handed to another installed extension, keyed by its name (for example templates for `ui`). */
  contributes?:Readonly<Record<string,unknown>>;
  /**
   * The capability: what `extensions add` always writes. It adds no sample application endpoints, only what the
   * extension needs to function (its own mount, keys, a documented default configuration).
   */
  scaffold?(request:ScaffoldRequest):ScaffoldResult|Promise<ScaffoldResult>;
  /**
   * Optional sample application behavior (demo collections, pages, flows), written on top of `scaffold` only when
   * the operator passes `--example`. Core merges it into the capability result: `config` deep-merges (plain objects
   * key by key, any other value from the example replaces), `routes` must not collide, and `files`, `env`,
   * `acknowledged`, `routeNotes` and `notes` are appended. It may require an acknowledgement exactly as `scaffold`
   * does.
   */
  example?(request:ScaffoldRequest):ScaffoldResult|Promise<ScaffoldResult>;
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
  const uses=definition.uses??[];
  assert(Array.isArray(uses)&&uses.every(name=>typeof name==='string'&&namePattern.test(name)&&name!==definition.name)&&new Set(uses).size===uses.length,`Extension ${definition.name} uses must list other extension names once each`);
  assert(uses.every(name=>!(definition.requires??[]).includes(name)),`Extension ${definition.name} lists ${uses.filter(name=>(definition.requires??[]).includes(name)).join(', ')} in both requires and uses`);
  assert((definition.scaffold===undefined||typeof definition.scaffold==='function')&&(definition.example===undefined||typeof definition.example==='function'),`Extension ${definition.name} scaffold and example must be functions`);
  const entry=(options?:Options):ExtensionEntry=>Object.freeze({definition:definition as ExtensionDefinition<unknown>,options:options??{}});
  return Object.assign(entry,{definition}) as DefinedExtension<Options>;
}
export interface ActiveExtension { instance:ExtensionInstance; policies:Map<string,Readonly<Record<string,unknown>>>; assetPrefixes:readonly string[]; providesPrincipal:boolean }
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
/** A compiled Ajv validator for an extension's `policySchema`; absent when the extension declares none. */
export type PolicyValidator=((data:unknown)=>boolean)&{errors?:import('ajv').ErrorObject[]|null|undefined};
/** Static stand-in for an installed extension whose descriptor declares no policy schema: an empty requirement only (`auth: true`). */
export const emptyPolicyOnly:PolicyValidator=data=>!Object.keys(data as object).length;
/**
 * Checks each route's effective `policies.extensions.<name>` requirement against that extension's policy schema,
 * reporting the first violation per route through `report` (throwing by default) and returning the admitted
 * requirements by route. A requirement that came from the `auth:` short form (`routeAuth`, from
 * `normalizeRouteAuth`) is located at the route's `auth` key, where the author wrote it; `auth: {required: false,
 * ...}` emits no policy, but the keys written beside it are still checked. Core knows none of the policy's keys.
 */
export function checkExtensionPolicies(document:ProjectDocument,routes:Record<string,RouteConfig>,routeAuth:Record<string,RouteAuthShortForm>|undefined,name:string,validator:PolicyValidator|undefined,report:(error:ConfigError)=>void=error=>{throw error;}):Map<string,Record<string,unknown>> {
  const admitted=new Map<string,Record<string,unknown>>();
  const check=(path:string,policy:Record<string,unknown>,written:string|undefined):boolean=>{
    if(validator&&validator(policy))return true;
    report(extensionPolicyError(name,path,validator?.errors,written));return false;
  };
  for(const [path,route]of Object.entries(routes)){
    const short=name==='auth'&&routeAuth&&Object.hasOwn(routeAuth,path)?routeAuth[path]:undefined;
    const policy=effectiveExtensionPolicies(document,route)[name];
    if(policy&&check(path,policy,short?.required?'auth':undefined))admitted.set(path,policy);
    if(short&&!short.required&&Object.keys(short.requirement).length)check(path,short.requirement,'auth');
  }
  return admitted;
}
/**
 * Validates the project's extension declarations against the operator's registrations and returns the activation
 * step. Extensions activate in registration order (the order `composeHost` produced: every extension after those it
 * requires or uses), filtered to the declared ones, and close in reverse; YAML declaration order does not matter.
 * `log` receives every activation warning (RIM-EXT-WARN-001).
 */
/**
 * `acceptedPin` is set only by `urlcode dev`'s hot reload (`startServer`'s `followExtensionPinOnReload`), never by
 * project YAML, an environment variable or a tool argument: a registration pinned to exactly `acceptedPin.from` (the
 * revision the dev server started from and strictly checked) is accepted for the edited live revision and listed in
 * `followed`. Every other check still runs, and without it the pin must equal the live revision (RIM-EXT-PIN-001).
 */
export function prepareExtensions(document:ProjectDocument,routes:Record<string,RouteConfig>,registrations:RuntimeExtension[]|undefined,context:Omit<ExtensionActivation,'mounts'|'warn'>,routeAuth?:Record<string,RouteAuthShortForm>,log?:LogFn,acceptedPin?:{readonly from:string}): {readonly followed:readonly string[];activate():Promise<ExtensionRegistry>} {
  assert(acceptedPin===undefined||typeof acceptedPin.from==='string'&&/^[a-f0-9]{64}$/.test(acceptedPin.from),'Invalid accepted extension revision pin');
  const followed:string[]=[];
  assert(registrations===undefined||Array.isArray(registrations)&&registrations.length<=16,'Extensions must be an array of at most 16 operator registrations');
  const provided=new Map<string,RuntimeExtension>(),entries=new Map<string,ActiveExtension>(),credentialHeaders=new Set<string>();
  for(const registration of registrations??[]){
    assert(registration&&typeof registration==='object'&&typeof registration.name==='string'&&namePattern.test(registration.name),'Invalid extension registration');
    assert(!provided.has(registration.name),'Duplicate extension provider');
    assert(registration.version==='1'&&typeof registration.activate==='function','Invalid extension version or activation hook');
    assert(registration.providesPrincipal===undefined||typeof registration.providesPrincipal==='boolean','Invalid extension providesPrincipal');
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
  const principalProviders=new Set([...provided.values()].filter(registration=>registration.providesPrincipal===true).map(registration=>registration.name));
  const preparations:{name:string;registration:RuntimeExtension;config:Readonly<Record<string,unknown>>;policies:Map<string,Readonly<Record<string,unknown>>>;mounts:string[];principalMounts:string[];assetPrefixes:string[]}[]=[];
  for(const name of Object.keys(declarations))assert(provided.has(name),`Missing operator extension: ${name}`);
  for(const [name,registration]of provided){
      if(!Object.hasOwn(declarations,name))continue;
      const declaration=declarations[name]!;
      if(registration.projectSha256!==context.projectSha256){
        assert(acceptedPin!==undefined&&registration.projectSha256===acceptedPin.from,`Extension revision pin mismatch: ${name}`);
        followed.push(name);
      }
      assert(registration.targets.includes(context.target),`Extension ${name} refuses target ${context.target}`);
      assert(declaration.version===registration.version,`Extension contract version mismatch: ${name}`);
      const config=structuredClone(declaration.config);
      const ajv=new Ajv.default({strict:true,allErrors:false,verbose:true});
      // The schemas are the operator's registration, not project YAML: a schema Ajv refuses is reported under
      // the extension's name rather than as a generic failure.
      let validateConfig:ReturnType<typeof ajv.compile>,policyValidator:ReturnType<typeof ajv.compile>|undefined;
      try{validateConfig=ajv.compile(registration.schema);policyValidator=registration.policySchema?ajv.compile(registration.policySchema):undefined;}
      catch(error){throw extensionError(error,name,'prepare');}
      if(!validateConfig(config))throw extensionConfigError(name,validateConfig.errors);
      const policies=new Map<string,Readonly<Record<string,unknown>>>();
      for(const [path,policy]of checkExtensionPolicies(document,routes,routeAuth,name,policyValidator))policies.set(path,frozen(structuredClone(policy)));
      const declaredHeaders=registration.credentialHeaders??[];
      assert(Array.isArray(declaredHeaders)&&declaredHeaders.length<=64,'Invalid extension credential headers');
      for(const header of declaredHeaders){assert(typeof header==='string'&&header.length<=128,'Invalid extension credential header');try{validateHeaderName(header);}catch(error){throw extensionError(error,name,'prepare');}credentialHeaders.add(header.toLowerCase());}
      // Session and bearer credentials never cross into application guests.
      credentialHeaders.add('cookie');credentialHeaders.add('authorization');
      const mountRoutes=Object.entries(routes).filter(([,route])=>route.extension===name);
      const mountOf=(path:string):string=>path.endsWith('/*')?path.slice(0,-2):path;
      const mounts=mountRoutes.map(([path])=>mountOf(path));
      const principalMounts=mountRoutes.filter(([,route])=>Object.keys(effectiveExtensionPolicies(document,route)).some(policy=>principalProviders.has(policy))).map(([path])=>mountOf(path));
      const assetPrefixes=registration.immutableAssets===undefined?[]:mounts.map(mount=>mount+validateAssetPrefix((registration.immutableAssets as ExtensionImmutableAssets).prefix,name)+'/');
      preparations.push({name,registration,config:frozen(config),policies,mounts,principalMounts,assetPrefixes});
  }
  return {followed:Object.freeze([...followed]),async activate(){
    try{for(const {name,registration,config,policies,mounts,principalMounts,assetPrefixes}of preparations){
      // What activate throws is the operator's own extension reporting its configuration or environment; it is
      // named and kept (bounded, without a stack) so validate, test, dev and serve startup can print it.
      let instance:ExtensionInstance;
      // warn() reaches the same operator log; it is closed once activate() settles (RIM-EXT-WARN-001).
      const warnings=activationWarnings(name,log);
      try{instance=await registration.activate(config,frozen({...context,mounts,principalMounts,warn:warnings.warn}));}
      catch(error){throw extensionError(error,name,'activate');}
      finally{warnings.close();}
      const providesPrincipal=registration.providesPrincipal===true;
      if(instance&&typeof instance==='object')entries.set(name,{instance,policies,assetPrefixes,providesPrincipal});
      assert(instance&&typeof instance.handle==='function'&&(!policies.size||typeof instance.authorize==='function'||typeof instance.middleware==='function'),`Extension ${name} lacks a required handler, authorization hook or middleware hook`);
      assert(!providesPrincipal||!policies.size||typeof instance.authorize==='function',`Extension ${name} declares providesPrincipal but has no authorization hook`);
      entries.set(name,{instance,policies,assetPrefixes,providesPrincipal});
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
