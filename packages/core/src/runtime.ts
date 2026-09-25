import { prepareExtensions, effectiveExtensionPolicies, hasExtensionPolicy, isSensitiveExtensionPolicy, extensionResponse, stripReservedContextHeaders } from './extensions.ts';
import type { RuntimeExtension, ExtensionRegistry, ExtensionRequest, ExtensionAssetContext } from './extensions.ts';
import { EgressClient, EgressError } from './egress.ts';
import type { EgressDependencies } from './egress.ts';
import { executeProxy } from './proxy.ts';
import { SignalBroker } from './signals.ts';
import { matchesRoute } from './conditions.ts';
import { analyzeProjectCapabilities, assertTargetCompatibility } from './capabilities.ts';
import { projectPlan, hasRedirect } from './readiness.ts';
import type { ProjectPlan } from './readiness.ts';
import { checkRequest, decorateResponse } from './http-policy.ts';
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
import { applySite } from './site.ts';
import { siteOrigins } from './site-origins.ts';
import type { HandlerResult, HeaderPair } from './http-response.ts';
import type { CompiledRouteTable, LoadedDocument, LogFn, PolicyChain, PolicyInventory, PolicyModule, PolicyRequest, PolicyShared, TargetName } from './types.ts';
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
}
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
  headerCounts?: Record<string, number> | undefined; trace?: RequestTrace | undefined; origin?: string | undefined; client?: string | undefined;
  /** The id the host answers this request with (`X-Request-Id`); generated when a caller supplies none. Reaches extension requests, hook contexts and function contexts. */
  requestId?: string | undefined;
}
export interface Runtime {
  readonly healthy: boolean; assetWatch: string[]; version: string; count: number; root: string;
  testPlan(): TestPlan;
  readonly plugins: { name: string; version: string }[];
  readonly workers: { healthy: number; slots: number };
  metrics(): MetricsSnapshot;
  errorHeaders(error: unknown, origin: string): HeaderPair[];
  requestLimit(target: string): number | undefined;
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
  const extensionPlan=prepareExtensions(loaded.document,loaded.routes,options.extensions,{origin:options.origin??'',origins,target:options.target??'node',projectSha256:snapshot.projectSha256,root:loaded.root},loaded.routeAuth);
  const bindings = await loadBindings(loaded.root, options.local, options.environment);
  const notFoundPage = loaded.document.site?.notFound !== undefined && loaded.document.site.notFound !== null;
  const compiled: CompiledRouteTable = await compileRoutes(loaded, bindings, options.grantDataDir ? withDataDirGrant(loaded, snapshot.projectSha256, options.permissions) : options.permissions, snapshot.projectSha256, options.extensions);
  const routes = [...compiled.mounts, ...compiled.exact.values(), ...[...compiled.byLength.values()].flat()];
  const assets = await compileAssets(loaded.root, routes);
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
  try{extensionRegistry=await extensionPlan.activate();}
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
  // Only an extension's own mount can serve its declared immutable assets.
  const assetPrefixes=new Map(routes.filter(route=>route.extension).map(route=>[route.pattern,extensionRegistry.entries.get(route.extension!)!.assetPrefixes]));
  const assetContext=(method:string,path:string,pattern:string):ExtensionAssetContext|undefined=>{const prefixes=assetPrefixes.get(pattern);return prefixes?.length?{method,path,prefixes}:undefined;};
  let active = 0, closing = false, finish: (() => void) | undefined;
  // Response phase: cache store, throttle headers, security headers,
  // compression, then operator plugins in reverse. A result produced by a
  // request-phase policy skips that policy's own response hook (a cache hit
  // is not stored twice) but still passes through the others (a hit still
  // carries the client's rate-limit headers; a denial is not stored because
  // its status is not cacheable). A plugin short-circuit ran before any
  // policy, so it skips every request-phase policy's response hook.
  async function finishPolicies(policy: PolicyChain | null | undefined, request: PolicyRequest, result: HandlerResult, producer?: PolicyModule | 'plugin'): Promise<HandlerResult> {
    const confidential=confidentialRoutes.has(request.route),asset=assetContext(request.method,request.path,request.route);
    let out = confidential?extensionResponse(result,asset):result;
    for (const [module, state] of policy?.response || []) {
      if(confidential&&module.name==='compression')continue;
      if (producer === 'plugin' ? module.onRequest : module === producer) continue;
      out = await module.onResponse?.(state, request, out) ?? out;
    }
    out=await pluginsResponse(plugins, request, out);
    return confidential?extensionResponse(out,asset):out;
  }
  function policyInventory(): Record<string, PolicyInventory> {
    return Object.fromEntries(routes.flatMap(route => route.policy && Object.keys(route.policy.describe).length ? [[route.pattern, route.policy.describe] as const] : []));
  }
  const workers = () => ({ healthy: pool.slots.filter(slot => slot?.ready).length, slots: pool.size });
  const testPlan = (): TestPlan => ({...projectPlan(compiled),policies:policyInventory()});
  try{await activatePlugins(plugins, { testPlan, version: loaded.version + assets.digest, root: loaded.root, target });}
  catch(error){await Promise.all([extensionRegistry.close(),signalBroker.close(),signalClient.close(),proxyClient.close(),pool.close(),closePolicies(shared),closePlugins(plugins),sink.close()]);throw error;}
  return {
    get healthy() { return !closing && pool.healthy; },
    assetWatch: assets.watch, version: loaded.version + assets.digest, count: compiled.count, root: loaded.root,
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
    requestLimit(target) {
      const match = matchRoute(compiled, parseTarget(target));
      return match?.route.request?.body?.maxBytes ?? (match?.route.proxy||match?.route.extension?1048576:undefined);
    },
    async handle({ target, method = 'GET', headers = new Headers(), body, headerCounts, trace = {}, origin = 'http://localhost', client, requestId = crypto.randomUUID() }) {
      if (closing) throw new HttpError(503, 'Runtime unavailable');
      assert(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 128, 'Request id must be a non-empty string of at most 128 characters');
      active++;
      let policyReq: PolicyRequest | undefined, policy: PolicyChain | null | undefined;
      try {
        const parsed = parseTarget(target);
        const match = matchRoute(compiled, parsed);
        if (!match) {
          // site.notFound: answer an unmatched GET/HEAD with the configured page and status 404.
          if (notFoundPage && (method === 'GET' || method === 'HEAD')) {
            const page = await (this as Runtime).handle({ target: '/404.html', method, headers, headerCounts, trace: {}, origin, requestId, ...(client ? { client } : {}) });
            return { ...page, status: 404 };
          }
          throw new HttpError(404, 'Not found');
        }
        const { route, path } = match;
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
        const extensionRequest:ExtensionRequest={method,target,path:parsed.path,query:new URLSearchParams(parsed.query),headers:stripReservedContextHeaders(new Headers(headers)),headerCounts:{...headerCounts},body:body??new Uint8Array(),origin:options.origin??origin,route:route.pattern,mount:route.extension?route.pattern.slice(0,-2):null,client:client??null,requestId,env:Object.freeze({...route.env})};
        if(protectedRoute&&(body?.byteLength??0)>Math.min(1048576,route.request?.body?.maxBytes??1048576))throw new HttpError(413,'Request body too large');
        const authorize=async():Promise<HandlerResult|undefined>=>{for(const name of route.extensionPolicyNames??[]){const entry=extensionRegistry.entries.get(name)!;if(typeof entry.instance.authorize!=='function')continue;const result=await entry.instance.authorize(entry.policies.get(route.pattern)!,extensionRequest);if(result)return result;}return undefined;};
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
          const refused: HandlerResult = { status: 405, headers: [['allow', route.methods.join(', ')]], body: Buffer.from('Method not allowed\n') };
          // Counted by throttle already, so it carries the budget headers and
          // the security profile like any other answer; nothing caches a 405.
          return policyReq ? await finishPolicies(policy, policyReq, refused) : refused;
        }
        checkRequest(route, body || Buffer.alloc(0), headers, headerCounts);
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
        // A declared schema default must not recreate a withheld header entry.
        for(const name of credentialHeaders)delete context.inputs.header[name];
        let native: HandlerResult | undefined;
        if(route.extension){native=extensionResponse(await extensionRegistry.entries.get(route.extension)!.instance.handle(extensionRequest),assetContext(method,parsed.path,route.pattern));}
        else if(route.compiledProxy){
          // Same credential-free projection a guest function receives: an
          // extension-declared credential header in requestHeaders must not
          // reach the upstream any more than it reaches a function's code.
          try {const result=await executeProxy(proxyClient,route.compiledProxy,{method,url:origin+target,params:path,headers:Object.fromEntries(guestHeaders),...(body?{body}:{})});native={status:result.status,headers:Object.entries(result.headers),body:result.body};}
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
            native = {status:error.status,headers:[['content-type','text/plain; charset=utf-8'],['cache-control','no-store']],body:Buffer.from(error.message+'\n')};
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
        return await finishResponse(await executor.execute(route, { url: origin + target, method, headers: [...guestHeaders], body }, context, native));
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
        if (policy !== undefined && error && typeof error === 'object') errorRoutes.set(error, policy);
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
      } finally { active--; if (!active && closing) finish?.(); }
    },
    async close() {
      closing = true;
      await Promise.all([signalBroker.close(),signalClient.close(),proxyClient.close()]);
      if (active) await new Promise<void>(resolve => { finish = resolve; });
      await pool.close();
      await trusted.close();
      await closePolicies(shared);
      await closePlugins(plugins);
      await extensionRegistry.close();
      await sink.close();
    },
  };
}
