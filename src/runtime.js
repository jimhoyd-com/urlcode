import { checkRequest, decorateResponse } from './http-policy.js';
import { compileAssets, assetResponse } from './assets.js';
import { loadDocument, loadBindings } from './config.js';
import { compileRoutes, parseTarget, matchRoute, contextFor, resolveValue, redirectLocation } from './router.js';
import { FunctionPool } from './functions.js';
import { prepareFunctionSnapshot, validatePolicy } from './policy.js';
import { HttpError } from './errors.js';

export async function createRuntime(project, options = {}) {
  const loaded = await loadDocument(project);
  const bindings = await loadBindings(loaded.root, options.local, options.environment);
  const snapshot = await prepareFunctionSnapshot(loaded);
  if (options.permissions) validatePolicy(options.permissions);
  const compiled = await compileRoutes(loaded, bindings, options.permissions, snapshot.projectSha256);
  const routes = [...compiled.mounts, ...compiled.exact.values(), ...[...compiled.byLength.values()].flat()];
  const assets = await compileAssets(loaded.root, routes);
  const pool = await new FunctionPool(routes, { ...options, root:loaded.root, snapshot }).start();
  let active = 0, closing = false, finish;
  return {
    get healthy() { return !closing && pool.healthy; },
    assetWatch: assets.watch, version: loaded.version + assets.digest, count: compiled.count, root: loaded.root,
    requestLimit(target) {
      const match = matchRoute(compiled, parseTarget(target));
      return match?.route.request?.body?.maxBytes;
    },
    async handle({ target, method = 'GET', headers = new Headers(), body, headerCounts, origin = 'http://localhost' }) {
      if (closing) throw new HttpError(503, 'Runtime unavailable');
      active++;
      try {
        const parsed = parseTarget(target);
        const match = matchRoute(compiled, parsed);
        if (!match) throw new HttpError(404, 'Not found');
        const { route, path } = match;
        if (route.enabled === false) throw new HttpError(404, 'Not found');
        if (route.expiresAt && Date.now() >= route.expiresAt) throw new HttpError(410, 'Gone');
        if (!route.methods.includes(method)) return { status: 405, headers: [['allow', route.methods.join(', ')]], body: Buffer.from('Method not allowed\n') };
        checkRequest(route, body || Buffer.alloc(0), headers, headerCounts);
        const finishResponse = result => decorateResponse(route,result);
        const context = contextFor(route, path, parsed.query, headers, headerCounts);
        if (route.redirect) return finishResponse({ status: route.redirect.status || 302,
          headers: [['location', redirectLocation(route, context, parsed.query)]], body: Buffer.alloc(0) });
        if (route.reply) return finishResponse(route.reply);
        if (route.asset) return finishResponse(assetResponse(route, parsed.path, method, headers));
        context.args = Object.fromEntries(Object.entries(route.function.args || {}).map(([key, ref]) => [key, resolveValue(ref, context)]));
        return finishResponse(await pool.execute(route, { url: origin + target, method, headers: [...headers], body }, context));
      } finally { active--; if (!active && closing) finish?.(); }
    },
    async close() {
      closing = true;
      if (active) await new Promise(resolve => { finish = resolve; });
      await pool.close();
    },
  };
}
