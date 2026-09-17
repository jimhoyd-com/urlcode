import { projectPlan } from './readiness.js';
import { checkRequest, decorateResponse } from './http-policy.js';
import { compileAssets, assetResponse } from './assets.js';
import { loadDocument, loadBindings } from './config.js';
import { compileRoutes, parseTarget, matchRoute, contextFor, resolveValue, redirectLocation } from './router.js';
import { FunctionPool } from './functions.js';
import { prepareFunctionSnapshot, validatePolicy } from './policy.js';
import {openLinkStore} from './link-store.js';
import {linkCode,linkData,linkCollection} from './link-records.js';
import {assert} from './errors.js';
import { HttpError } from './errors.js';
import { compilePolicies, closePolicies, policyRequest } from './policies.js';
import { validatePlugins, activatePlugins, pluginsRequest, pluginsResponse, pluginsError, closePlugins } from './plugins.js';

export async function createRuntime(project, options = {}) {
  const loaded = await loadDocument(project);
  const dynamicLinks=loaded.document.dynamicLinks===true;
  assert(dynamicLinks || (!options.linkStore && !Object.keys(options.linkStores||{}).length),'Link-store bindings require dynamicLinks: true in urlcode.yaml');
  const bindings = await loadBindings(loaded.root, options.local, options.environment);
  const snapshot = await prepareFunctionSnapshot(loaded);
  if (options.permissions) validatePolicy(options.permissions);
  const compiled = await compileRoutes(loaded, bindings, options.permissions, snapshot.projectSha256);
  const routes = [...compiled.mounts, ...compiled.exact.values(), ...[...compiled.byLength.values()].flat()];
  const assets = await compileAssets(loaded.root, routes);
  // Host policies compile after assets so a policy can see what a route serves
  // (precompressed variants, cacheability). Cross-request state lives in one
  // per-runtime object and is released with the runtime, never shared across
  // reloads: a new snapshot starts with empty counters and an empty cache.
  const target = options.target || 'node';
  const plugins = validatePlugins(options.plugins, target);
  const shared = { target, log: options.log, routes: routes.length };
  const anyPolicy = Boolean(loaded.document.policies) || routes.some(route => route.policies);
  for (const route of routes) route.policy = anyPolicy ? await compilePolicies(loaded.document, route, { route, shared, target, root: loaded.root }) : null;
  const stores = Object.assign(Object.create(null),options.linkStores);
  let ownedStore;
  try {
    if(options.linkStore){
      linkCollection(options.linkStore.collection);
      assert(!Object.hasOwn(stores,options.linkStore.collection), 'Duplicate link store binding');
      ownedStore=await openLinkStore({...options.linkStore,project:loaded.root,readOnly:true,log:options.log});
      stores[options.linkStore.collection]=ownedStore;
    }
    for(const route of routes)if(route.link)assert(Object.hasOwn(stores,route.link.collection) && typeof stores[route.link.collection]?.get==='function','Missing operator link store binding');
  }catch(error){await ownedStore?.close();throw error;}
  let pool;
  try{pool=await new FunctionPool(routes, { ...options, root:loaded.root, snapshot, log:options.log }).start();}
  catch(error){await ownedStore?.close();throw error;}
  let active = 0, closing = false, finish;
  // Response phase: cache store, security headers, compression, then operator
  // plugins in reverse. A result produced before the handler ran (a plugin
  // short-circuit, an agent denial, a budget refusal, a cache hit) skips the
  // response hooks of every policy that also has a request phase, so a denial
  // is never stored and a hit is never stored twice; headers and compression
  // still apply to it.
  async function finishPolicies(policy, request, result, early = false) {
    let out = result;
    for (const [module, state] of policy?.response || []) {
      if (early && module.onRequest) continue;
      out = await module.onResponse(state, request, out) ?? out;
    }
    return pluginsResponse(plugins, request, out);
  }
  function policyInventory() {
    return Object.fromEntries(routes.filter(route => route.policy).map(route => [route.pattern, route.policy.describe]));
  }
  await activatePlugins(plugins, { testPlan: () => ({...projectPlan(compiled),dynamicLinks,policies:policyInventory()}), version: loaded.version + assets.digest, root: loaded.root, target });
  return {
    get healthy() { return !closing && pool.healthy && Object.values(stores).every(store=>(store.readHealthy??store.healthy)!==false); },
    assetWatch: assets.watch, version: loaded.version + assets.digest, count: compiled.count, root: loaded.root,
    testPlan() { return {...projectPlan(compiled),dynamicLinks,policies:policyInventory()}; },
    get plugins() { return plugins.map(plugin => ({ name: plugin.name, version: plugin.version })); },
    requestLimit(target) {
      const match = matchRoute(compiled, parseTarget(target));
      return match?.route.request?.body?.maxBytes;
    },
    async handle({ target, method = 'GET', headers = new Headers(), body, headerCounts, trace = {}, origin = 'http://localhost', client }) {
      if (closing) throw new HttpError(503, 'Runtime unavailable');
      active++;
      let policyReq, policy;
      try {
        const parsed = parseTarget(target);
        const match = matchRoute(compiled, parsed);
        if (!match) throw new HttpError(404, 'Not found');
        const { route, path } = match;
        // Configured pattern only; never the request path, query or parameter values.
        trace.route = route.pattern;
        if (route.enabled === false) throw new HttpError(404, 'Not found');
        if (route.expiresAt && Date.now() >= route.expiresAt) throw new HttpError(410, 'Gone');
        // Host policies and plugins run once the route is known and before
        // its contract is checked: a denied agent or an exhausted budget is
        // answered without reading a body or touching the sandbox.
        policy = route.policy;
        if (policy || plugins.length) {
          policyReq = policyRequest({ method, target, path: parsed.path, params: path, query: parsed.query, headers, headerCounts, client, origin, route });
          trace.client = policyReq.client;
          const early = await pluginsRequest(plugins, policyReq);
          if (early) return await finishPolicies(policy, policyReq, early, true);
          for (const [module, state] of policy?.request || []) {
            const result = await module.onRequest(state, policyReq);
            if (result) return await finishPolicies(policy, policyReq, result, true);
          }
        }
        if (!route.methods.includes(method)) return { status: 405, headers: [['allow', route.methods.join(', ')]], body: Buffer.from('Method not allowed\n') };
        checkRequest(route, body || Buffer.alloc(0), headers, headerCounts);
        const finishResponse = async result => policyReq ? finishPolicies(policy, policyReq, decorateResponse(route,result)) : decorateResponse(route,result);
        const context = contextFor(route, path, parsed.query, headers, headerCounts);
        let native;
        if (route.redirect) native = { status: route.redirect.status || 302,
          headers: [['location', redirectLocation(route, context, parsed.query)]], body: Buffer.alloc(0) };
        else if(route.link){
          // Resolution outcome for a trusted post-response observer. It records
          // why this request ended the way it did; the caller decides whether a
          // finished response is ever reported, and never sees stored data.
          const collection=route.link.collection;
          const observed=trace.link={collection,code:null,result:'invalid_code'};
          let code;try{code=linkCode(resolveValue(route.link.code,context));}catch{throw new HttpError(404,'Link not found');}
          observed.code=code;observed.result='missing';
          let record;
          try{record=await stores[collection].get(collection,code);}catch{observed.result='unavailable';throw new HttpError(503,'Link store unavailable');}
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
        if (policyReq) {
          for (const [module, state] of policy?.error || []) { try { module.onError(state, policyReq, error); } catch { /* observers cannot change the outcome */ } }
          await pluginsError(plugins, policyReq, error);
        }
        throw error;
      } finally { active--; if (!active && closing) finish?.(); }
    },
    async close() {
      closing = true;
      if (active) await new Promise(resolve => { finish = resolve; });
      await pool.close();
      await ownedStore?.close();
      await closePolicies(shared);
      await closePlugins(plugins);
    },
  };
}
