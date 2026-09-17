import { prepareExtensions, effectiveExtensionPolicies, hasExtensionPolicy, extensionResponse } from './extensions.ts';
import type { RuntimeExtension, ExtensionRegistry, ExtensionRequest } from './extensions.ts';
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
import { prepareFunctionSnapshot, validatePolicy, authorizeEgress } from './policy.ts';
import type { OperatorPolicy } from './policy.ts';
import {openLinkStore} from './link-store.ts';
import type {LinkStore,LinkStoreOptions} from './link-store.ts';
import {linkCode,linkData,linkCollection} from './link-records.ts';
import {assert} from './errors.ts';
import { HttpError } from './errors.ts';
import { compilePolicies, closePolicies, policyRequest, compileErrorPolicy, errorHeaders } from './policies.ts';
import { validatePlugins, activatePlugins, pluginsRequest, pluginsResponse, pluginsError, closePlugins } from './plugins.ts';
import type { Plugin } from './plugins.ts';
import { createObserverSink } from './observability.ts';
import type { MetricsSnapshot, Observer, ObserverSink } from './observability.ts';
import { applySite } from './site.ts';
import type { HandlerResult, HeaderPair } from './http-response.ts';
import type { CompiledRouteTable, LogFn, PolicyChain, PolicyInventory, PolicyModule, PolicyRequest, PolicyShared, TargetName } from './types.ts';
import type { SecurityState } from './policies/security.ts';

/** A stored link as a link store returns it; the runtime validates the fields it uses. */
export interface LinkLookup { url?: unknown; status?: unknown; enabled?: unknown; expires?: unknown }
/** What a `linkStores` binding must provide: a reader and, optionally, its health. */
export interface LinkReader { get(collection: string, code: string): Promise<LinkLookup | null | undefined>; readonly readHealthy?: boolean; readonly healthy?: boolean }
/** An operator-owned SQLite link store the runtime opens read-only for one collection. */
export interface LinkStoreBinding extends LinkStoreOptions { collection: string }
export type { OperatorPolicy } from './policy.ts';
/** An operator plugin (src/plugins.ts). */
export type HostPlugin = Plugin;
export type { Observer, MetricsSnapshot } from './observability.ts';
export interface TestPlan extends ProjectPlan { dynamicLinks: boolean; policies: Record<string, PolicyInventory> }
export interface RuntimeOptions {
  extensions?: RuntimeExtension[] | undefined;
  /** Trusted host transport injection; never supplied by project YAML or guest code. */
  egressDependencies?: EgressDependencies;
  observers?: Observer[] | undefined; log?: LogFn | undefined; origin?: string | undefined; local?: boolean | undefined;
  environment?: NodeJS.ProcessEnv | undefined; permissions?: OperatorPolicy | undefined;
  linkStore?: LinkStoreBinding | undefined; linkStores?: Record<string, LinkReader> | undefined;
  target?: TargetName | undefined; plugins?: HostPlugin[] | undefined;
  workers?: number | undefined; timeoutMs?: number | undefined; maxBytes?: number | undefined;
}
/** Per-request facts the host may read after handle() settles; never request text. */
export interface LinkTrace { collection: string; code: string | null; result: string }
export interface RequestTrace { route?: string; probe?: boolean; client?: string | null; link?: LinkTrace }
export interface RuntimeRequest {
  target: string; method?: string | undefined; headers?: Headers | undefined; body?: Uint8Array | undefined;
  headerCounts?: Record<string, number> | undefined; trace?: RequestTrace | undefined; origin?: string | undefined; client?: string | undefined;
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
  const loaded = await loadDocument(project);
  // Site conventions become ordinary routes before compilation; a declared
  // route at the same path wins. The public origin, when the server knows
  // it, is what absolute URLs in generated files are built from.
  await applySite(loaded, { origin: options.origin, log: options.log });
  assertTargetCompatibility(analyzeProjectCapabilities(loaded, options.target || 'node'));
  const dynamicLinks=loaded.document.dynamicLinks===true;
  assert(dynamicLinks || (!options.linkStore && !Object.keys(options.linkStores||{}).length),'Link-store bindings require dynamicLinks: true in urlcode.yaml');
  const snapshot = await prepareFunctionSnapshot(loaded);
  if (options.permissions) validatePolicy(options.permissions);
  const egressGrants=authorizeEgress(loaded,snapshot.projectSha256,options.permissions);
  const extensionPlan=prepareExtensions(loaded.document,loaded.routes,options.extensions,{origin:options.origin??'',target:options.target??'node',projectSha256:snapshot.projectSha256});
  const bindings = await loadBindings(loaded.root, options.local, options.environment);
  const compiled: CompiledRouteTable = await compileRoutes(loaded, bindings, options.permissions, snapshot.projectSha256);
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
  const stores: Record<string, LinkReader> = Object.assign(Object.create(null) as Record<string, LinkReader>,options.linkStores);
  let ownedStore: LinkStore | undefined;
  try {
    if(options.linkStore){
      linkCollection(options.linkStore.collection);
      assert(!Object.hasOwn(stores,options.linkStore.collection), 'Duplicate link store binding');
      ownedStore=await openLinkStore({...options.linkStore,project:loaded.root,readOnly:true,log:options.log});
      stores[options.linkStore.collection]=ownedStore;
    }
    for(const route of routes)if(route.link)assert(Object.hasOwn(stores,route.link.collection) && typeof stores[route.link.collection]?.get==='function','Missing operator link store binding');
  }catch(error){await ownedStore?.close();throw error;}
  let pool: FunctionPool;
  try{pool=await new FunctionPool(routes, { root:loaded.root, snapshot, log:options.log, workers:options.workers, timeoutMs:options.timeoutMs, maxBytes:options.maxBytes }).start();}
  catch(error){await ownedStore?.close();throw error;}
  const proxyClient=new EgressClient({grantOrigins:egressGrants.proxy},options.egressDependencies);
  const signalClient=new EgressClient({grantOrigins:egressGrants.signals,concurrency:8},options.egressDependencies);
  let lastSignals={accepted:0,delivered:0,failed:0,dropped:0};
  const signalBroker=new SignalBroker(signalClient,8,stats=>{for(const outcome of ['accepted','delivered','failed','dropped'] as const){const count=stats[outcome]-lastSignals[outcome];if(count)sink({event:'signal',outcome,count});}lastSignals=stats;});
  let extensionRegistry:ExtensionRegistry;
  try{extensionRegistry=await extensionPlan.activate();}
  catch(error){await pool.close();await ownedStore?.close();await closePolicies(shared);await proxyClient.close();await signalClient.close();throw error;}
  for(const name of extensionRegistry.credentialHeaders)credentialHeaders.add(name);
  for(const route of routes)route.extensionPolicyNames=Object.keys(effectiveExtensionPolicies(loaded.document,route));
  const privateRoutes=new Set(routes.filter(route=>route.extension||hasExtensionPolicy(loaded.document,route)).map(route=>route.pattern));
  let active = 0, closing = false, finish: (() => void) | undefined;
  // Response phase: cache store, throttle headers, security headers,
  // compression, then operator plugins in reverse. A result produced by a
  // request-phase policy skips that policy's own response hook (a cache hit
  // is not stored twice) but still passes through the others (a hit still
  // carries the client's rate-limit headers; a denial is not stored because
  // its status is not cacheable). A plugin short-circuit ran before any
  // policy, so it skips every request-phase policy's response hook.
  async function finishPolicies(policy: PolicyChain | null | undefined, request: PolicyRequest, result: HandlerResult, producer?: PolicyModule | 'plugin'): Promise<HandlerResult> {
    const confidential=privateRoutes.has(request.route);
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
  const testPlan = (): TestPlan => ({...projectPlan(compiled),dynamicLinks,policies:policyInventory()});
  try{await activatePlugins(plugins, { testPlan, version: loaded.version + assets.digest, root: loaded.root, target });}
  catch(error){await Promise.all([extensionRegistry.close(),signalBroker.close(),signalClient.close(),proxyClient.close(),pool.close(),ownedStore?.close(),closePolicies(shared),closePlugins(plugins),sink.close()]);throw error;}
  return {
    get healthy() { return !closing && pool.healthy && Object.values(stores).every(store=>(store.readHealthy??store.healthy)!==false); },
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
    async handle({ target, method = 'GET', headers = new Headers(), body, headerCounts, trace = {}, origin = 'http://localhost', client }) {
      if (closing) throw new HttpError(503, 'Runtime unavailable');
      active++;
      let policyReq: PolicyRequest | undefined, policy: PolicyChain | null | undefined;
      try {
        const parsed = parseTarget(target);
        const match = matchRoute(compiled, parsed);
        if (!match) throw new HttpError(404, 'Not found');
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
        const extensionRequest:ExtensionRequest={method,target,path:parsed.path,query:new URLSearchParams(parsed.query),headers:new Headers(headers),headerCounts:{...headerCounts},body:body??new Uint8Array(),origin:options.origin??origin,route:route.pattern,mount:route.extension?route.pattern.slice(0,-2):null,client:client??null};
        if(protectedRoute&&(body?.byteLength??0)>Math.min(1048576,route.request?.body?.maxBytes??1048576))throw new HttpError(413,'Request body too large');
        const authorize=async():Promise<HandlerResult|undefined>=>{for(const name of Object.keys(effectiveExtensionPolicies(loaded.document,route))){const entry=extensionRegistry.entries.get(name)!;const result=await entry.instance.authorize!(entry.policies.get(route.pattern)!,extensionRequest);if(result)return result;}return undefined;};
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
        // inputs and the guest receive a separate, credential-free projection.
        const guestHeaders=credentialHeaders.size?new Headers(headers):headers;
        for(const name of credentialHeaders)guestHeaders.delete(name);
        const context: FunctionContext = contextFor(route, path, parsed.query, guestHeaders, headerCounts);
        // A declared schema default must not recreate a withheld header entry.
        for(const name of credentialHeaders)delete context.inputs.header[name];

        let native: HandlerResult | undefined;
        if(route.extension){native=extensionResponse(await extensionRegistry.entries.get(route.extension)!.instance.handle(extensionRequest));}
        else if(route.compiledProxy){
          try {const result=await executeProxy(proxyClient,route.compiledProxy,{method,url:origin+target,params:path,headers:Object.fromEntries(headers),...(body?{body}:{})});native={status:result.status,headers:Object.entries(result.headers),body:result.body};}
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
        else if(route.link){
          // Resolution outcome for a trusted post-response observer. It records
          // why this request ended the way it did; the caller decides whether a
          // finished response is ever reported, and never sees stored data.
          const collection=route.link.collection;
          const observed: LinkTrace=trace.link={collection,code:null,result:'invalid_code'};
          let code: string;try{code=linkCode(resolveValue(route.link.code,context));}catch{throw new HttpError(404,'Link not found');}
          observed.code=code;observed.result='missing';
          let record: LinkLookup|null|undefined;
          try{const store=stores[collection];assert(store,'Missing operator link store binding');record=await store.get(collection,code);}catch{observed.result='unavailable';throw new HttpError(503,'Link store unavailable');}
          if(!record)throw new HttpError(404,'Link not found');
          let data;try{data=linkData({url:record.url,status:record.status,enabled:record.enabled,expires:record.expires});}catch{observed.result='invalid_record';throw new HttpError(503,'Invalid stored link');}
          if(!data.enabled){observed.result='disabled';throw new HttpError(404,'Link not found');}
          if(data.expires && Date.parse(data.expires)<=Date.now()){observed.result='expired';throw new HttpError(410,'Link expired');}
          observed.result='redirect';
          native={status:data.status,headers:[['location',data.url],['cache-control','no-store']],body:Buffer.alloc(0)};
        }
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
        return await finishResponse(await pool.execute(route, { url: origin + target, method, headers: [...guestHeaders], body }, context, native));
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
      await ownedStore?.close();
      await closePolicies(shared);
      await closePlugins(plugins);
      await extensionRegistry.close();
      await sink.close();
    },
  };
}
