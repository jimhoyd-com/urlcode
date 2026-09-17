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
  return {
    get healthy() { return !closing && pool.healthy && Object.values(stores).every(store=>(store.readHealthy??store.healthy)!==false); },
    assetWatch: assets.watch, version: loaded.version + assets.digest, count: compiled.count, root: loaded.root,
    testPlan() { return {...projectPlan(compiled),dynamicLinks}; },
    requestLimit(target) {
      const match = matchRoute(compiled, parseTarget(target));
      return match?.route.request?.body?.maxBytes;
    },
    async handle({ target, method = 'GET', headers = new Headers(), body, headerCounts, trace = {}, origin = 'http://localhost' }) {
      if (closing) throw new HttpError(503, 'Runtime unavailable');
      active++;
      try {
        const parsed = parseTarget(target);
        const match = matchRoute(compiled, parsed);
        if (!match) throw new HttpError(404, 'Not found');
        const { route, path } = match;
        // Configured pattern only; never the request path, query or parameter values.
        trace.route = route.pattern;
        if (route.enabled === false) throw new HttpError(404, 'Not found');
        if (route.expiresAt && Date.now() >= route.expiresAt) throw new HttpError(410, 'Gone');
        if (!route.methods.includes(method)) return { status: 405, headers: [['allow', route.methods.join(', ')]], body: Buffer.from('Method not allowed\n') };
        checkRequest(route, body || Buffer.alloc(0), headers, headerCounts);
        const finishResponse = result => decorateResponse(route,result);
        const context = contextFor(route, path, parsed.query, headers, headerCounts);
        let native;
        if (route.redirect) native = { status: route.redirect.status || 302,
          headers: [['location', redirectLocation(route, context, parsed.query)]], body: Buffer.alloc(0) };
        else if(route.link){
          let code;try{code=linkCode(resolveValue(route.link.code,context));}catch{throw new HttpError(404,'Link not found');}
          let record;
          try{record=await stores[route.link.collection].get(route.link.collection,code);}catch{throw new HttpError(503,'Link store unavailable');}
          if(!record)throw new HttpError(404,'Link not found');
          let data;try{data=linkData({url:record.url,status:record.status,enabled:record.enabled,expires:record.expires});}catch{throw new HttpError(503,'Invalid stored link');}
          if(!data.enabled)throw new HttpError(404,'Link not found');
          if(data.expires && Date.parse(data.expires)<=Date.now())throw new HttpError(410,'Link expired');
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
      } finally { active--; if (!active && closing) finish?.(); }
    },
    async close() {
      closing = true;
      if (active) await new Promise(resolve => { finish = resolve; });
      await pool.close();
      await ownedStore?.close();
    },
  };
}
