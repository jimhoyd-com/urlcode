// An independent extension package (#841): Auth.js (@auth/core) behind the same capability boundary the first-party
// Better Auth extension provides. It imports only Auth.js and core's generic extension contract
// (@jimhoyd/urlcode/extensions), never @jimhoyd/urlcode-auth or Better Auth.
//
// What it connects, and nothing more:
// - one mount that forwards an exact allowlist of Auth.js actions to Auth.js's own Request/Response handler;
// - an authorize() that asks Auth.js for the request's session (its own /session action, so the operator's jwt and
//   session callbacks run) and turns the verified user id into the request principal;
// - the request-bound `identity` capability, `{userId}`, for trusted routes that name this extension.
// Accounts, passwords and providers are the operator's Auth.js configuration, passed through unchanged.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Auth } from '@auth/core';
import { defineExtension, isSameOriginRequest, jsonResponse, principalIdPattern } from '@jimhoyd/urlcode/extensions';

export const SECRET_FILE = 'data/authjs.secret';
/**
 * The Auth.js actions the mount forwards by default: the CSRF token, the session, the provider list, the
 * credentials callback (sign-in) and sign-out. Auth.js's built-in HTML pages (/signin, /signout, /error) and every
 * OAuth callback stay 404 unless the operator lists them in `paths`.
 */
export const defaultPaths = Object.freeze(['/csrf', '/session', '/providers', '/callback/credentials', '/signout']);
const pathPattern = /^\/[a-z0-9/-]+$/;
const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const schema = Object.freeze({ type: 'object', additionalProperties: false, properties: {} });

/** The Auth.js secret: `AUTH_SECRET`, else the operator's secret file (default `data/authjs.secret`). */
export async function readSecret(site, file = SECRET_FILE) {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const path = isAbsolute(file) ? file : join(site, file);
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`authjs secret ${file} is missing; urlcode extensions add writes ${SECRET_FILE}, or set AUTH_SECRET`, { cause: error });
    throw error;
  }
}

/** Auth.js logs every failed sign-in as an error with a stack; this writes one JSON line with the error type only. */
const quietLogger = Object.freeze({
  error(error) { console.error(JSON.stringify({ event: 'authjs_error', type: error?.type ?? error?.name ?? 'Error' })); },
  warn(code) { console.error(JSON.stringify({ event: 'authjs_warning', code })); },
  debug() {},
});

/**
 * The Auth.js configuration for one mount. The operator's own options come first and are passed through as Auth.js
 * defines them (providers, session strategy and lifetime, callbacks, cookies, logger). The adapter sets only what
 * the mount decides: basePath is the declared mount, the secret is the operator's, and the host is trusted because
 * the request URL is rebuilt from the operator's --origin, never from the client's Host or X-Forwarded-* headers.
 */
export function authjsConfig(options, secret, basePath) {
  const providers = options.providers ?? [];
  if (!providers.length) throw new Error('authjs: no Auth.js providers are configured; pass authjs({authjs: {providers: [...]}}) in host.mjs');
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('authjs: the Auth.js secret must be at least 32 characters');
  return {
    logger: quietLogger,
    ...options,
    providers,
    basePath,
    secret,
    trustHost: true,
    // The principal is session.user.id. Without an operator session callback, it is the JWT subject Auth.js set from
    // the provider's user id; an operator callback that replaces the session must set it itself.
    callbacks: { ...options.callbacks, session: options.callbacks?.session ?? (({ session, token }) => ({ ...session, user: { ...session.user, id: token?.sub } })) },
  };
}

function scaffold() {
  return {
    config: {},
    routes: { '/api/auth/*': { extension: 'authjs', methods: ['GET', 'POST'], description: 'Auth.js: CSRF token, session, sign-in callback and sign-out.' } },
    files: [{ path: SECRET_FILE, content: `${randomBytes(32).toString('base64url')}\n`, mode: 0o600 }],
    notes: [
      'Configure Auth.js providers in host.mjs: authjs({authjs: {providers: [Credentials({...})]}}). The extension refuses to activate without one.',
      'Protect a route with policies: {extensions: {authjs: {}}}; its function reads context.capabilities.authjs.identity.userId.',
      `Keep ${SECRET_FILE} private and backed up; it encrypts every session token.`,
    ],
  };
}

export default defineExtension({
  name: 'authjs',
  description: 'Auth.js on one mount; routes that name it receive the signed-in user id as their principal and identity capability',
  requires: [],
  targets: ['node'],
  schema,
  policySchema: schema,
  scaffold,
  async host(context, options) {
    const secret = await readSecret(context.site, options.secretFile);
    const served = new Set([...defaultPaths, ...(options.paths ?? [])]);
    for (const path of served) if (!pathPattern.test(path)) throw new Error(`authjs: ${path} is not an Auth.js action path such as /session`);
    const registration = {
      name: 'authjs', version: '1', projectSha256: context.projectSha256, targets: ['node'], schema, policySchema: schema,
      providesPrincipal: true,
      capabilities: ['identity'],
      activate(_config, activation) {
        if (activation.mounts.length !== 1) throw new Error(`authjs serves exactly one mount (a route with extension: authjs); found ${activation.mounts.length}`);
        const [mount] = activation.mounts;
        const config = authjsConfig(options.authjs ?? {}, secret, mount);
        // Auth.js's own handler for one request. Auth() fills in defaults on the object it is given, so each call gets
        // a shallow copy of the reviewed configuration.
        const auth = request => Auth(request, { ...config });
        return {
          async handle(request) {
            if (!served.has(request.path.slice(mount.length))) return jsonResponse(404, { error: 'not_found' });
            // Auth.js protects its POST actions with a double-submit CSRF token; the mount also refuses cross-origin
            // unsafe requests, as `authorize()` does on protected routes.
            if (unsafe.has(request.method) && !isSameOriginRequest(request, activation, { whenAbsent: 'refuse' })) return jsonResponse(403, { error: 'cross_origin_refused' });
            const url = new URL(request.path, activation.origin);
            url.search = request.query.toString();
            const headers = new Headers(request.headers);
            for (const name of ['host', 'x-forwarded-host', 'x-forwarded-proto']) headers.delete(name);
            const init = { method: request.method, headers, ...(request.signal ? { signal: request.signal } : {}) };
            if (request.method !== 'GET' && request.method !== 'HEAD') init.body = Buffer.from(request.body);
            const response = await auth(new Request(url, init));
            const answer = [...response.headers].filter(([name]) => name !== 'set-cookie');
            for (const cookie of response.headers.getSetCookie()) answer.push(['set-cookie', cookie]);
            return { status: response.status, headers: answer, body: new Uint8Array(await response.arrayBuffer()) };
          },
          // Identity only: what the signed-in user may do is the application's decision.
          async authorize(_requirement, request) {
            if (unsafe.has(request.method) && !isSameOriginRequest(request, activation, { whenAbsent: 'refuse' })) return jsonResponse(403, { error: 'cross_origin_refused' });
            const cookie = request.headers.get('cookie');
            if (!cookie) return jsonResponse(401, { error: 'authentication_required' });
            // Auth.js's own session action, with nothing from the request but its cookies. The refreshed session cookie
            // it answers with is not forwarded: a protected route does not extend the session.
            const response = await auth(new Request(new URL(`${mount}/session`, activation.origin), { headers: { cookie } })).catch(() => undefined);
            const session = response?.ok ? await response.json().catch(() => null) : null;
            const id = session?.user?.id;
            if (typeof id !== 'string' || !principalIdPattern.test(id)) return jsonResponse(401, { error: 'authentication_required' });
            request.setPrincipal({ id });
            return undefined;
          },
          provide(capability, invocation) {
            if (capability !== 'identity' || !invocation.principal) return undefined;
            return Object.freeze({ userId: invocation.principal.id });
          },
        };
      },
    };
    return { registration };
  },
});
