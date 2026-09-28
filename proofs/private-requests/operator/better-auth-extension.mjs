// Trusted operator code: connects an operator-built Better Auth instance to URLCode's extension contract.
// It owns no accounts, sessions, passwords or tables. Better Auth does; this file only maps its native
// Request/Response handler onto one declared mount, turns a verified Better Auth session into URLCode's opaque
// request principal, and hands application routes that principal through the #840 request-bound capability.
import { clientKey, defineExtension, isSameOriginRequest, jsonResponse } from '@jimhoyd/urlcode/extensions';
import { getMigrations } from 'better-auth/db/migration';

const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * The only header Better Auth may read a client address from. The adapter always overwrites it with the address
 * URLCode admitted (after its trusted-proxy rules), so a client cannot choose its own rate-limit bucket.
 */
export const clientAddressHeader = 'x-urlcode-client-address';
const withoutBody = new Set(['GET', 'HEAD']);

/** Refuses before serving when the pinned Better Auth instance cannot be what the declared mount serves. */
async function checkInstance(auth, paths, activation) {
  const options = auth?.options;
  if (!options || typeof auth.handler !== 'function' || typeof auth.api?.getSession !== 'function') throw new Error('better-auth: host.mjs must pass the Better Auth instance as betterAuthExtension({auth, paths})');
  if (!paths.size || [...paths].some(path => typeof path !== 'string' || !/^\/[a-z0-9/-]+$/.test(path))) throw new Error('better-auth: paths must list the exact Better Auth paths the mount serves, for example /sign-in/email');
  if (activation.mounts.length !== 1) throw new Error(`better-auth: declare exactly one extension: better-auth mount; found ${activation.mounts.length}`);
  const [mount] = activation.mounts;
  if ((options.basePath ?? '/api/auth') !== mount) throw new Error(`better-auth: the mount ${mount} differs from the instance basePath ${options.basePath}`);
  const base = typeof options.baseURL === 'string' ? new URL(options.baseURL).origin : undefined;
  if (base !== activation.origin) throw new Error(`better-auth: the instance baseURL origin ${base} differs from the operator origin ${activation.origin}`);
  if (options.telemetry?.enabled !== false) throw new Error('better-auth: set telemetry: {enabled: false}; a local site must not depend on an outside service');
  // Better Auth enables its limiter only under NODE_ENV=production, and without an address every client shares one bucket.
  if (options.rateLimit?.enabled !== true) throw new Error('better-auth: set rateLimit: {enabled: true}; sign-in must be throttled whatever NODE_ENV is');
  if (JSON.stringify(options.advanced?.ipAddress?.ipAddressHeaders) !== JSON.stringify([clientAddressHeader])) throw new Error(`better-auth: set advanced.ipAddress.ipAddressHeaders to ['${clientAddressHeader}']; the adapter supplies it from the admitted client address`);
  // Forward schema initialization is an explicit operator step (npm run setup), never a side effect of serving.
  const { toBeCreated, toBeAdded } = await getMigrations(options);
  if (toBeCreated.length || toBeAdded.length) throw new Error(`better-auth: its database schema is not initialized (${[...toBeCreated.map(table => table.table), ...toBeAdded.map(table => table.table)].join(', ')}); run npm run setup`);
}

/** The session Better Auth verifies from the request's own cookie, or null. */
async function verifiedSession(auth, request) {
  return await auth.api.getSession({ headers: request.headers }).catch(() => null);
}

export default defineExtension({
  name: 'better-auth',
  description: 'Serves an operator-configured Better Auth instance on one mount and verifies its sessions for application routes.',
  schema: { type: 'object', additionalProperties: false, properties: {} },
  policySchema: { type: 'object', additionalProperties: false, properties: {} },
  host(context, { auth, paths: served = [] }) {
    const paths = new Set(served);
    return {
      registration: {
        name: 'better-auth', version: '1', projectSha256: context.projectSha256, targets: ['node'],
        schema: { type: 'object', additionalProperties: false, properties: {} },
        policySchema: { type: 'object', additionalProperties: false, properties: {} },
        providesPrincipal: true,
        capabilities: ['identity'],
        async activate(_config, activation) {
          await checkInstance(auth, paths, activation);
          const [mount] = activation.mounts;
          return {
            // The native mount: Better Auth's own handler, origin/CSRF checks and cookies, for the listed paths only.
            async handle(request) {
              if (!paths.has(request.path.slice(mount.length))) return jsonResponse(404, { error: 'not_found' });
              const headers = new Headers(request.headers);
              headers.delete(clientAddressHeader);
              const address = clientKey(request.client ?? undefined);
              if (address) headers.set(clientAddressHeader, address);
              const init = { method: request.method, headers, signal: request.signal };
              if (!withoutBody.has(request.method)) init.body = request.body;
              // Built from the same path the allowlist checked, never from the raw request target.
              const url = new URL(request.path, activation.origin);
              url.search = request.query.toString();
              const response = await auth.handler(new Request(url, init));
              const answer = [...response.headers].filter(([name]) => name !== 'set-cookie');
              for (const cookie of response.headers.getSetCookie()) answer.push(['set-cookie', cookie]);
              return { status: response.status, headers: answer, body: new Uint8Array(await response.arrayBuffer()) };
            },
            // Application routes: identity only. What the identity may do is the application's decision.
            async authorize(_requirement, request) {
              if (unsafe.has(request.method) && !isSameOriginRequest(request, activation, { whenAbsent: 'refuse' })) return jsonResponse(403, { error: 'cross_origin_refused' });
              const session = await verifiedSession(auth, request);
              if (!session) return jsonResponse(401, { error: 'authentication_required' });
              request.setPrincipal({ id: session.user.id });
              return undefined;
            },
            provide(capability, invocation) {
              if (capability !== 'identity' || !invocation.principal) return undefined;
              return Object.freeze({ userId: invocation.principal.id });
            },
          };
        },
      },
    };
  },
});
