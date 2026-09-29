// Accounts and sessions are Better Auth's (#841, #843): its handler, tables, cookies, password hashing and origin
// checks. This module only connects one Better Auth instance to URLCode's extension contract: one mount forwarding
// an exact allowlist of Better Auth paths, an authorize() that turns a verified Better Auth session into the request
// principal, and the request-bound `identity` capability for application routes.
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { mkdir } from 'node:fs/promises';
import { clientKey, isSameOriginRequest, joinHostLease, jsonResponse, refuseNetworkFilesystem } from '@jimhoyd/urlcode/extensions';
import type { ExtensionAuthoringContract, ExtensionInstance, ExtensionRequest, HandlerResult, HostLease, HostProbe, RuntimeExtension } from '@jimhoyd/urlcode/extensions';

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
/** How long one statement waits for a lock another process holds before failing: the store's and audit's bound. */
const BUSY_TIMEOUT_MS = 2000;
const unsafe = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const pathPattern = /^\/[a-z0-9/-]+$/;

export const authConfigSchema = { type: 'object', additionalProperties: false, properties: {} } as const;
export const authPolicySchema = { type: 'object', additionalProperties: false, properties: {} } as const;
export const authAuthoring: ExtensionAuthoringContract = {
  description: 'Accounts and sessions served by Better Auth on one extension mount. Protect a route with `auth: true`; its function reads the signed-in user id from context.capabilities.auth.identity.userId. Permissions are data keyed by that id, never roles in auth: per-user records and membership lists are store declarations (ownership: owner, membership).',
  surfaces: [
    { kind: 'extension', name: 'mount', description: 'Mount Better Auth at one path, for example /api/auth/* with extension: auth and methods [GET, POST]. Only the operator-enabled Better Auth endpoints answer; everything else under it is 404.', path: 'urlcode.yaml#routes',
      goals: ['account', 'accounts', 'login', 'logout', 'signin', 'sign-in', 'password', 'passwords', 'session', 'sessions'] },
    { kind: 'configuration', name: 'route protection', description: '`auth: true` on a route requires a verified Better Auth session and refuses cross-origin unsafe methods; the route receives no cookie or Authorization header. It is the principal-providing policy a store `ownership: owner` mount, `readers` mount or `by: others` transition mount needs.', path: 'urlcode.yaml#routes',
      goals: ['auth', 'authenticated', 'authentication', 'signed-in', 'logged-in', 'user', 'users', 'private', 'protected', 'own', 'owner', 'owners', 'their', 'mine', 'per-user', 'member', 'members', 'reviewer', 'reviewers', 'approver', 'approvers'] },
  ],
  fastChecks: ['urlcode validate --project app', 'urlcode validate --local --project app --host-file host.mjs --origin <origin>'],
};

/**
 * Better Auth's node:sqlite dialect opens every transaction with a bare `begin` (DEFERRED). Its sign-up reads the email,
 * hashes the password, then inserts: under WAL, a commit by another process during the hash makes that insert fail at
 * once with SQLITE_BUSY_SNAPSHOT, which no busy timeout retries. Taking the write lock at `begin` (IMMEDIATE) waits up to
 * the busy timeout instead, so the transaction's reads are still current when it writes. Only that exact statement
 * changes; Better Auth still sees a DatabaseSync and keeps its own dialect.
 */
class AuthDatabase extends DatabaseSync {
  override prepare(...args: Parameters<DatabaseSync['prepare']>): ReturnType<DatabaseSync['prepare']> {
    const [sql, ...rest] = args;
    return super.prepare(sql === 'begin' ? 'BEGIN IMMEDIATE' : sql, ...rest);
  }
}

/**
 * Opens Better Auth's SQLite file for one process of several: creates it 0600 (its directory 0700) when absent and
 * refuses anything but a private regular file with one link, as the store and audit do; then WAL with FULL
 * synchronous commits and a busy timeout, so a serving process and `urlcode-auth create-user` (or a second serving
 * process) wait for each other's commits instead of failing with "database is locked". SQLite creates the `-wal` and
 * `-shm` files with the database file's permissions.
 */
export function openAuthDatabase(path: string): DatabaseSync {
  const requested = resolve(path);
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  const database = join(realpathSync(dirname(requested)), basename(requested));
  try { closeSync(openSync(database, 'wx', 0o600)); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  const info = lstatSync(database);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
    throw new Error(`auth: ${database} must be a private regular file (mode 0600, one link); chmod 600 it`);
  const db = new AuthDatabase(database, { allowExtension: false, timeout: BUSY_TIMEOUT_MS });
  try { db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); }
  catch (error) { db.close(); throw error; }
  return db;
}

/**
 * Creates the auth database's directory (0700) when absent and refuses it on a network filesystem by its Linux `statfs`
 * type, the list the store and audit refuse (core's `refuseNetworkFilesystem`; skipped on macOS and Windows). Serving
 * and the operator commands run it before they open the database. `probe` is a test seam.
 */
export async function refuseRemoteAuthDatabase(path: string, probe?: Partial<HostProbe>): Promise<void> {
  const directory = dirname(resolve(path));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await refuseNetworkFilesystem(directory, 'auth', probe);
}

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
    database: openAuthDatabase(settings.database),
    emailAndPassword: { ...extra.emailAndPassword, enabled: true, disableSignUp: !(bootstrap || settings.signUp === true) },
    // Better Auth enables its limiter only under NODE_ENV=production, and without an address every client shares one
    // bucket; here it is always on and keyed by the address the mount supplies. Its counters live in the auth database
    // (the `rateLimit` table `urlcode-auth migrate` creates), so every process serving this database shares one limit;
    // Better Auth's default keeps them in memory, per process.
    rateLimit: { window: 60, max: 100, customRules: { '/sign-in/email': { window: 60, max: 10 }, [signUpPath]: { window: 60, max: 5 } }, storage: 'database', ...extra.rateLimit, enabled: true },
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

/** Better Auth's APIError for a 4xx: the request's own session is missing or invalid. */
function isClientError(error: unknown): boolean {
  const status = error !== null && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function databaseOf(options: BetterAuthOptions): DatabaseSync | undefined {
  return options.database instanceof DatabaseSync ? options.database : undefined;
}

/** The URLCode registration for one Better Auth instance, pinned to the reviewed project revision. */
export function createAuthExtension(settings: AuthSettings & { projectSha256: string; /** A test seam; never set by an operator. */ probe?: Partial<HostProbe> | undefined }): RuntimeExtension {
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
      await refuseRemoteAuthDatabase(settings.database, settings.probe);
      const options = betterAuthOptions(settings, activation.origin, mount);
      const database = databaseOf(options);
      let lease: HostLease | undefined;
      try {
        const pending = await pendingMigrations(options);
        if (pending.length) throw new Error(`auth: Better Auth's tables are not initialized (${pending.join(', ')}); run npx urlcode-auth migrate`);
        // The host lease (#941): `auth_servers` in the auth database, one row per activation. A live peer serving this
        // database from another host refuses activation; processes on one host do not refuse each other.
        if (database) lease = await joinHostLease(database, { table: 'auth_servers', what: 'auth', probe: settings.probe });
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
          let session;
          try { session = await auth.api.getSession({ headers: request.headers }); }
          catch (error) {
            // A missing, expired or malformed session is null or a 4xx from Better Auth. A storage failure (a lock held
            // past the busy timeout, an I/O error) is its 500: the session may well be valid, so answer 503 without
            // detail rather than a 401 that tells the client it is signed out.
            if (!isClientError(error)) return jsonResponse(503, { error: 'auth_unavailable' }, [['retry-after', '1']]);
            session = null;
          }
          if (!session) return jsonResponse(401, { error: 'authentication_required' });
          request.setPrincipal!({ id: session.user.id });
          return undefined;
        },
        provide(capability, invocation) {
          if (capability !== 'identity' || !invocation.principal) return undefined;
          return Object.freeze({ userId: invocation.principal.id });
        },
        close() { lease?.close(); database?.close(); },
      };
    },
  };
}
