import { prepareExtensions, effectiveExtensionPolicies, hasExtensionPolicy, isSensitiveExtensionPolicy, extensionResponse, stripReservedContextHeaders, installPrincipalSlot } from './extensions.ts';
import type { RuntimeExtension, ExtensionRegistry, ExtensionRequest, InvocationContext } from './extensions.ts';
import { EgressClient, EgressError } from './egress.ts';
import type { EgressDependencies } from './egress.ts';
import { executeProxy } from './proxy.ts';
import { SignalBroker } from './signals.ts';
import { matchesRoute } from './conditions.ts';
import { analyzeProjectCapabilities, assertTargetCompatibility } from './capabilities.ts';
import { projectPlan, hasRedirect } from './readiness.ts';
import type { ProjectPlan } from './readiness.ts';
import { bodyPolicy, checkRequest, decorateResponse } from './http-policy.ts';
import { compileAssets, assetResponse } from './assets.ts';
import { loadDocument, loadBindings } from './config.ts';
import { compileRoutes, parseTarget, matchRoute, contextFor, resolveValue, redirectLocation } from './router.ts';
import { FunctionPool } from './functions.ts';
import type { FunctionContext } from './functions.ts';
import { TrustedFunctions } from './trusted-functions.ts';
import { prepareFunctionSnapshot, validatePolicy, authorizeEgress } from './policy.ts';
import type { OperatorPolicy } from './policy.ts';
import {assert} from './errors.ts';
import { HttpError } from './errors.ts';
import { compilePolicies, closePolicies, policyRequest, compileErrorPolicy, errorHeaders } from './policies.ts';
import { validatePlugins, activatePlugins, pluginsRequest, pluginsResponse, pluginsError, closePlugins } from './plugins.ts';
import type { Plugin } from './plugins.ts';
import { createObserverSink } from './observability.ts';
import type { MetricsSnapshot, Observer, ObserverSink } from './observability.ts';
import { applySite, siteErrorPaths } from './site.ts';
import { siteOrigins } from './site-origins.ts';
import { joinedHeaderCounts, mountLocation, normalizeBasePath } from './host-request.ts';
import { cancelStream, isResponseStream, errorScope, resolveErrorFormat, methodNotAllowed, errorEnvelope, jsonErrorType } from './http-response.ts';
import type { ErrorFormat, HandlerResult, HeaderPair, ResponseStream, StreamChunk } from './http-response.ts';
import type { CompiledRoute, CompiledRouteTable, LoadedDocument, LogFn, PolicyChain, PolicyInventory, PolicyModule, PolicyRequest, PolicyShared, TargetName } from './types.ts';
import type { SecurityState } from './policies/security.ts';

export type { OperatorPolicy } from './policy.ts';
/** An operator plugin (src/plugins.ts). */
export type HostPlugin = Plugin;
export type { Observer, MetricsSnapshot } from './observability.ts';
export interface TestPlan extends ProjectPlan { policies: Record<string, PolicyInventory> }
export interface RuntimeOptions {
  extensions?: RuntimeExtension[] | undefined;
  /** Trusted host transport injection; never supplied by project YAML or guest code. */
  egressDependencies?: EgressDependencies;
  observers?: Observer[] | undefined; log?: LogFn | undefined; origin?: string | undefined; local?: boolean | undefined;
  /** Operator-set additional origins the site is also served from (at most 16, `https:` or loopback `http:`).
   * Extensions' same-origin checks admit them beside `origin`; generated absolute URLs keep using `origin`.
   * Requires `origin`. Never supplied by project YAML. */
  aliasOrigins?: readonly string[] | undefined;
  environment?: NodeJS.ProcessEnv | undefined; permissions?: OperatorPolicy | undefined;
  target?: TargetName | undefined; plugins?: HostPlugin[] | undefined;
  workers?: number | undefined; timeoutMs?: number | undefined; maxBytes?: number | undefined;
  /** Build tooling only: compile just these route patterns, after site conventions
   * have been expanded. It can only remove routes, never add or alter one, and the
   * smaller route set changes the project hash, so an operator policy pinned to the
   * whole project denies every binding it grants. Prerendering uses it to render a
   * project too large for one function snapshot in passes (docs/PRERENDER.md). */
  only?: readonly string[] | undefined;
  /** Test harness only (set by `startServer` when it is given a data directory): also grant every
   * route's `{env: URLCODE_DATA_DIR}` binding, and only that name, for this project revision. The value
   * is the harness's own directory, not an ambient secret. Never supplied by project YAML or guest code. */
  grantDataDir?: boolean | undefined;
  /** `urlcode dev` hot reload only (set by `startServer` when `followExtensionPinOnReload` is on, never on its first
   * runtime): an extension registration pinned to exactly `from`, the revision the dev server started from, is
   * accepted for this edited revision and reported once as `extension_pin_followed`. Every other extension check
   * still runs. Never supplied by project YAML, an environment variable or a tool argument (RIM-EXT-PIN-001). */
  acceptedExtensionPin?: { readonly from: string } | undefined;
  /** In-process reload only (set by `startServer`'s `reload()`): the serving runtime this one is built to replace.
   * Each extension whose serving instance was activated from the same registration object and implements
   * `handoff()` offers its hand-off to that registration's activation here (RIM-EXT-HANDOFF-001). The serving
   * runtime is never closed or changed by this call: the caller installs the new runtime, then closes the old one,
   * or keeps serving the old one when this call fails. Never supplied by project YAML or a tool argument. */
  replacing?: Runtime | undefined;
}
/** The extension registry of each runtime `createRuntime` built, for a reload's hand-off (RIM-EXT-HANDOFF-001). */
const extensionRegistries = new WeakMap<Runtime, ExtensionRegistry>();
function withDataDirGrant(loaded: LoadedDocument, projectSha256: string, given: OperatorPolicy | undefined): OperatorPolicy | undefined {
  // An operator policy pinned to another revision stays as it is: it denies, exactly as it would without this option.
  if (given && given.projectSha256 !== projectSha256) return given;
  const routes: OperatorPolicy['routes'] = { ...(given?.routes ?? {}) };
  for (const [pattern, route] of Object.entries(loaded.routes)) {
    if (!Object.values(route.env || {}).some(ref => ref.env === 'URLCODE_DATA_DIR')) continue;
    const grant = routes[pattern] ?? {};
    routes[pattern] = { ...grant, env: [...new Set([...(grant.env ?? []), 'URLCODE_DATA_DIR'])] };
  }
  return { version: 1, projectSha256, routes };
}
/** Per-request facts the host may read after handle() settles; never request text. */
export interface RequestTrace { route?: string; probe?: boolean; client?: string | null }
export interface RuntimeRequest {
  target: string; method?: string | undefined; headers?: Headers | undefined; body?: Uint8Array | undefined;
  /** How many lines each header arrived on. When absent (a host that only has joined headers), a value containing a
   * comma counts as two, so every refusal of a repeated header still fires (host-request.ts `joinedHeaderCounts`). */
  headerCounts?: Record<string, number> | undefined; trace?: RequestTrace | undefined; origin?: string | undefined; client?: string | undefined;
  /** The prefix a host mounts the site under and strips before `target` (`/app`): a function's `request.url` keeps
   * it, and a path-absolute `Location` in the answer gets it (RIM-EMBED-001). */
  basePath?: string | undefined;
  /** The id the host answers this request with (`X-Request-Id`); generated when a caller supplies none. Reaches extension requests, hook contexts and function contexts. */
  requestId?: string | undefined;
  /** Aborted by the host when the client disconnects or a streamed response ends early; handed to extensions
   * (`ExtensionRequest.signal`) and trusted functions (`context.signal`), never into the sandbox. */
  signal?: AbortSignal | undefined;
}
export interface Runtime {
  readonly healthy: boolean; assetWatch: string[]; version: string; count: number; root: string;
  /** The project revision (`projectSha256`) this runtime compiled. */
  readonly revision: string;
  testPlan(): TestPlan;
  readonly plugins: { name: string; version: string }[];
  readonly workers: { healthy: number; slots: number };
  metrics(): MetricsSnapshot;
  errorHeaders(error: unknown, origin: string): HeaderPair[];
  /** How the host writes an error answer (docs/HTTP.md#error-format): the format handle() resolved when it threw the
   * error, otherwise the one the request target resolves to (an error the host raised before or around handle()). */
  errorFormat(error: unknown, target: string): ErrorFormat;
  /** The body limit the route matching `target` sets for `method` (its `request.body.<METHOD>.maxBytes`), if any. */
  requestLimit(target: string, method: string): number | undefined;
  /** A result carrying `stream` must be pulled to its end or cancelled (its iterator's `return()`); `close()` waits for it. */
  handle(request: RuntimeRequest): Promise<HandlerResult>;
  close(): Promise<void>;
}
export async function createRuntime(project: string, rawOptions: RuntimeOptions = {}): Promise<Runtime> {
  // Observers see every event this runtime emits; the operator's log stays
  // the default sink. A server passes none down: it owns its own sink and
  // counters, which survive the runtimes it replaces on reload.
  const { observers, ...options } = rawOptions;
  const sink: ObserverSink = createObserverSink(observers, options.log);
  options.log = sink;
  // Operator alias origins are refused before any project work, whatever the target.
  const origins = siteOrigins(options.origin, options.aliasOrigins);
  const loaded = await loadDocument(project);
  // Site conventions become ordinary routes before compilation; a declared
  // route at the same path wins. The public origin, when the server knows
  // it, is what absolute URLs in generated files are built from.
  await applySite(loaded, { origin: options.origin, log: options.log });
  if (options.only !== undefined) {
    const only = options.only;
    assert(Array.isArray(only) && only.every(pattern => typeof pattern === 'string'), 'Route restriction must be a string array');
    // An unknown pattern is a caller mistake, not an empty selection: a silent
    // miss would prerender a partial site that looks whole.
    for (const pattern of only) assert(Object.hasOwn(loaded.routes, pattern), `Route restriction names unknown route ${pattern}`);
    const kept = new Set(only);
    for (const pattern of Object.keys(loaded.routes)) if (!kept.has(pattern)) delete loaded.routes[pattern];
  }
  assertTargetCompatibility(analyzeProjectCapabilities(loaded, options.target || 'node', options.extensions));
  const snapshot = await prepareFunctionSnapshot(loaded);
  if (options.permissions) validatePolicy(options.permissions);
  const egressGrants=authorizeEgress(loaded,snapshot.projectSha256,options.permissions);
  const extensionPlan=prepareExtensions(loaded.document,loaded.routes,options.extensions,{origin:options.origin??'',origins,target:options.target??'node',projectSha256:snapshot.projectSha256,root:loaded.root},loaded.routeAuth,sink,options.acceptedExtensionPin);
  const bindings = await loadBindings(loaded.root, options.local, options.environment);
  const notFoundPage = loaded.document.site?.notFound !== undefined && loaded.document.site.notFound !== null;
  const compiled: CompiledRouteTable = await compileRoutes(loaded, bindings, options.grantDataDir ? withDataDirGrant(loaded, snapshot.projectSha256, options.permissions) : options.permissions, snapshot.projectSha256, options.extensions);
  const routes = [...compiled.mounts, ...compiled.exact.values(), ...[...compiled.byLength.values()].flat()];
  const assets = await compileAssets(loaded.root, routes, loaded.locations);
  // Host policies compile after assets so a policy can see what a route serves
  // (precompressed variants, cacheability). Cross-request state lives in one
  // per-runtime object and is released with the runtime, never shared across
  // reloads: a new snapshot starts with empty counters and an empty cache.
  const target = options.target || 'node';
  const plugins = validatePlugins(options.plugins, target);
  // Capture the operator declaration once, before activation hooks can mutate
  // their plugin objects. This boundary applies to public guest routes too.
  const credentialHeaders=new Set(plugins.flatMap(plugin=>plugin.credentialHeaders||[]).map(name=>name.toLowerCase()));
  const shared: PolicyShared = { target, log: options.log, routes: routes.length };
  const anyPolicy = Boolean(loaded.document.policies) || routes.some(route => route.policies);
  for (const route of routes) route.policy = anyPolicy ? await compilePolicies(loaded.document, route, { route, shared, target, root: loaded.root }) : null;
  const projectErrorPolicy: SecurityState | null = anyPolicy ? compileErrorPolicy(loaded.document, { target }) : null;
  // Which route's policy an error belongs to, so its headers follow the route
  // the request matched rather than the project default.
  const errorRoutes = new WeakMap<object, PolicyChain | null>();
  // How each thrown error is written: the matched route's `errors.format`, else the `site.errors` scope of the path.
  const inErrorScope = errorScope(siteErrorPaths(loaded.document.site));
  const errorFormats = new WeakMap<object, ErrorFormat>();
  const rawPath = (target: string): string => target.split('?')[0] ?? '';
  const targetErrorFormat = (target: string): ErrorFormat => {
    try { const parsed = parseTarget(target); return resolveErrorFormat(matchRoute(compiled, parsed)?.route.errors?.format, inErrorScope, parsed.path); }
    catch { return resolveErrorFormat(undefined, inErrorScope, rawPath(target)); }
  };
  // Only `sandbox: true` routes go through the worker/QuickJS pool
  // (docs/FUNCTION-SECURITY.md): every other function/middleware
  // route is trusted-by-default and dispatches through `trusted` below,
  // in-process, with no worker or WASM engine involved at all.
  const pool=await new FunctionPool(routes.filter(route=>route.sandbox===true), { root:loaded.root, snapshot, log:options.log, workers:options.workers, timeoutMs:options.timeoutMs, maxBytes:options.maxBytes }).start();
  const trusted = new TrustedFunctions({ timeoutMs: options.timeoutMs, maxBytes: options.maxBytes, root: loaded.root });
  // Eagerly validated up front, exactly like the sandboxed pool above: a
  // trusted route with a broken module or a missing export fails activation
  // here rather than on its first request.
  try{await trusted.start(routes.filter(route=>route.sandbox!==true));}
  catch(error){await pool.close();throw error;}
  const proxyClient=new EgressClient({grantOrigins:egressGrants.proxy},options.egressDependencies);
  const signalClient=new EgressClient({grantOrigins:egressGrants.signals,concurrency:8},options.egressDependencies);
  let lastSignals={accepted:0,delivered:0,failed:0,dropped:0};
  const signalBroker=new SignalBroker(signalClient,8,stats=>{for(const outcome of ['accepted','delivered','failed','dropped'] as const){const count=stats[outcome]-lastSignals[outcome];if(count)sink({event:'signal',outcome,count});}lastSignals=stats;});
  let extensionRegistry:ExtensionRegistry;
  try{
    const serving=options.replacing===undefined?undefined:extensionRegistries.get(options.replacing);
    assert(options.replacing===undefined||serving!==undefined,'A reload replaces only a serving runtime that createRuntime built');
    extensionRegistry=await extensionPlan.activate(serving);
  }
  catch(error){await pool.close();await closePolicies(shared);await proxyClient.close();await signalClient.close();throw error;}
  for(const name of extensionRegistry.credentialHeaders)credentialHeaders.add(name);
  for(const route of routes)route.extensionPolicyNames=Object.keys(effectiveExtensionPolicies(loaded.document,route));
  // Gates `authorize()` invocation, the extension request-body cap and
  // request-phase ordering: unaffected by declared cache sensitivity, so
  // every extension-policy route stays protected here regardless.
  const privateRoutes=new Set(routes.filter(route=>route.extension||hasExtensionPolicy(loaded.document,route)).map(route=>route.pattern));
  // Gates the no-store/compression-disabled/extension-response-cap treatment
  // in `finishPolicies` below. An `extension:` mount is always confidential.
  // A `policies.extensions` route is confidential unless every named
  // extension explicitly declares `cacheSensitive: false` (src/extensions.ts).
  const confidentialRoutes=new Set(routes.filter(route=>route.extension||isSensitiveExtensionPolicy(route.extensionPolicyNames??[],options.extensions)).map(route=>route.pattern));
  let active = 0, streamsOpen = 0, closing = false, finish: (() => void) | undefined;
  const settle = (): void => { if (!active && !streamsOpen && closing) finish?.(); };
  // An admitted stream keeps this runtime (its extensions and function modules) open until the stream ends, so a
  // retired runtime closes only after its last stream, like its last buffered request (RIM-STREAM-001).
  const track = (stream: ResponseStream): ResponseStream => {
    streamsOpen++;
    let ended = false, source: AsyncIterator<StreamChunk> | undefined;
    const end = (): void => { if (!ended) { ended = true; streamsOpen--; settle(); } };
    const from = (): AsyncIterator<StreamChunk> => (source ??= stream[Symbol.asyncIterator]());
    const iterator: AsyncIterator<StreamChunk> = {
      async next() { try { const step = await from().next(); if (step.done) end(); return step; } catch (error) { end(); throw error; } },
      async return(value?: unknown) { end(); const it = from(); return it.return ? await it.return(value) : { done: true, value: undefined }; },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  };
  // `abort` cancels the signal handed to this request's function or extension: a producer the host will never read
  // is stopped through the signal as well as its iterator (#802).
  interface DispatchState { route?: CompiledRoute; produced: ResponseStream[]; abort: (reason: 'error') => void }
  // Only a route that declares streaming may answer with a stream: a trusted `function` route with `stream: true`,
  // or the mount of an extension registered with `streams: true`. Anything else is the generic 502, logged.
  const admitStream = (result: HandlerResult, state: DispatchState, requestId: string): HandlerResult => {
    const route = state.route;
    const declared = route !== undefined && route.sandbox !== true
      && ((route.stream === true && route.function !== undefined) || (route.extension !== undefined && extensionRegistry.entries.get(route.extension)?.streams === true));
    if (!declared || !isResponseStream(result.stream) || (result.body !== undefined && result.body !== null)) {
      state.abort('error');
      cancelStream(isResponseStream(result.stream) ? result.stream : undefined);
      for (const produced of state.produced) cancelStream(produced);
      sink({ event: 'stream_refused', requestId, route: route?.pattern ?? null, reason: declared ? 'invalid' : 'undeclared' });
      const error = new HttpError(502, 'Invalid function response');
      if (route) errorRoutes.set(error, route.policy ?? null);
      throw error;
    }
    return { ...result, stream: track(result.stream) };
  };
  // Response phase: cache store, throttle headers, security headers,
  // compression, then operator plugins in reverse. A result produced by a
  // request-phase policy skips that policy's own response hook (a cache hit
  // is not stored twice) but still passes through the others (a hit still
  // carries the client's rate-limit headers; a denial is not stored because
  // its status is not cacheable). A plugin short-circuit ran before any
  // policy, so it skips every request-phase policy's response hook.
  async function finishPolicies(policy: PolicyChain | null | undefined, request: PolicyRequest, result: HandlerResult, producer?: PolicyModule | 'plugin'): Promise<HandlerResult> {
    const confidential=confidentialRoutes.has(request.route);
    let out = confidential?extensionResponse(result):result;
    for (const [module, state] of policy?.response || []) {
      if(confidential&&module.name==='compression')continue;
      if (producer === 'plugin' ? module.onRequest : module === producer) continue;
      out = await module.onResponse?.(state, request, out) ?? out;
    }
    out=await pluginsResponse(plugins, request, out);
    return confidential?extensionResponse(out):out;
  }
  function policyInventory(): Record<string, PolicyInventory> {
    return Object.fromEntries(routes.flatMap(route => route.policy && Object.keys(route.policy.describe).length ? [[route.pattern, route.policy.describe] as const] : []));
  }
  const workers = () => ({ healthy: pool.slots.filter(slot => slot?.ready).length, slots: pool.size });
  const testPlan = (): TestPlan => ({...projectPlan(compiled),policies:policyInventory()});
  try{await activatePlugins(plugins, { testPlan, version: loaded.version + assets.digest, root: loaded.root, target });}
  catch(error){await Promise.all([extensionRegistry.close(),signalBroker.close(),signalClient.close(),proxyClient.close(),pool.close(),closePolicies(shared),closePlugins(plugins),sink.close()]);throw error;}
  // Reported only once the edited revision fully activated, so a rejected reload never claims a followed pin.
  if(extensionPlan.followed.length)sink({event:'extension_pin_followed',extensions:[...extensionPlan.followed],from:options.acceptedExtensionPin!.from,to:snapshot.projectSha256});
  const runtime: Runtime = {
    get healthy() { return !closing && pool.healthy; },
    assetWatch: assets.watch, version: loaded.version + assets.digest, count: compiled.count, root: loaded.root, revision: snapshot.projectSha256,
    testPlan,
    get plugins() { return plugins.map(plugin => ({ name: plugin.name, version: plugin.version })); },
    get workers() { return workers(); },
    metrics() { const { healthy, slots } = workers(); const snapshot = sink.metrics.snapshot(); snapshot.functionWorkers.healthySlots = healthy; snapshot.functionWorkers.slots = slots; return snapshot; },
    // Security headers for an error answer: the matched route's when handle()
    // threw after matching, the project's otherwise (no match, or a host-side
    // error such as an oversized body or shed admission).
    errorHeaders(error, origin) {
      const policy = error && typeof error === 'object' ? errorRoutes.get(error) : undefined;
      return errorHeaders(policy === undefined ? projectErrorPolicy : policy?.security ?? null, origin);
    },
    errorFormat(error, target) {
      const known = error && typeof error === 'object' ? errorFormats.get(error) : undefined;
      return known ?? targetErrorFormat(target);
    },
    requestLimit(target, method) {
      const match = matchRoute(compiled, parseTarget(target));
      return (match ? bodyPolicy(match.route, method)?.maxBytes : undefined) ?? (match?.route.proxy||match?.route.extension?1048576:undefined);
    },
    async handle(request) {
      const requestId = request.requestId ?? crypto.randomUUID();
      // The handler sees the host's signal joined with the runtime's own, so the runtime can cancel a producer it refuses.
      const local = new AbortController();
      const signal = request.signal ? AbortSignal.any([request.signal, local.signal]) : local.signal;
      const state: DispatchState = { produced: [], abort: reason => { if (!local.signal.aborted) local.abort(reason); } };
      const basePath = normalizeBasePath(request.basePath);
      const headerCounts = request.headerCounts ?? joinedHeaderCounts(request.headers ?? new Headers());
      const result = mountLocation(await dispatch({ ...request, headerCounts, basePath, requestId, signal }, state), basePath);
      return result.stream === undefined ? result : admitStream(result, state, requestId);
    },
    async close() {
      closing = true;
      // A closing runtime offers nothing: its instances are about to release their references.
      extensionRegistries.delete(runtime);
      await Promise.all([signalBroker.close(),signalClient.close(),proxyClient.close()]);
      if (active || streamsOpen) await new Promise<void>(resolve => { finish = resolve; });
      await pool.close();
      await trusted.close();
      await closePolicies(shared);
      await closePlugins(plugins);
      await extensionRegistry.close();
      await sink.close();
    },
  };
  extensionRegistries.set(runtime, extensionRegistry);
  return runtime;
  async function dispatch({ target, method = 'GET', headers = new Headers(), body, headerCounts, basePath = '', trace = {}, origin = 'http://localhost', client, requestId = crypto.randomUUID(), signal = new AbortController().signal }: RuntimeRequest, state: DispatchState): Promise<HandlerResult> {
      if (closing) throw new HttpError(503, 'Runtime unavailable');
      assert(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128, 'Request id must be a non-empty string of at most 128 characters');
      active++;
      let policyReq: PolicyRequest | undefined, policy: PolicyChain | null | undefined;
      // Until the target parses, the raw path decides the site scope; then the decoded path; then the matched route.
      let format: ErrorFormat = resolveErrorFormat(undefined, inErrorScope, rawPath(target));
      try {
        const parsed = parseTarget(target);
        const match = matchRoute(compiled, parsed);
        format = resolveErrorFormat(match?.route.errors?.format, inErrorScope, parsed.path);
        if (!match) {
          // site.notFound: answer an unmatched GET/HEAD with the configured page and status 404. A path whose errors
          // are JSON keeps the JSON 404: an API client asked, not a browser.
          if (notFoundPage && format === 'text' && (method === 'GET' || method === 'HEAD')) {
            const page = await dispatch({ target: '/404.html', method, headers, headerCounts, basePath, trace: {}, origin, requestId, signal, ...(client ? { client } : {}) }, { produced: [], abort: state.abort });
            return { ...page, status: 404 };
          }
          throw new HttpError(404, 'Not found');
        }
        const { route, path } = match;
        state.route = route;
        // Configured pattern only; never the request path, query or parameter values.
        trace.route = route.pattern;
        // Known from here on, so an error thrown by the route's own checks
        // (disabled, expired) is answered with that route's security headers.
        policy = route.policy;
        const conditionRequest = { query: parsed.query, headers, method, origin, headerCounts };
        if (route.match && !matchesRoute(route.match,conditionRequest)) throw new HttpError(404,'Not found');
        if (route.enabled === false) throw new HttpError(404, 'Not found');
        if (route.expiresAt && Date.now() >= route.expiresAt) throw new HttpError(410, 'Gone');
        // Host policies and plugins run once the route is known and before
        // its contract is checked: a denied agent or an exhausted budget is
        // answered without reading a body or touching the sandbox.
        const protectedRoute=privateRoutes.has(route.pattern);
        // `headers` here always excludes the reserved `x-urlcode-context-*` namespace
        // (stripReservedContextHeaders), so a client can never inject or spoof a value
        // in it; only an authorize()/middleware() hook below can write into this clone
        // (RIM-EXT-CONTEXT-001, docs/RUNTIME-IMPLEMENTATION.md).
        const extensionRequest:ExtensionRequest={method,target,path:parsed.path,query:new URLSearchParams(parsed.query),headers:stripReservedContextHeaders(new Headers(headers)),headerCounts:{...headerCounts},body:body??new Uint8Array(),origin:options.origin??origin,route:route.pattern,mount:route.extension?route.pattern.slice(0,-2):null,client:client??null,requestId,env:Object.freeze({...route.env}),signal};
        if(protectedRoute&&(body?.byteLength??0)>Math.min(1048576,bodyPolicy(route,method)?.maxBytes??1048576))throw new HttpError(413,'Request body too large');
        // The request's opaque principal (RIM-EXT-PRINCIPAL-001): null until a principal-providing extension's
        // authorize() on this route sets it and allows the request; never read from the client request.
        const principalSlot=installPrincipalSlot(extensionRequest);
        const authorize=async():Promise<HandlerResult|undefined>=>{for(const name of route.extensionPolicyNames??[]){const entry=extensionRegistry.entries.get(name)!;const hook=entry.instance.authorize;if(typeof hook!=='function')continue;const result=await principalSlot.authorize(name,entry.providesPrincipal,()=>hook.call(entry.instance,entry.policies.get(route.pattern)!,extensionRequest));if(result)return result;}return undefined;};
        if (policy || plugins.length || protectedRoute) {
          policyReq = policyRequest({ method, target, path: parsed.path, params: path, query: parsed.query, headers, headerCounts, client, origin, route });
          trace.client = policyReq.client;
          if(!protectedRoute){const early=await pluginsRequest(plugins,policyReq);if(early)return await finishPolicies(policy,policyReq,early,'plugin');}
          let authorized=false;
          for (const [module, state] of policy?.request || []) {
            if(protectedRoute&&module.name==='cache'&&!authorized){const denied=await authorize();authorized=true;if(denied)return await finishPolicies(policy,policyReq,denied);}
            const result = await module.onRequest?.(state, policyReq);
            if (result) return await finishPolicies(policy, policyReq, result, module);
          }
          if(protectedRoute){if(!authorized){const denied=await authorize();if(denied)return await finishPolicies(policy,policyReq,denied);}const early=await pluginsRequest(plugins,policyReq);if(early)return await finishPolicies(policy,policyReq,early,'plugin');}
        }
        // Everything from here on (method contract, native reply, the native
        // `middleware:` chain and the handler) is "the rest of the pipeline"
        // for this route. It is wrapped in a callable so an extension's own
        // `middleware()` hook (policies.extensions.<name>, parallel to
        // `authorize` above and never touching this native chain) can run
        // code before and after it via `next()`, or skip it entirely.
        const runPipeline = async (): Promise<HandlerResult> => {
        if (!route.methods.includes(method)) {
          const refused = methodNotAllowed(route.methods, format);
          // Counted by throttle already, so it carries the budget headers and
          // the security profile like any other answer; nothing caches a 405.
          return policyReq ? await finishPolicies(policy, policyReq, refused) : refused;
        }
        checkRequest(route, method, body || Buffer.alloc(0), headers, headerCounts);
        const finishResponse = async (result: HandlerResult): Promise<HandlerResult> => {
          const out = policyReq ? await finishPolicies(policy, policyReq, decorateResponse(route,result)) : decorateResponse(route,result);
          if(method!=='HEAD'&&!trace.probe)for(const signal of route.compiledSignals||[])signalBroker.emit(signal,{route:route.pattern,status:out.status,method});
          if (route.proxy || route.match || route.conditional) return { ...out, headers: [...out.headers.filter(([name]) => !['cache-control','cdn-cache-control','vercel-cdn-cache-control','surrogate-control'].includes(name.toLowerCase())), ['cache-control','no-store']] };
          return out;
        };
        // Policies, plugins and body checks retain the original request. Project
        // inputs and the guest receive a separate, credential-free projection, built
        // from `extensionRequest.headers` (not the original client `headers`) so that
        // a value an authorized extension's authorize()/middleware() wrote into the
        // reserved `x-urlcode-context-*` namespace above carries forward into the
        // route's own trusted function/middleware context (RIM-EXT-CONTEXT-001). A
        // proxy route's own `requestHeaders`/`responseHeaders` selection can never name
        // that namespace (proxy.ts: validateProxy), so it never reaches an upstream.
        // Declared credential headers are stripped from this projection exactly as
        // before.
        const guestHeaders=new Headers(extensionRequest.headers);
        for(const name of credentialHeaders)guestHeaders.delete(name);
        const context: FunctionContext = { ...contextFor(route, path, parsed.query, guestHeaders, headerCounts), requestId };
        // Never into the sandbox: an AbortSignal is host state and cannot cross the worker boundary.
        if (route.sandbox !== true) context.signal = signal;
        // RIM-EXT-CAPABILITY-001: bind this request's capability objects, one call per declared name per named
        // extension, never into the sandbox (router.ts refuses that combination before serving) and never for an
        // extension with nothing declared. `provide()` returning undefined just omits that one entry.
        if (route.sandbox !== true && route.extensionPolicyNames?.length) {
          const invocation: InvocationContext = Object.freeze({ requestId, route: Object.freeze({ pattern: route.pattern }), principal: extensionRequest.principal ?? null, ...(signal ? { signal } : {}) });
          const capabilities: Record<string, Record<string, unknown>> = {};
          for (const name of route.extensionPolicyNames) {
            const entry = extensionRegistry.entries.get(name)!;
            const declared = entry.registration.capabilities ?? [];
            if (!declared.length || typeof entry.instance.provide !== 'function') continue;
            const bound: Record<string, unknown> = {};
            for (const capability of declared) {
              const value = await entry.instance.provide(capability, invocation);
              if (value !== undefined) bound[capability] = value;
            }
            if (Object.keys(bound).length) capabilities[name] = Object.freeze(bound);
          }
          if (Object.keys(capabilities).length) context.capabilities = Object.freeze(capabilities);
        }
        // A declared schema default must not recreate a withheld header entry.
        for(const name of credentialHeaders)delete context.inputs.header[name];
        let native: HandlerResult | undefined;
        if(route.extension){const answer=await extensionRegistry.entries.get(route.extension)!.instance.handle(extensionRequest);if(answer&&isResponseStream(answer.stream))state.produced.push(answer.stream);native=extensionResponse(answer);}
        else if(route.compiledProxy){
          // Same credential-free projection a guest function receives: an
          // extension-declared credential header in requestHeaders must not
          // reach the upstream any more than it reaches a function's code.
          try {const result=await executeProxy(proxyClient,route.compiledProxy,{method,url:origin+basePath+target,params:path,headers:Object.fromEntries(guestHeaders),...(body?{body}:{})});native={status:result.status,headers:Object.entries(result.headers),body:result.body};}
          catch(error){throw new HttpError(error instanceof EgressError&&error.code==='timeout'?504:error instanceof EgressError&&['busy','closed','aborted'].includes(error.code)?503:502,'Proxy upstream unavailable');}
        }
        else if (route.conditionalRoutes) {
          const selected = route.conditionalRoutes.cases.find(item => matchesRoute(item.match,conditionRequest))?.route ?? route.conditionalRoutes.fallback;
          if (!selected) throw new HttpError(404,'Not found');
          if (hasRedirect(selected)) native = { status: selected.redirect.status || 302, headers: [['location',redirectLocation(selected,context,parsed.query)]], body: Buffer.alloc(0) };
          else native = selected.reply;
        }
        else if (hasRedirect(route)) native = { status: route.redirect.status || 302,
          headers: [['location', redirectLocation(route, context, parsed.query)]], body: Buffer.alloc(0) };
        else if (route.reply) native = route.reply;
        else if (route.asset) {
          try { native = assetResponse(route, parsed.path, method, headers); }
          catch (error) {
            if (!route.middleware.length || !(error instanceof HttpError)) throw error;
            native = format === 'json'
              ? {status:error.status,headers:[['content-type',jsonErrorType],['cache-control','no-store']],body:Buffer.from(errorEnvelope(error.status,error.message))}
              : {status:error.status,headers:[['content-type','text/plain; charset=utf-8'],['cache-control','no-store']],body:Buffer.from(error.message+'\n')};
          }
        }
        if (native && !route.middleware.length) return await finishResponse(native);
        context.args = Object.fromEntries(Object.entries(route.function?.args || {}).map(([key, ref]) => [key, resolveValue(ref, context)]));
        context.route = { pattern: route.pattern };
        // Uniform for `function` and `middleware` alike: a route dispatches
        // through the sandboxed worker pool only when it declares
        // `sandbox: true`; every other route runs trusted, in-process
        // (docs/FUNCTION-SECURITY.md).
        const executor = route.sandbox ? pool : trusted;
        const executed = await executor.execute(route, { url: origin + basePath + target, method, headers: [...guestHeaders], body }, context, native);
        if (isResponseStream(executed.stream)) state.produced.push(executed.stream);
        return await finishResponse(executed);
        };
        // Extension `middleware()` hooks, declared the same way `authorize` is
        // (policies.extensions.<name> on this route, config already validated
        // against the extension's policySchema): only a name this route names
        // and whose activated instance actually implements `middleware` can
        // ever wrap it, in the route's declared order, each one's `next()`
        // reaching the next one and the innermost `next()` reaching the
        // native pipeline above. `authorize` is untouched: it already ran
        // (or short-circuited) before this point.
        let pipeline = runPipeline;
        for (const name of [...(route.extensionPolicyNames ?? [])].reverse()) {
          const entry = extensionRegistry.entries.get(name)!;
          if (typeof entry.instance.middleware !== 'function') continue;
          const config = entry.policies.get(route.pattern)!;
          const downstream = pipeline;
          pipeline = async () => {
            let called = false;
            const next = async (): Promise<HandlerResult> => {
              assert(!called, `Extension ${name} middleware called next() more than once`);
              called = true;
              return await downstream();
            };
            const result = await entry.instance.middleware!(config, extensionRequest, next);
            // `downstream()` already ran the result through `finishPolicies`
            // (it bottoms out in `runPipeline`, whose every exit does). Only
            // a short-circuit that skipped `next()` returns a raw result,
            // which needs exactly the one pass `authorize`'s own denial gets.
            return called ? result : (policyReq ? await finishPolicies(policy, policyReq, result) : result);
          };
        }
        return await pipeline();
      } catch (error) {
        // A stream produced before a later step failed is never pulled; stop its producer.
        if (state.produced.length) state.abort('error');
        for (const produced of state.produced) cancelStream(produced);
        if (policy !== undefined && error && typeof error === 'object') errorRoutes.set(error, policy);
        if (error && typeof error === 'object') errorFormats.set(error, format);
        if (policyReq) {
          // A policy may answer instead of the error (stale-if-error serving a
          // stored copy); the first fallback wins and still passes through the
          // response phase. Otherwise the hooks only observe.
          for (const [module, state] of policy?.error || []) {
            let fallback;
            try { fallback = await module.onError?.(state, policyReq, error); } catch { /* an observer cannot change the outcome */ }
            if (fallback) return await finishPolicies(policy, policyReq, fallback, module);
          }
          await pluginsError(plugins, policyReq, error);
        }
        throw error;
      } finally { active--; settle(); }
  }
}
