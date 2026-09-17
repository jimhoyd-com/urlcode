import { parseTarget, matchRoute, contextFor, redirectLocation } from './match.ts';
import type { CompiledParameter, CompiledRoutes, MatchableRoute, ParameterLocation, ParameterSchema } from './match.ts';
import { checkRequest, decorateResponse } from './http-policy.ts';
import type { RequestBodyPolicy } from './http-policy.ts';
import { prepareResponse, errorResponse } from './http-response.ts';
import type { HandlerResult, HeaderPair, ResponseBody } from './http-response.ts';
import { HttpError } from './errors.ts';
// Only the two policies a Worker can carry. Both modules must stay free of
// Node imports; the build refuses every other policy with the route named.
import * as agents from './policies/agents.ts';
import * as security from './policies/security.ts';
import type { AgentsConfig, AgentsState } from './policies/agents.ts';
import type { SecurityConfig, SecurityState } from './policies/security.ts';
import type { CompiledRedirect, PolicyModule, PolicyRequest, PolicyShared } from './types.ts';

// The artifact `urlcode build --target cloudflare` writes. Its shape is this
// runtime's own output, not a published contract (see build-cloudflare.ts).
export interface ArtifactParameter { name: string; in: ParameterLocation; required: boolean; schema: ParameterSchema; validator: string }
export interface ArtifactReply { status: number; headers: HeaderPair[]; body: string }
export interface ArtifactRoute {
  pattern: string; parts: string[]; names: string[]; methods: string[]; parameters: ArtifactParameter[]; responseHeaders: HeaderPair[];
  request?: { body?: RequestBodyPolicy }; redirect?: CompiledRedirect; reply?: ArtifactReply; enabled?: false; expiresAt?: number;
  policies?: Record<string, unknown>;
}
export interface Artifact { format: number; version: string; routes: ArtifactRoute[]; policies?: { security: SecurityConfig } }
export type Validator = (value: unknown) => boolean;
export type Validators = Record<string, Validator | undefined>;
/** A route's compiled policy chain on this target: the same hook pairs the Node runtime holds. */
export interface WorkerPolicy { request: [PolicyModule, unknown][]; response: [PolicyModule, unknown][]; security?: SecurityState; agents?: AgentsState }
/** A rehydrated route: MatchableRoute plus what the request path reads. The reply body is bytes, not a Buffer. */
export interface WorkerRoute extends MatchableRoute {
  names: string[]; methods: string[]; responseHeaders: HeaderPair[]; request?: { body?: RequestBodyPolicy }; redirect?: CompiledRedirect;
  reply: { status: number; headers: HeaderPair[]; body: Uint8Array<ArrayBuffer> } | undefined; enabled?: false; expiresAt?: number;
  middleware: never[]; policy: WorkerPolicy | null;
}
export interface RehydratedArtifact extends CompiledRoutes<WorkerRoute> { errorPolicy: SecurityState | null }
// A Web-standard runtime for a compiled artifact. It shares the matching,
// request policy and response policy of every other host; only the transport
// differs. Nothing here touches the filesystem, a worker thread or a Node
// built-in, because the platform this targets has none of them.
const encoder = new TextEncoder();
const dict = <T,>(): Record<string, T> => Object.create(null) as Record<string, T>;
const redirecting = (route: WorkerRoute): route is WorkerRoute & { redirect: CompiledRedirect } => Boolean(route.redirect);

// The artifact stores what the compiler produced; validators arrive separately
// because a schema validator cannot be serialised and this platform forbids
// compiling one at runtime.
export function rehydrate(artifact: Artifact, validators: Validators = {}): RehydratedArtifact {
  if (artifact?.format !== 1) throw new Error('Unsupported URLCode artifact; rebuild with this runtime version');
  const exact = new Map<string, WorkerRoute>(), byLength = new Map<number, WorkerRoute[]>(), shared: PolicyShared = { target: 'cloudflare' };
  for (const route of artifact.routes) {
    const prepared: WorkerRoute = { ...route,
      parameters: (route.parameters || []).map((parameter): CompiledParameter => {
        const validate = validators[parameter.validator];
        if (!validate) throw new Error(`Artifact is missing the validator for ${route.pattern} ${parameter.in}:${parameter.name}`);
        return { ...parameter, validate };
      }),
      reply: route.reply ? { ...route.reply, body: encoder.encode(route.reply.body) } : undefined,
      // Declarative routes carry no bindings; the artifact refuses to hold one.
      env: dict(), secrets: dict(), middleware: [],
      // The artifact carries the effective policy configuration the build
      // validated; compile is synchronous for these modules by contract.
      policy: null,
    };
    if (route.policies) {
      const chain: WorkerPolicy = { request: [], response: [] };
      for (const [name, config] of Object.entries(route.policies)) {
        const context = { route: prepared, shared, target: 'cloudflare' };
        if (name === 'agents') {
          const state = agents.compile(config as AgentsConfig, context); // trust boundary: the build validated this configuration
          if (state instanceof Promise) throw new Error(`policies.${name} compile must be synchronous on this target`);
          chain.request.push([agents, state]); chain.agents = state;
        } else if (name === 'security') {
          const state = security.compile(config, context);
          chain.response.push([security, state]); chain.security = state;
        } else throw new Error(`Artifact carries policies.${name}, which this target cannot enforce; rebuild`);
      }
      prepared.policy = chain;
    }
    if (!prepared.names.length) exact.set(prepared.pattern, prepared);
    else {
      let group = byLength.get(prepared.parts.length);
      if (!group) { group = []; byLength.set(prepared.parts.length, group); }
      group.push(prepared);
    }
  }
  // Project-level security for answers that matched no route or threw.
  const projectContext = { route: { pattern: '(project)' }, shared, target: 'cloudflare' };
  const errorPolicy = artifact.policies?.security ? security.compile(artifact.policies.security, projectContext) : null;
  // Compiled order is preserved: the artifact is emitted most specific first.
  return { exact, byLength, mounts: [], errorPolicy };
}

export function createFetchHandler(artifact: Artifact, validators?: Validators): (request: Request) => Promise<Response> {
  const compiled = rehydrate(artifact, validators);
  return async function fetch(request: Request): Promise<Response> {
    const requestId = crypto.randomUUID();
    const method = request.method;
    let matched: WorkerRoute | undefined, origin = 'http://localhost';
    try {
      const url = new URL(request.url);
      origin = url.origin;
      const parsed = parseTarget(url.pathname + url.search);
      const match = matchRoute(compiled, parsed);
      if (!match) throw new HttpError(404, 'Not found');
      const { route, path } = match;
      matched = route;
      if (route.enabled === false) throw new HttpError(404, 'Not found');
      if (route.expiresAt && Date.now() >= route.expiresAt) throw new HttpError(410, 'Gone');
      // Same request shape and order as the Node runtime; the client identity
      // is the platform's connecting address, never a client-supplied header.
      const policyReq: PolicyRequest | null = route.policy ? { method, target: url.pathname + url.search, path: parsed.path, query: parsed.query, headers: request.headers,
        headerCounts: {}, params: path, client: request.headers.get('cf-connecting-ip') ?? null, origin: url.origin, route: route.pattern, secrets: false } : null;
      const finish = async (result: HandlerResult, producer?: PolicyModule): Promise<HandlerResult> => {
        let out = result;
        for (const [module, state] of route.policy?.response || []) { if (module === producer || !policyReq) continue; out = await module.onResponse?.(state, policyReq, out) ?? out; }
        return out;
      };
      for (const [module, state] of route.policy?.request || []) {
        if (!policyReq) break;
        const denied = await module.onRequest?.(state, policyReq);
        if (denied) return respond(prepareResponse(await finish(denied, module), { requestId, method }), requestId, method);
      }
      if (!route.methods.includes(method)) {
        // The same response policy as every other host: 405 skips the route's
        // configured response headers but still gets length, nosniff and id,
        // and passes through the response-phase policies like the Node runtime.
        return respond(prepareResponse(await finish({ status:405, headers:[['allow',route.methods.join(', ')]],
          body: encoder.encode('Method not allowed\n') }), { requestId, method }), requestId, method);
      }
      const body = route.request?.body
        ? new Uint8Array(await request.arrayBuffer())
        : new Uint8Array(0);
      // Duplicate request headers are joined by the platform before this runs,
      // so per-header counts are unavailable and the duplicate-scalar check
      // cannot fire here. docs/CLOUDFLARE.md records the difference.
      checkRequest(route, body, request.headers, {});
      const context = contextFor(route, path, parsed.query, request.headers, {});
      let native: HandlerResult;
      if (redirecting(route)) native = { status: route.redirect.status || 302, headers:[['location',redirectLocation(route, context, parsed.query)]], body: new Uint8Array(0) };
      else if (route.reply) native = { ...route.reply };
      else throw new HttpError(502, 'Invalid function response');
      return respond(prepareResponse(await finish(decorateResponse(route, native)), { requestId, method }), requestId, method);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      // The matched route's security state when there is one, else the
      // project's from the artifact: the same rule as the Node runtime.
      const state = matched ? (matched.policy?.security ?? null) : compiled.errorPolicy;
      const headers = state ? security.onResponse(state, { origin }, { status: 200, headers: [] }).headers : [];
      const prepared = errorResponse(error, { requestId, method, headers });
      return respond({ ...prepared, cookies: [], body: prepared.body === undefined ? undefined : encoder.encode(prepared.body) }, requestId, method);
    }
  };
}

function respond(prepared: { status: number; headers: HeaderPair[]; cookies?: string[]; body: ResponseBody }, requestId: string, method: string): Response {
  const headers = new Headers();
  for (const [key,value] of prepared.headers) headers.append(key, value);
  for (const cookie of prepared.cookies ?? []) headers.append('set-cookie', cookie);
  if (!headers.has('x-request-id')) headers.set('x-request-id', requestId);
  const empty = method === 'HEAD' || [204,205,304].includes(prepared.status);
  // Bytes here always sit on a plain ArrayBuffer (the encoder or the platform made them); lib.dom's BodyInit only excludes shared memory.
  const body = prepared.body ?? new Uint8Array(0);
  return new Response(empty ? null : typeof body === 'string' ? body : body as Uint8Array<ArrayBuffer>, { status: prepared.status, headers });
}
