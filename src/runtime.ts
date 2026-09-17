import { analyzeProjectCapabilities, assertTargetCompatibility } from './capabilities.ts';
import { projectPlan, hasRedirect } from './readiness.ts';
import type { ProjectPlan } from './readiness.ts';
import { checkRequest, decorateResponse } from './http-policy.ts';
import { compileAssets, assetResponse } from './assets.ts';
import { loadDocument, loadBindings } from './config.ts';
import { compileRoutes, parseTarget, matchRoute, contextFor, resolveValue, redirectLocation } from './router.ts';
import { FunctionPool } from './functions.ts';
import type { FunctionContext } from './functions.ts';
import { prepareFunctionSnapshot, validatePolicy } from './policy.ts';
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
  const bindings = await loadBindings(loaded.root, options.local, options.environment);
  const snapshot = await prepareFunctionSnapshot(loaded);
  if (options.permissions) validatePolicy(options.permissions);
  const compiled: CompiledRouteTable = await compileRoutes(loaded, bindings, options.permissions, snapshot.projectSha256);
  const routes = [...compiled.mounts, ...compiled.exact.values(), ...[...compiled.byLength.values()].flat()];
  const assets = await compileAssets(loaded.root, routes);
  // Host policies compile after assets so a policy can see what a route serves
  // (precompressed variants, cacheability). Cross-request state lives in one
  // per-runtime object and is released with the runtime, never shared across
  // reloads: a new snapshot starts with empty counters and an empty cache.
  const target = options.target || 'node';
  const plugins = validatePlugins(options.plugins, target);
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
  let active = 0, closing = false, finish: (() => void) | undefined;
  // Response phase: cache store, throttle headers, security headers,
  // compression, then operator plugins in reverse. A result produced by a
  // request-phase policy skips that policy's own response hook (a cache hit
  // is not stored twice) but still passes through the others (a hit still
  // carries the client's rate-limit headers; a denial is not stored because
  // its status is not cacheable). A plugin short-circuit ran before any
  // policy, so it skips every request-phase policy's response hook.
  async function finishPolicies(policy: PolicyChain | null | undefined, request: PolicyRequest, result: HandlerResult, producer?: PolicyModule | 'plugin'): Promise<HandlerResult> {
    let out = result;
    for (const [module, state] of policy?.response || []) {
      if (producer === 'plugin' ? module.onRequest : module === producer) continue;
      out = await module.onResponse?.(state, request, out) ?? out;
    }
    return pluginsResponse(plugins, request, out);
  }
  function policyInventory(): Record<string, PolicyInventory> {
    return Object.fromEntries(routes.flatMap(route => route.policy && Object.keys(route.policy.describe).length ? [[route.pattern, route.policy.describe] as const] : []));
  }
  const workers = () => ({ healthy: pool.slots.filter(slot => slot?.ready).length, slots: pool.size });
  const testPlan = (): TestPlan => ({...projectPlan(compiled),dynamicLinks,policies:policyInventory()});
  await activatePlugins(plugins, { testPlan, version: loaded.version + assets.digest, root: loaded.root, target });
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
      return match?.route.request?.body?.maxBytes;
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
        if (route.enabled === false) throw new HttpError(404, 'Not found');
        if (route.expiresAt && Date.now() >= route.expiresAt) throw new HttpError(410, 'Gone');
        // Host policies and plugins run once the route is known and before
        // its contract is checked: a denied agent or an exhausted budget is
        // answered without reading a body or touching the sandbox.
        if (policy || plugins.length) {
          policyReq = policyRequest({ method, target, path: parsed.path, params: path, query: parsed.query, headers, headerCounts, client, origin, route });
          trace.client = policyReq.client;
          const early = await pluginsRequest(plugins, policyReq);
          if (early) return await finishPolicies(policy, policyReq, early, 'plugin');
          for (const [module, state] of policy?.request || []) {
            const result = await module.onRequest?.(state, policyReq);
            if (result) return await finishPolicies(policy, policyReq, result, module);
          }
        }
        if (!route.methods.includes(method)) {
          const refused: HandlerResult = { status: 405, headers: [['allow', route.methods.join(', ')]], body: Buffer.from('Method not allowed\n') };
          // Counted by throttle already, so it carries the budget headers and
          // the security profile like any other answer; nothing caches a 405.
          return policyReq ? await finishPolicies(policy, policyReq, refused) : refused;
        }
        checkRequest(route, body || Buffer.alloc(0), headers, headerCounts);
        const finishResponse = async (result: HandlerResult) => policyReq ? finishPolicies(policy, policyReq, decorateResponse(route,result)) : decorateResponse(route,result);
        const context: FunctionContext = contextFor(route, path, parsed.query, headers, headerCounts);
        let native: HandlerResult | undefined;
        if (hasRedirect(route)) native = { status: route.redirect.status || 302,
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
        if (native && !route.middleware.length) return finishResponse(native);
        context.args = Object.fromEntries(Object.entries(route.function?.args || {}).map(([key, ref]) => [key, resolveValue(ref, context)]));
        return finishResponse(await pool.execute(route, { url: origin + target, method, headers: [...headers], body }, context, native));
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
      if (active) await new Promise<void>(resolve => { finish = resolve; });
      await pool.close();
      await ownedStore?.close();
      await closePolicies(shared);
      await closePlugins(plugins);
      await sink.close();
    },
  };
}
