// Accounts and sessions are Better Auth's (#841, #843): its handler, tables, cookies, password hashing and origin
// checks. This module only connects one Better Auth instance to URLCode's extension contract: one mount forwarding
// an exact allowlist of Better Auth paths, an authorize() that turns a verified Better Auth session into the request
// principal, and the request-bound `identity` capability for application routes.
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { runWithEndpointContext } from '@better-auth/core/context';
import type { AuthEndpointContext } from '@better-auth/core/context';
import { getMigrations } from 'better-auth/db/migration';
import { mkdir } from 'node:fs/promises';
import { clientKey, ExtensionHttpError, isSameOriginRequest, jsonResponse, principalIdPattern, readBody } from '@jimhoyd/urlcode/extensions';
import { holdServerLock, refuseNetworkFilesystem } from '@jimhoyd/urlcode/sqlite';
import { maxRequestBodyBytes } from '@jimhoyd/urlcode/body-schema';
import type { ExtensionAuthoringContract, ExtensionInstance, ExtensionOpenApiSecurity, ExtensionRequest, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import type { HostProbe, ServerLock } from '@jimhoyd/urlcode/sqlite';

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
/**
 * Default paths whose 401 means "no valid session" (Better Auth's session middleware). That middleware reads the session
 * through `getSessionFromCtx`, which turns a storage failure into "no session" (#980), so the mount checks such a 401.
 */
const sessionPaths = new Set(['/list-sessions', '/revoke-session', '/revoke-sessions', '/revoke-other-sessions', '/change-password']);
const pathPattern = /^\/[a-z0-9/-]+$/;

export const authConfigSchema = { type: 'object', additionalProperties: false, properties: {} } as const;
export const authPolicySchema = { type: 'object', additionalProperties: false, properties: {} } as const;
/**
 * How a client presents the credential `authorize()` verifies, for `urlcode openapi` (#1047): Better Auth's session
 * cookie. Its name is Better Auth's operator configuration (a cookie prefix, per-cookie names, the secure prefix an
 * https origin adds), so it is left out and the export states the cookie without publishing or inventing a name.
 */
export const authOpenApiSecurity: ExtensionOpenApiSecurity = Object.freeze({ type: 'apiKey', in: 'cookie', description: 'The Better Auth session cookie that signing in under the auth mount sets; a browser sends it with each same-site request. Its name is the operator\'s Better Auth configuration and is not published.' });
/**
 * The test seed a hermetic run accepts (`tests/seed.json` under `auth`, RIM-EXT-HERMETIC-001): accounts created with
 * the id a store membership or fixture can name, and a password a fixture signs in with. Never accepted on `serve`.
 */
export const authSeedSchema = {
  type: 'object', additionalProperties: false, required: ['users'],
  properties: {
    users: {
      type: 'array', minItems: 1, maxItems: 100,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'email', 'password'],
        properties: {
          id: { type: 'string', pattern: principalIdPattern.source, description: 'The user id, which is the request principal id (a store membership names it).' },
          email: { type: 'string', maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' },
          password: { type: 'string', minLength: 8, maxLength: 128 },
          name: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  },
} as const;
interface AuthSeed { users: { id: string; email: string; password: string; name?: string }[] }
export const authAuthoring: ExtensionAuthoringContract = {
  description: 'Accounts and sessions served by Better Auth on one extension mount. Protect a route with `auth: true`; its function reads the signed-in user id from context.capabilities.auth.identity.userId. Permissions are data keyed by that id, never roles in auth: per-user records and membership lists are store declarations (ownership: owner, membership).',
  surfaces: [
    { kind: 'extension', name: 'mount', description: 'Mount Better Auth at one path, for example /api/auth/* with extension: auth and methods [GET, POST]. Only the operator-enabled Better Auth endpoints answer; everything else under it is 404.', path: 'urlcode.yaml#routes',
      goals: ['account', 'accounts', 'login', 'logout', 'signin', 'sign-in', 'password', 'passwords', 'session', 'sessions'] },
    { kind: 'configuration', name: 'route protection', description: '`auth: true` on a route requires a verified Better Auth session and refuses cross-origin unsafe methods; the route receives no cookie or Authorization header. It is the principal-providing policy a store `ownership: owner` mount, `readers` mount or `by: others` transition mount needs.', path: 'urlcode.yaml#routes',
      goals: ['auth', 'authenticated', 'authentication', 'signed-in', 'logged-in', 'user', 'users', 'private', 'protected', 'own', 'owner', 'owners', 'their', 'mine', 'per-user', 'member', 'members', 'reviewer', 'reviewers', 'approver', 'approvers'] },
  ],
  fastChecks: ['urlcode validate --project app', 'urlcode validate --local --project app --host-file host.mjs --local-review'],
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
 * Opens Better Auth's SQLite file: creates it 0600 (its directory 0700) when absent and refuses anything but a private
 * regular file with one link, as the store and audit do; then WAL with FULL synchronous commits and a busy timeout, so
 * the serving process and `urlcode-auth create-user` wait for each other's commits instead of failing with "database
 * is locked". SQLite creates the `-wal` and `-shm` files with the database file's permissions.
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
 * type, the list the store and audit refuse (core's `refuseNetworkFilesystem`; skipped on macOS and Windows). The
 * operator commands run it before they open the database; serving runs it through `holdServerLock`.
 */
export async function refuseRemoteAuthDatabase(path: string, probe?: Partial<HostProbe>): Promise<void> {
  const directory = dirname(resolve(path));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await refuseNetworkFilesystem(directory, 'auth', probe);
}

/**
 * A database the owner gives Better Auth instead of the bundled SQLite file: anything Better Auth's own `database`
 * option accepts (an adapter such as `memoryAdapter`, `prismaAdapter` or `drizzleAdapter`, a Kysely dialect, a
 * Postgres or MySQL pool, a `DatabaseSync`). Better Auth serves it as it is; its schema, migrations, backups and
 * concurrency are the owner's.
 */
export type OwnerDatabase = NonNullable<BetterAuthOptions['database']>;

/** Everything the operator decides about the Better Auth instance. None of it is project YAML. */
export interface AuthSettings {
  /**
   * The bundled SQLite file's path (the adapter creates it, holds its one-server lock and runs it in WAL mode), or the
   * owner's own Better Auth database (`OwnerDatabase`), which the adapter passes to Better Auth unchanged.
   */
  database: string | OwnerDatabase;
  /**
   * A hermetic run's isolated database when `database` is the owner's (RIM-EXT-HERMETIC-001): a hermetic activation
   * with an owner database serves this one, never `database`, and refuses without it. It must already hold Better
   * Auth's schema and no live data: the adapter never migrates an owner database.
   */
  testDatabase?: OwnerDatabase | undefined;
  /** Better Auth's signing secret: at least 32 characters. */
  secret: string;
  /** Allow self-service sign-up over HTTP. Default false: accounts come from `urlcode-auth create-user`. */
  signUp?: boolean | undefined;
  /** More Better Auth paths to serve beyond the defaults, for example a plugin's. */
  paths?: readonly string[] | undefined;
  /**
   * Extra Better Auth options (plugins, other sign-in methods, session lifetimes, `emailAndPassword.enabled: false`).
   * Trusted operator code; merged last, but it cannot turn telemetry or rate limiting off, and the database is
   * `database`, never `betterAuth.database`.
   */
  betterAuth?: Partial<BetterAuthOptions> | undefined;
  /**
   * A hermetic run's throwaway instance (`HostContext.hermetic`): activation creates Better Auth's tables in the
   * bundled SQLite file instead of refusing (or serves `testDatabase` for an owner database), the registration accepts
   * a test seed (`authSeedSchema`), and every rate limit allows `hermeticRateLimitFactor` times as many requests
   * (#1019). Never set for `serve`.
   */
  hermetic?: boolean | undefined;
}

/** Whether `database` is the owner's own Better Auth database rather than the bundled SQLite file's path. */
export function isOwnerDatabase(database: AuthSettings['database']): database is OwnerDatabase {
  return typeof database !== 'string';
}

/** Whether the instance offers email and password sign-in: Better Auth's own option, on unless the owner turns it off. */
export function emailAndPasswordEnabled(settings: Pick<AuthSettings, 'betterAuth'>): boolean {
  return settings.betterAuth?.emailAndPassword?.enabled !== false;
}

/** The one activation warning for an owner database (RIM-EXT-WARN-001): which of the bundled file's guarantees are now the owner's. */
export const ownerDatabaseWarning = 'auth serves the owner\'s Better Auth database, not the bundled SQLite file: its schema and migration state, backups, single-writer or multi-server rules and access control are the owner\'s; the one-server lock, the WAL and file checks and urlcode-auth migrate, create-user and find-user do not apply';

/** The Better Auth options for one instance at `origin`, served at `basePath`. `bootstrap` lets the server API create accounts. */
export function betterAuthOptions(settings: AuthSettings, origin: string, basePath: string, bootstrap = false): BetterAuthOptions {
  if (typeof settings.secret !== 'string' || settings.secret.length < 32) throw new Error('auth needs a Better Auth secret of at least 32 characters; urlcode extensions add auth writes data/auth.secret');
  const extra = settings.betterAuth ?? {};
  if (extra.database !== undefined) throw new Error('auth: pass Better Auth\'s database as auth({database}), not betterAuth.database');
  if (settings.database === undefined || settings.database === null) throw new Error('auth needs a database: the bundled SQLite file\'s path or a Better Auth database');
  return {
    ...extra,
    appName: extra.appName ?? 'URLCode',
    baseURL: origin,
    basePath,
    secret: settings.secret,
    database: isOwnerDatabase(settings.database) ? settings.database : openAuthDatabase(settings.database),
    // Email and password is the default sign-in method, not a forced one: the owner may turn it off and sign in with a
    // plugin's method instead. Sign-up over HTTP stays the operator's `signUp` choice either way.
    emailAndPassword: { enabled: true, ...extra.emailAndPassword, disableSignUp: !(bootstrap || settings.signUp === true) },
    // Better Auth enables its limiter only under NODE_ENV=production, and without an address every client shares one
    // bucket; here it is always on and keyed by the address the mount supplies. Its counters live in the auth database
    // (the `rateLimit` table `urlcode-auth migrate` creates, or the owner database's), so a restart does not reset
    // the limit; Better Auth's default keeps them in memory.
    rateLimit: rateLimitFor({ window: 60, max: 100, customRules: { '/sign-in/email': { window: 60, max: 10 }, [signUpPath]: { window: 60, max: 5 } }, storage: 'database', ...extra.rateLimit, enabled: true }, settings.hermetic === true),
    advanced: { ...extra.advanced, ipAddress: { ...extra.advanced?.ipAddress, ipAddressHeaders: [clientAddressHeader] } },
    telemetry: { enabled: false },
  };
}

/**
 * How many times each rate limit a hermetic run allows (#1019). Its fixtures replay a whole site from one client
 * address within seconds, so a site whose fixtures sign in more than ten times would otherwise fail `urlcode test` with
 * 429. The limiter stays on, keyed and stored as for serving; only each rule's `max` is multiplied.
 */
export const hermeticRateLimitFactor = 10;
type RateLimitOptions = NonNullable<BetterAuthOptions['rateLimit']>;
type RateLimitRule = { window: number; max: number };
const scaled = <Rule extends RateLimitRule>(rule: Rule): Rule => ({ ...rule, max: rule.max * hermeticRateLimitFactor });
/**
 * The limiter as served, or for a hermetic run's throwaway instance (`AuthSettings.hermetic`, which only the operator
 * host sets, never YAML or the environment) with every rule's `max` multiplied by `hermeticRateLimitFactor`: the
 * default `max`, every `customRules` entry, and what a rule function returns. A rule an operator disabled stays disabled.
 */
function rateLimitFor(rateLimit: RateLimitOptions, hermetic: boolean): RateLimitOptions {
  if (!hermetic) return rateLimit;
  const rules: NonNullable<RateLimitOptions['customRules']> = {};
  for (const [path, rule] of Object.entries(rateLimit.customRules ?? {})) {
    rules[path] = typeof rule === 'function' ? async (request, current) => { const chosen = await rule(request, current); return chosen === false ? false : scaled(chosen); }
      : rule === false ? false : scaled(rule);
  }
  return { ...rateLimit, max: (rateLimit.max ?? 100) * hermeticRateLimitFactor, customRules: rules };
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

/** Better Auth's APIError body code, when the error is one. */
function apiErrorCode(error: unknown): string | undefined {
  const body = error !== null && typeof error === 'object' && 'body' in error ? error.body : undefined;
  const code = body !== null && typeof body === 'object' && 'code' in body ? body.code : undefined;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Creates the seeded accounts through Better Auth's own API (its internal adapter, with the owner's database hooks, and
 * its password hashing), as its email sign-up does: a user, then its `credential` account, except that the user id is
 * the seed's. No SQL, so it works on whatever database Better Auth serves.
 *
 * It runs in a hermetic seed context (#1058): the endpoint context Better Auth gives `user.validateUserInfo` and the
 * `databaseHooks`, as a server-side call has one, with no request (`request` and `path` undefined) and empty
 * `headers`, so no client address or cookie. `validateUserInfo` sees `{method: 'email-password', action:
 * 'create-user'}`. A hook that rejects a seeded user refuses the run, naming it.
 */
async function seedUsers(auth: ReturnType<typeof betterAuth>, seed: AuthSeed): Promise<void> {
  const context = await auth.$context;
  const seedContext = { context: { ...context, returned: undefined, responseHeaders: undefined, session: null }, headers: new Headers(), request: undefined, path: undefined } as unknown as AuthEndpointContext;
  await runWithEndpointContext(seedContext, async () => {
    for (const user of seed.users) {
      const password = await context.password.hash(user.password);
      let created: { id: string } | null;
      try {
        created = await context.internalAdapter.createUser({ id: user.id, email: user.email, name: user.name ?? user.email, emailVerified: false }, { method: 'email-password' });
      } catch (error) {
        const code = apiErrorCode(error);
        if (code?.startsWith('validation_context') || code === 'validation_source_missing' || !code || !context.options.user?.validateUserInfo) throw error;
        throw new Error(`auth: seeded user ${user.id} was refused by betterAuth.user.validateUserInfo (${code}${error instanceof Error && error.message !== code ? `: ${error.message}` : ''}); seeds run it with {method: 'email-password', action: 'create-user'} and no request`, { cause: error });
      }
      if (created === null) throw new Error(`auth: seeded user ${user.id} was not created: a betterAuth.databaseHooks.user.create.before hook returned false`);
      if (created.id !== user.id) throw new Error(`auth: seeded user ${user.id} was stored as ${String(created.id)}; this Better Auth configuration generates its own ids`);
      const account = await context.internalAdapter.linkAccount({ userId: created.id, providerId: 'credential', accountId: created.id, password });
      if (account === null) throw new Error(`auth: seeded user ${user.id} has no password account: a betterAuth.databaseHooks.account.create.before hook returned false`);
    }
  });
}

/** Better Auth's APIError for a 4xx: the request's own session is missing or invalid. */
function isClientError(error: unknown): boolean {
  const status = error !== null && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function databaseOf(options: BetterAuthOptions): DatabaseSync | undefined {
  return options.database instanceof DatabaseSync ? options.database : undefined;
}

/** The refusal for a hermetic run with an owner database and no isolated one: it never falls back to live data. */
export const hermeticOwnerDatabaseRefusal = 'auth: this host gives Better Auth the owner\'s own database, so a hermetic run (test, audit, or validate and routes with --local-review) needs an isolated one: pass auth({testDatabase: () => <a fresh Better Auth database holding its schema and no live data>}) in host.mjs. The run never falls back to the live database';

/**
 * The URLCode registration for one Better Auth instance, pinned to the reviewed project revision. With the bundled
 * SQLite file, every activation holds its server lock (core's `holdServerLock`) until it closes, taken before anything
 * opens the database: a second serving process is refused, and a dev reload's two activations in one process share the
 * lock. An owner database gets none of the file's machinery (lock, WAL, migration check) and one warning saying so.
 */
export function createAuthExtension(settings: AuthSettings & { projectSha256: string; /** A test seam; never set by an operator. */ probe?: Partial<HostProbe> | undefined }): RuntimeExtension {
  if (!/^[a-f0-9]{64}$/.test(settings.projectSha256)) throw new Error('auth extension requires an explicit operator revision pin');
  if (settings.betterAuth?.database !== undefined) throw new Error('auth: pass Better Auth\'s database as auth({database}), not betterAuth.database');
  const passwords = emailAndPasswordEnabled(settings);
  if (settings.signUp === true && !passwords) throw new Error('auth: signUp serves email and password sign-up, which betterAuth.emailAndPassword.enabled: false turns off');
  if (settings.testDatabase !== undefined && !isOwnerDatabase(settings.database)) throw new Error('auth: testDatabase is only for an owner database (auth({database: <a Better Auth database>})); a hermetic run already gives the bundled SQLite file a fresh one');
  // Without email and password, its endpoints are not served: the owner's plugin paths come from `paths`.
  const served = new Set([...defaultPaths.filter(path => passwords || (path !== '/sign-in/email' && path !== '/change-password')), ...(settings.signUp === true ? [signUpPath] : []), ...(settings.paths ?? [])]);
  for (const path of served) if (!pathPattern.test(path)) throw new Error(`auth: ${path} is not a Better Auth path such as /sign-in/email`);
  const owner = isOwnerDatabase(settings.database);
  return {
    name: 'auth', version: '1', projectSha256: settings.projectSha256, targets: ['node'],
    schema: authConfigSchema, policySchema: authPolicySchema, authoring: authAuthoring,
    providesPrincipal: true,
    openapiSecurity: authOpenApiSecurity,
    capabilities: ['identity'],
    ...(settings.hermetic === true ? { seedSchema: authSeedSchema } : {}),
    async activate(_config, activation): Promise<ExtensionInstance> {
      if (activation.mounts.length !== 1) throw new Error(`auth serves exactly one mount (a route with extension: auth); found ${activation.mounts.length}`);
      const [mount] = activation.mounts as [string];
      let storage: AuthSettings['database'] = settings.database;
      if (owner) {
        // A hermetic run serves only the owner's isolated database, and refuses without one: never the live database.
        if (settings.hermetic === true) {
          if (settings.testDatabase === undefined) throw new Error(hermeticOwnerDatabaseRefusal);
          if (settings.testDatabase === settings.database) throw new Error('auth: testDatabase is the live database; a hermetic run needs an isolated one');
          storage = settings.testDatabase;
        }
        activation.warn?.(ownerDatabaseWarning);
      }
      if (activation.seed !== undefined && !passwords) throw new Error('auth: tests/seed.json auth.users creates email and password accounts, which betterAuth.emailAndPassword.enabled: false turns off');
      const lock: ServerLock | undefined = typeof storage === 'string' ? await holdServerLock(storage, 'auth', settings.probe) : undefined;
      let database: DatabaseSync | undefined;
      let auth: ReturnType<typeof betterAuth>;
      try {
        const options = betterAuthOptions({ ...settings, database: storage }, activation.origin, mount);
        // Only the bundled file is the adapter's to open, migrate and close; an owner database is Better Auth's as given.
        database = owner ? undefined : databaseOf(options);
        if (!owner) {
          // The multi-process release's host lease table; nothing reads it any more.
          database?.exec('DROP TABLE IF EXISTS auth_servers');
          // A hermetic run starts from an empty database, so it creates the tables an operator creates with migrate.
          if (settings.hermetic === true) await migrate(options);
          const pending = await pendingMigrations(options);
          if (pending.length) throw new Error(`auth: Better Auth's tables are not initialized (${pending.join(', ')}); run npx urlcode-auth migrate`);
        }
        auth = betterAuth(options);
        // Better Auth starts a schema check on construction without awaiting it (#1013). Awaited here, it has finished
        // before a short run (validate) closes the connection, which it would otherwise report as a failed check, and
        // a real mismatch refuses activation instead of failing each request. Every later caller shares its verdict.
        // An adapter Better Auth cannot check (the memory adapter, for one) has none.
        await (await auth.$context).checkSchema?.();
        if (activation.seed !== undefined) await seedUsers(auth, activation.seed as AuthSeed);
      } catch (error) {
        database?.close(); lock?.release();
        throw error;
      }
      // The storage failure answer: Better Auth's own 500 or a throw carries no detail worth passing on, and nothing it
      // would set (a session cookie, a cleared one) is sent.
      const failed = (): HandlerResult => jsonResponse(503, { error: 'auth_unavailable' }, [['retry-after', '1']]);
      let closed = false;
      /**
       * Whether the session the request's cookie names is gone, read from the database (never the cookie cache) without
       * refreshing it: `true` when there is none, `false` when it is still valid, `undefined` when storage failed.
       */
      const sessionGone = async (headers: Headers): Promise<boolean | undefined> => {
        try { return await auth.api.getSession({ headers, query: { disableCookieCache: true, disableRefresh: true } }) === null; }
        catch (error) { return isClientError(error) ? true : undefined; }
      };
      return {
        // Better Auth's own handler, origin checks and cookies, for the listed paths only. The URL is rebuilt from the
        // path the allowlist checked, never from the raw request target.
        async handle(request: ExtensionRequest): Promise<HandlerResult> {
          const path = request.path.slice(mount.length);
          if (!served.has(path)) return jsonResponse(404, { error: 'not_found' });
          // Bound all formats, validate JSON without changing its bytes, and leave media-type admission to upstream.
          try {
            if ((request.headerCounts?.['content-type'] ?? 0) > 1) throw new ExtensionHttpError(400, 'duplicate_header');
            if (request.body.byteLength > maxRequestBodyBytes) throw new ExtensionHttpError(413, 'body_too_large');
            const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
            if (request.body.byteLength > 0 && (type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json')))) {
              const headers = new Headers(request.headers); headers.set('content-type', 'application/json');
              readBody({ ...request, headers }, { maxBytes: maxRequestBodyBytes });
            } else if (type === 'application/x-www-form-urlencoded' || type === 'text/plain') {
              try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(request.body);
                // Check encoded UTF-8 without interpreting fields or changing upstream's duplicate-field semantics.
                if (type === 'application/x-www-form-urlencoded') decodeURIComponent(text.replace(/%(?![0-9a-f]{2})/gi, '%25'));
              } catch { throw new ExtensionHttpError(400, 'invalid_encoding'); }
            }
          } catch (error) { if (error instanceof ExtensionHttpError) return jsonResponse(error.status, { error: error.code }); throw error; }
          const headers = new Headers(request.headers);
          headers.delete(clientAddressHeader);
          const address = clientKey(request.client ?? undefined);
          if (address) headers.set(clientAddressHeader, address);
          const url = new URL(request.path, activation.origin);
          url.search = request.query.toString();
          const init: RequestInit = { method: request.method, headers, ...(request.signal ? { signal: request.signal } : {}) };
          if (request.method !== 'GET' && request.method !== 'HEAD') init.body = Buffer.from(request.body);
          // A storage failure (a full disk, a lock held past the busy timeout) is Better Auth's own 500 or a throw.
          let response: Response;
          try { response = await auth.handler(new Request(url, init)); } catch { return failed(); }
          if (response.status >= 500) { await response.body?.cancel(); return failed(); }
          // Better Auth's sign-out logs a failed session delete and still answers success with a cleared cookie (#980),
          // and its session middleware answers 401 when reading the session failed. Neither is passed on unless the
          // database confirms it: a sign-out whose session survives, or a 401 for a session that exists (or could not be
          // read), is the 503 instead, and the client keeps its cookie to retry.
          const confirm = path === '/sign-out' ? response.status < 400 :response.status === 401 && sessionPaths.has(path);
          if (confirm && await sessionGone(headers) !== true) { await response.body?.cancel(); return failed(); }
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
            if (!isClientError(error)) return failed();
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
        close() { if (!closed) { closed = true; database?.close(); lock?.release(); } },
      };
    },
  };
}
