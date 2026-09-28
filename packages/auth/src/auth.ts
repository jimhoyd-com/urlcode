// Accounts and sessions are Better Auth's (#841, #843): its handler, tables, cookies, password hashing and origin
// checks. This module only connects one Better Auth instance to URLCode's extension contract: one mount forwarding
// an exact allowlist of Better Auth paths, an authorize() that turns a verified Better Auth session into the request
// principal, and the request-bound `identity` capability for application routes.
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { clientKey, isSameOriginRequest, jsonResponse } from '@jimhoyd/urlcode/extensions';
import type { ExtensionAuthoringContract, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';

/** The Better Auth paths a mount serves by default: sign-in, sign-out and the session endpoints. */
export const defaultPaths: readonly string[] = Object.freeze(['/sign-in/email', '/sign-out', '/get-session', '/list-sessions', '/revoke-session', '/revoke-sessions', '/revoke-other-sessions', '/change-password', '/ok']);
/** Added to `defaultPaths` when the operator enables self-service sign-up. */
export const signUpPath = '/sign-up/email';
/**
 * The only header Better Auth reads a client address from. The mount always overwrites it with the address URLCode
 * admitted (after its trusted-proxy rules), so a client cannot choose its own rate-limit bucket.
 */
export const clientAddressHeader = 'x-urlcode-client-address';
/** The mount Better Auth serves when the operator's tooling needs one before activation (the CLI). */
export const defaultBasePath = '/api/auth';
const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const pathPattern = /^\/[a-z0-9/-]+$/;

export const authConfigSchema = { type: 'object', additionalProperties: false, properties: {} } as const;
export const authPolicySchema = { type: 'object', additionalProperties: false, properties: {} } as const;
export const authAuthoring: ExtensionAuthoringContract = {
  description: 'Accounts and sessions served by Better Auth on one extension mount. Protect a route with `auth: true`; its function reads the signed-in user id from context.capabilities.auth.identity.userId. Permissions (roles, ownership) are application data keyed by that id.',
  surfaces: [
    { kind: 'extension', name: 'mount', description: 'Mount Better Auth at one path, for example /api/auth/* with extension: auth and methods [GET, POST]. Only the operator-enabled Better Auth endpoints answer; everything else under it is 404.', path: 'urlcode.yaml#routes' },
    { kind: 'configuration', name: 'route protection', description: '`auth: true` on a route requires a verified Better Auth session and refuses cross-origin unsafe methods; the route receives no cookie or Authorization header.', path: 'urlcode.yaml#routes' },
  ],
  fastChecks: ['urlcode validate --project app', 'urlcode validate --local --project app --host-file host.mjs --origin <origin>'],
};

/** Everything the operator decides about the Better Auth instance. None of it is project YAML. */
export interface AuthSettings {
  /** The SQLite file Better Auth owns. */
  database: string;
  /** Better Auth's signing secret: at least 32 characters. */
  secret: string;
  /** Allow self-service sign-up over HTTP. Default false: accounts come from `urlcode-auth create-user`. */
  signUp?: boolean | undefined;
  /** More Better Auth paths to serve beyond the defaults, for example a plugin's. */
  paths?: readonly string[] | undefined;
  /** Extra Better Auth options (plugins, session lifetimes). Trusted operator code; merged last, but it cannot turn telemetry or rate limiting off. */
  betterAuth?: Partial<BetterAuthOptions> | undefined;
}

/** The Better Auth options for one instance at `origin`, served at `basePath`. `bootstrap` lets the server API create accounts. */
export function betterAuthOptions(settings: AuthSettings, origin: string, basePath: string, bootstrap = false): BetterAuthOptions {
  if (typeof settings.secret !== 'string' || settings.secret.length < 32) throw new Error('auth needs a Better Auth secret of at least 32 characters; urlcode extensions add auth writes data/auth.secret');
  const extra = settings.betterAuth ?? {};
  return {
    ...extra,
    appName: extra.appName ?? 'URLCode',
    baseURL: origin,
    basePath,
    secret: settings.secret,
    database: new DatabaseSync(settings.database),
    emailAndPassword: { ...extra.emailAndPassword, enabled: true, disableSignUp: !(bootstrap || settings.signUp === true) },
    // Better Auth enables its limiter only under NODE_ENV=production, and without an address every client shares one
    // bucket; here it is always on and keyed by the address the mount supplies.
    rateLimit: { window: 60, max: 100, customRules: { '/sign-in/email': { window: 60, max: 10 }, [signUpPath]: { window: 60, max: 5 } }, ...extra.rateLimit, enabled: true },
    advanced: { ...extra.advanced, ipAddress: { ...extra.advanced?.ipAddress, ipAddressHeaders: [clientAddressHeader] } },
    telemetry: { enabled: false },
  };
}

/** The tables Better Auth still needs, or an empty list when its schema is current. */
export async function pendingMigrations(options: BetterAuthOptions): Promise<string[]> {
  const { toBeCreated, toBeAdded } = await getMigrations(options);
  return [...toBeCreated.map(table => table.table), ...toBeAdded.map(table => table.table)];
}
/** Forward-initializes Better Auth's schema. An explicit operator step, never a side effect of serving. */
export async function migrate(options: BetterAuthOptions): Promise<void> {
  await (await getMigrations(options)).runMigrations();
}

function databaseOf(options: BetterAuthOptions): DatabaseSync | undefined {
  return options.database instanceof DatabaseSync ? options.database : undefined;
}

/** The URLCode registration for one Better Auth instance, pinned to the reviewed project revision. */
export function createAuthExtension(settings: AuthSettings & { projectSha256: string }): RuntimeExtension {
  if (!/^[a-f0-9]{64}$/.test(settings.projectSha256)) throw new Error('auth extension requires an explicit operator revision pin');
  const served = new Set([...defaultPaths, ...(settings.signUp === true ? [signUpPath] : []), ...(settings.paths ?? [])]);
  for (const path of served) if (!pathPattern.test(path)) throw new Error(`auth: ${path} is not a Better Auth path such as /sign-in/email`);
  return {
    name: 'auth', version: '1', projectSha256: settings.projectSha256, targets: ['node'],
    schema: authConfigSchema, policySchema: authPolicySchema, authoring: authAuthoring,
    providesPrincipal: true,
    capabilities: ['identity'],
    async activate(_config, activation): Promise<ExtensionInstance> {
      if (activation.mounts.length !== 1) throw new Error(`auth serves exactly one mount (a route with extension: auth); found ${activation.mounts.length}`);
      const [mount] = activation.mounts as [string];
      const options = betterAuthOptions(settings, activation.origin, mount);
      const database = databaseOf(options);
      try {
        const pending = await pendingMigrations(options);
        if (pending.length) throw new Error(`auth: Better Auth's tables are not initialized (${pending.join(', ')}); run npx urlcode-auth migrate`);
      } catch (error) { database?.close(); throw error; }
      const auth = betterAuth(options);
      return {
        // Better Auth's own handler, origin checks and cookies, for the listed paths only. The URL is rebuilt from the
        // path the allowlist checked, never from the raw request target.
        async handle(request: ExtensionRequest): Promise<HandlerResult> {
          if (!served.has(request.path.slice(mount.length))) return jsonResponse(404, { error: 'not_found' });
          const headers = new Headers(request.headers);
          headers.delete(clientAddressHeader);
          const address = clientKey(request.client ?? undefined);
          if (address) headers.set(clientAddressHeader, address);
          const url = new URL(request.path, activation.origin);
          url.search = request.query.toString();
          const init: RequestInit = { method: request.method, headers, ...(request.signal ? { signal: request.signal } : {}) };
          if (request.method !== 'GET' && request.method !== 'HEAD') init.body = Buffer.from(request.body);
          const response = await auth.handler(new Request(url, init));
          const answer: [string, string][] = [...response.headers].filter(([name]) => name !== 'set-cookie');
          for (const cookie of response.headers.getSetCookie()) answer.push(['set-cookie', cookie]);
          return { status: response.status, headers: answer, body: new Uint8Array(await response.arrayBuffer()) };
        },
        // Identity only: what the signed-in user may do is the application's decision.
        async authorize(_requirement, request: ExtensionRequest): Promise<HandlerResult | undefined> {
          if (unsafe.has(request.method) && !isSameOriginRequest(request, activation, { whenAbsent: 'refuse' })) return jsonResponse(403, { error: 'cross_origin_refused' });
          const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
          if (!session) return jsonResponse(401, { error: 'authentication_required' });
          request.setPrincipal!({ id: session.user.id });
          return undefined;
        },
        provide(capability, invocation) {
          if (capability !== 'identity' || !invocation.principal) return undefined;
          return Object.freeze({ userId: invocation.principal.id });
        },
        close() { database?.close(); },
      };
    },
  };
}
