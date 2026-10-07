// An owner's own Better Auth database (#1052 S5): Better Auth's upstream memory adapter stands in for any adapter the
// operator passes in host.mjs. The SQLite path's tests are auth.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuthExtension, hermeticOwnerDatabaseRefusal, ownerDatabaseWarning } from '../src/index.ts';
import extension from '../src/extension.ts';

const origin = 'http://localhost:8123';
const secret = 's'.repeat(40);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
type Rows = Record<string, Record<string, unknown>[]>;

/** Better Auth's models as the memory adapter keeps them; `fail` makes every read or write of `session` throw. */
function memoryDatabase() {
  const state = { fail: false };
  let sessions: Record<string, unknown>[] = [];
  const rows: Rows = { user: [], account: [], verification: [], rateLimit: [] };
  Object.defineProperty(rows, 'session', {
    enumerable: true,
    get() { if (state.fail) throw new Error('simulated storage failure'); return sessions; },
    set(value: Record<string, unknown>[]) { if (state.fail) throw new Error('simulated storage failure'); sessions = value; },
  });
  return { rows, state, adapter: memoryAdapter(rows) };
}

async function project(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-owner-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const app = join(root, 'app'); await mkdir(join(app, 'functions'), { recursive: true });
  await writeFile(join(app, 'functions', 'me.mjs'), 'export default (request, context) => Response.json({ identity: context.capabilities?.auth?.identity ?? null });\n');
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: {} } }, routes: {
    '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] },
    '/me': { methods: ['GET', 'POST'], auth: true, function: { source: 'functions/me.mjs' } },
  } }));
  return { root, app, projectSha256: await inspectExtensionRevision(app) };
}

async function serve(t: test.TestContext, at: Awaited<ReturnType<typeof project>>, registration: ReturnType<typeof createAuthExtension>, seed?: unknown) {
  const events: Record<string, unknown>[] = [];
  const server = await startServer({ project: at.app, origin, port: 0, log: event => { events.push(event as Record<string, unknown>); }, extensions: [registration], ...(seed === undefined ? {} : { seed: seed as Record<string, unknown> }) });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  let cookie = '';
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.method && init.method !== 'GET' ? { origin } : {}), ...(cookie ? { cookie } : {}), ...init.headers };
    const response = await fetch(base + path, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }) });
    const set = response.headers.getSetCookie();
    if (set.length) cookie = set.some(line => /max-age=0/i.test(line)) ? '' : set.map(line => line.split(';')[0]).join('; ');
    return response;
  };
  return { call, events, cookie: () => cookie };
}
const warnings = (events: Record<string, unknown>[]) => events.filter(event => event.event === 'extension_warning').map(event => event.message);

async function createUser(adapter: ReturnType<typeof memoryAdapter>): Promise<string> {
  const auth = betterAuth({ database: adapter, secret, baseURL: origin, emailAndPassword: { enabled: true }, telemetry: { enabled: false }, logger: { disabled: true } });
  return (await auth.api.signUpEmail({ body: { email: 'ann@example.test', password: 'ann-local-password', name: 'Ann' } })).user.id;
}

test('an owner database serves sign-in, the gate, confirmed sign-out and the 503 contract, and warns once', async t => {
  const at = await project(t), live = memoryDatabase(), userId = await createUser(live.adapter);
  const { call, events } = await serve(t, at, createAuthExtension({ projectSha256: at.projectSha256, database: live.adapter, secret, betterAuth: { logger: { disabled: true } } }));
  assert.deepEqual(warnings(events), [ownerDatabaseWarning], 'one warning naming what is now the owner\'s');
  assert.equal((await call('/me')).status, 401);
  const before = live.rows.session!.length;
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
  assert.deepEqual(await (await call('/me')).json(), { identity: { userId } });
  assert.equal(live.rows.session!.length, before + 1, 'the session is in the owner database');
  // The allowlist and the body bounds do not depend on the database.
  assert.equal((await call('/api/auth/update-user', { method: 'POST', body: {} })).status, 404);
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
  // A storage failure is 503 auth_unavailable, on the gate, the session endpoints and sign-out, never a false 401.
  live.state.fail = true;
  for (const [method, path] of [['GET', '/me'], ['GET', '/api/auth/list-sessions'], ['POST', '/api/auth/sign-out']] as const) {
    const refused = await call(path, method === 'GET' ? {} : { method, body: {} });
    assert.equal(refused.status, 503, path);
    assert.deepEqual(await refused.json(), { error: 'auth_unavailable' }, path);
    assert.deepEqual(refused.headers.getSetCookie(), [], path);
  }
  live.state.fail = false;
  assert.equal((await call('/me')).status, 200, 'the session survived the failed sign-out');
  assert.equal((await call('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
  assert.equal(live.rows.session!.length, before);
  assert.equal((await call('/me')).status, 401);
  // No bundled SQLite file, lock file or data directory was made for it.
  assert.deepEqual(await readdir(at.root), ['app']);
});

test('a hermetic run with an owner database and no isolated one is refused, never served from live data', async t => {
  const at = await project(t), live = memoryDatabase();
  const data = await mkdtemp(join(tmpdir(), 'urlcode-auth-owner-hermetic-')); t.after(() => rm(data, { recursive: true, force: true }));
  const hosted = await extension.definition.host({ projectSha256: at.projectSha256, site: at.root, data, hermetic: true, get: () => undefined as never }, { database: live.adapter });
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [hosted.registration] }), error => (error as Error).message.includes(hermeticOwnerDatabaseRefusal));
  // A registration built by hand refuses the same way, and refuses the live database handed back as the test one.
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: live.adapter, secret, hermetic: true })] }), /needs an isolated one/);
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: live.adapter, testDatabase: live.adapter, secret, hermetic: true })] }), /testDatabase is the live database/);
  assert.deepEqual(Object.values(live.rows).map(rows => rows.length), [0, 0, 0, 0, 0], 'nothing touched the live database');
});

test('a hermetic run with an owner test database seeds it through Better Auth and never touches the live one', async t => {
  const at = await project(t), live = memoryDatabase();
  const data = await mkdtemp(join(tmpdir(), 'urlcode-auth-owner-hermetic-')); t.after(() => rm(data, { recursive: true, force: true }));
  const isolated: { rows?: Rows; data?: string } = {};
  const hosted = await extension.definition.host({ projectSha256: at.projectSha256, site: at.root, data, hermetic: true, get: () => undefined as never }, {
    database: live.adapter, secretFile: 'missing.secret', betterAuth: { logger: { disabled: true } },
    testDatabase: context => { const fresh = memoryDatabase(); isolated.rows = fresh.rows; isolated.data = context.data; return fresh.adapter; },
  });
  assert.equal(isolated.data, data, 'the factory gets the run\'s temporary data directory');
  const seed = { auth: { users: [{ id: 'ann', email: 'Ann@Example.test', password: 'ann-local-password' }] } };
  const { call, events } = await serve(t, at, hosted.registration, seed);
  assert.deepEqual(warnings(events), [ownerDatabaseWarning]);
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
  assert.deepEqual(await (await call('/me')).json(), { identity: { userId: 'ann' } });
  assert.deepEqual(isolated.rows!.user!.map(user => [user.id, user.email]), [['ann', 'ann@example.test']]);
  assert.deepEqual(Object.values(live.rows).map(rows => rows.length), [0, 0, 0, 0, 0], 'the live database is untouched');
  assert.equal(await stat(join(at.root, 'data')).then(() => true, () => false), false, 'no marker or file in the site data directory');
});

test('email and password is a default the owner can turn off', async t => {
  const at = await project(t), live = memoryDatabase();
  await createUser(live.adapter);
  const betterAuthOff = { emailAndPassword: { enabled: false }, logger: { disabled: true } };
  const { call } = await serve(t, at, createAuthExtension({ projectSha256: at.projectSha256, database: live.adapter, secret, betterAuth: betterAuthOff }));
  for (const path of ['/api/auth/sign-in/email', '/api/auth/change-password', '/api/auth/sign-up/email'])
    assert.equal((await call(path, { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password', newPassword: 'x'.repeat(10), currentPassword: 'y'.repeat(10) } })).status, 404, path);
  assert.equal((await call('/api/auth/get-session')).status, 200, 'the session endpoints still answer');
  assert.equal((await call('/me')).status, 401);
  assert.throws(() => createAuthExtension({ projectSha256: at.projectSha256, database: live.adapter, secret, signUp: true, betterAuth: betterAuthOff }), /signUp serves email and password sign-up/);
  const seed = { auth: { users: [{ id: 'bob', email: 'bob@example.test', password: 'bob-local-password' }] } };
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: live.adapter, testDatabase: memoryDatabase().adapter, secret, hermetic: true, betterAuth: betterAuthOff })], seed }), /creates email and password accounts/);
  assert.throws(() => createAuthExtension({ projectSha256: at.projectSha256, database: live.adapter, secret, betterAuth: { database: live.adapter } }), /not betterAuth\.database|pass Better Auth's database/);
});

test('with an owner database the urlcode-auth commands refuse; going back to the bundled file lifts it', async t => {
  const at = await project(t), live = memoryDatabase();
  await mkdir(join(at.root, 'data'), { recursive: true });
  await writeFile(join(at.root, 'data', 'auth.secret'), `${secret}\n`, { mode: 0o600 });
  const host = (options: object) => extension.definition.host({ projectSha256: at.projectSha256, site: at.root, data: join(at.root, 'data'), hermetic: false, get: () => undefined as never }, options);
  await assert.rejects(async () => host({ testDatabase: () => live.adapter }), /testDatabase is only for an owner database/);
  await host({ database: live.adapter });
  const run = (args: string[]) => spawnSync(process.execPath, ['--conditions=development', cli, ...args, '--site', at.root], { encoding: 'utf8', input: '{}', env: { ...process.env, BETTER_AUTH_SECRET: '' } });
  for (const args of [['migrate'], ['create-user'], ['find-user', '--email', 'ann@example.test']]) {
    const refused = run(args);
    assert.equal(refused.status, 2, args.join(' '));
    assert.match(refused.stderr, /manages only the bundled SQLite file, and this site's host\.mjs gives Better Auth the owner's own database/);
  }
  assert.equal(await stat(join(at.root, 'data', 'auth.sqlite')).then(() => true, () => false), false, 'nothing created the bundled file');
  await host({});
  assert.equal(run(['migrate']).status, 0);
});

test('seeding runs the owner\'s validateUserInfo and database hooks in a hermetic seed context (#1058)', async t => {
  const at = await project(t);
  const validated: unknown[] = [], hooked: unknown[] = [];
  const seen = (ctx: unknown) => {
    const context = ctx as { request?: unknown; headers?: Headers; path?: unknown } | null | undefined;
    return context ? { request: context.request ?? null, headers: context.headers ? [...context.headers] : null, path: context.path ?? null } : context;
  };
  const owner = {
    logger: { disabled: true },
    user: {
      validateUserInfo: (info: { user: { email?: string }; source: unknown }, ctx: unknown) => {
        validated.push({ email: info.user.email, source: info.source, ctx: seen(ctx) });
        return info.user.email?.endsWith('@example.test') ? undefined : { error: 'outside_domain' };
      },
    },
    databaseHooks: {
      user: { create: {
        before: async (user: { id: string }, ctx: unknown) => { hooked.push(['user.before', user.id, seen(ctx)]); },
        after: async (user: { id: string }, ctx: unknown) => { hooked.push(['user.after', user.id, seen(ctx)]); },
      } },
      account: { create: { after: async (account: { userId: string }, ctx: unknown) => { hooked.push(['account.after', account.userId, seen(ctx)]); } } },
    },
  };
  const hermeticWith = (betterAuth: object) => createAuthExtension({ projectSha256: at.projectSha256, database: memoryDatabase().adapter, testDatabase: memoryDatabase().adapter, secret, hermetic: true, betterAuth: betterAuth as never });
  const seed = { auth: { users: [{ id: 'ann', email: 'ann@example.test', password: 'ann-local-password' }] } };
  const { call } = await serve(t, at, hermeticWith(owner), seed);
  const hermetic = { request: null, headers: [], path: null };
  assert.deepEqual(validated, [{ email: 'ann@example.test', source: { method: 'email-password', action: 'create-user' }, ctx: hermetic }]);
  assert.deepEqual(hooked, [['user.before', 'ann', hermetic], ['user.after', 'ann', hermetic], ['account.after', 'ann', hermetic]]);
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
  // A validator that rejects a seeded user refuses the run, naming the hook, the user and the validator's error.
  const outside = { auth: { users: [{ id: 'bob', email: 'bob@elsewhere.test', password: 'bob-local-password' }] } };
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [hermeticWith(owner)], seed: outside }), /seeded user bob.*validateUserInfo.*outside_domain/);
  // A create.before hook that cancels the user refuses the run, naming the hook.
  const cancelling = { logger: { disabled: true }, databaseHooks: { user: { create: { before: async () => false } } } };
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [hermeticWith(cancelling)], seed: outside }), /seeded user bob.*databaseHooks\.user\.create\.before/);
});
