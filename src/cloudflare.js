import { parseTarget, matchRoute, contextFor, redirectLocation } from './match.js';
import { checkRequest, decorateResponse } from './http-policy.js';
import { prepareResponse } from './http-response.js';
import { HttpError } from './errors.js';
// Only the two policies a Worker can carry. Both modules must stay free of
// Node imports; the build refuses every other policy with the route named.
import * as agents from './policies/agents.js';
import * as security from './policies/security.js';
const compilable = { agents, security };

// A Web-standard runtime for a compiled artifact. It shares the matching,
// request policy and response policy of every other host; only the transport
// differs. Nothing here touches the filesystem, a worker thread or a Node
// built-in, because the platform this targets has none of them.
const encoder = new TextEncoder();

// The artifact stores what the compiler produced; validators arrive separately
// because a schema validator cannot be serialised and this platform forbids
// compiling one at runtime.
export function rehydrate(artifact, validators = {}) {
  if (artifact?.format !== 1) throw new Error('Unsupported URLCode artifact; rebuild with this runtime version');
  const exact = new Map(), byLength = new Map(), shared = { target: 'cloudflare' };
  for (const route of artifact.routes) {
    const prepared = { ...route,
      parameters: (route.parameters || []).map(parameter => {
        const validate = validators[parameter.validator];
        if (!validate) throw new Error(`Artifact is missing the validator for ${route.pattern} ${parameter.in}:${parameter.name}`);
        return { ...parameter, validate };
      }),
      reply: route.reply ? { ...route.reply, body: encoder.encode(route.reply.body) } : undefined,
      // Declarative routes carry no bindings; the artifact refuses to hold one.
      env: Object.create(null), secrets: Object.create(null), middleware: [],
    };
    // The artifact carries the effective policy configuration the build
    // validated; compile is synchronous for these modules by contract.
    prepared.policy = null;
    if (route.policies) {
      const chain = { request: [], response: [] };
      for (const [name, config] of Object.entries(route.policies)) {
        const module = compilable[name];
        if (!module) throw new Error(`Artifact carries policies.${name}, which this target cannot enforce; rebuild`);
        const state = module.compile(config, { route: prepared, shared, target: 'cloudflare' });
        if (state instanceof Promise) throw new Error(`policies.${name} compile must be synchronous on this target`);
        if (module.onRequest) chain.request.push([module, state]);
        if (module.onResponse) chain.response.push([module, state]);
      }
      prepared.policy = chain;
    }
    if (!prepared.names.length) exact.set(prepared.pattern, prepared);
    else {
      if (!byLength.has(prepared.parts.length)) byLength.set(prepared.parts.length, []);
      byLength.get(prepared.parts.length).push(prepared);
    }
  }
  // Compiled order is preserved: the artifact is emitted most specific first.
  return { exact, byLength, mounts: [] };
}

export function createFetchHandler(artifact, validators) {
  const compiled = rehydrate(artifact, validators);
  return async function fetch(request) {
    const requestId = crypto.randomUUID();
    const method = request.method;
    try {
      const url = new URL(request.url);
      const parsed = parseTarget(url.pathname + url.search);
      const match = matchRoute(compiled, parsed);
      if (!match) throw new HttpError(404, 'Not found');
      const { route, path } = match;
      if (route.enabled === false) throw new HttpError(404, 'Not found');
      if (route.expiresAt && Date.now() >= route.expiresAt) throw new HttpError(410, 'Gone');
      // Same request shape and order as the Node runtime; the client identity
      // is the platform's connecting address, never a client-supplied header.
      const policyReq = route.policy ? { method, target: url.pathname + url.search, path: parsed.path, query: parsed.query, headers: request.headers,
        headerCounts: {}, params: path, client: request.headers.get('cf-connecting-ip') ?? null, origin: url.origin, route: route.pattern, secrets: false } : null;
      const finish = async (result, early) => {
        let out = result;
        for (const [module, state] of route.policy?.response || []) { if (early && module.onRequest) continue; out = await module.onResponse(state, policyReq, out) ?? out; }
        return out;
      };
      for (const [module, state] of route.policy?.request || []) {
        const denied = await module.onRequest(state, policyReq);
        if (denied) return respond(prepareResponse(await finish(denied, true), { requestId, method }), requestId, method);
      }
      if (!route.methods.includes(method)) {
        // The same response policy as every other host: 405 skips the route's
        // configured response headers but still gets length, nosniff and id.
        return respond(prepareResponse({ status:405, headers:[['allow',route.methods.join(', ')]],
          body: encoder.encode('Method not allowed\n') }, { requestId, method }), requestId, method);
      }
      const body = route.request?.body
        ? new Uint8Array(await request.arrayBuffer())
        : new Uint8Array(0);
      // Duplicate request headers are joined by the platform before this runs,
      // so per-header counts are unavailable and the duplicate-scalar check
      // cannot fire here. docs/CLOUDFLARE.md records the difference.
      checkRequest(route, body, request.headers, {});
      const context = contextFor(route, path, parsed.query, request.headers, {});
      const native = route.redirect
        ? { status: route.redirect.status || 302, headers:[['location',redirectLocation(route, context, parsed.query)]], body: new Uint8Array(0) }
        : { ...route.reply };
      return respond(prepareResponse(await finish(decorateResponse(route, native), false), { requestId, method }), requestId, method);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!(error instanceof HttpError)) console.error(error);
      return respond({ status,
        headers: [['content-type','text/plain; charset=utf-8'],['cache-control','no-store'],
          ['x-request-id',requestId],['x-content-type-options','nosniff']],
        cookies: [],
        body: encoder.encode(`${error instanceof HttpError ? error.message : 'Internal server error'}\n`) }, requestId, method);
    }
  };
}

function respond(prepared, requestId, method) {
  const headers = new Headers();
  for (const [key,value] of prepared.headers) headers.append(key, value);
  for (const cookie of prepared.cookies ?? []) headers.append('set-cookie', cookie);
  if (!headers.has('x-request-id')) headers.set('x-request-id', requestId);
  const empty = method === 'HEAD' || [204,205,304].includes(prepared.status);
  return new Response(empty ? null : (prepared.body ?? new Uint8Array(0)), { status: prepared.status, headers });
}
