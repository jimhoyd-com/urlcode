import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { betterAuth } from 'better-auth';
import { betterAuthOptions, createAuthExtension, migrate } from '../src/index.ts';
import extension from '../src/extension.ts';

const origin = 'http://localhost:8123';
const secret = 's'.repeat(40);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const serveChild = fileURLToPath(new URL('./serve-child.ts', import.meta.url));

/**
 * One unwind stack per test: node:test runs separate after hooks in registration order, which would remove the
 * directory while the server still holds its SQLite file (EBUSY on Windows). Every closer runs, newest first.
 */
function cleanup(t: test.TestContext): (close: () => unknown) => void {
  const closers: (() => unknown)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    while (closers.length) try { await closers.pop()!(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
  });
  return close => { closers.push(close); };
}
/** A project with a Better Auth mount and one protected function route that echoes its identity. */
async function project(t: test.TestContext) {
  const defer = cleanup(t);
  const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-')); defer(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const app = join(root, 'app'); await mkdir(join(app, 'functions'), { recursive: true });
  await writeFile(join(app, 'functions', 'me.mjs'), 'export default (request, context) => Response.json({ identity: context.capabilities?.auth?.identity ?? null, cookie: request.headers.get("cookie") });\n');
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: {} } }, routes: {
    '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] },
    '/me': { methods: ['GET', 'POST'], auth: true, function: { source: 'functions/me.mjs' } },
  } }));
  return { root, app, defer, database: join(root, 'data', 'auth.sqlite'), projectSha256: await inspectExtensionRevision(app) };
}
async function serve(at: Awaited<ReturnType<typeof project>>, settings: Partial<Parameters<typeof createAuthExtension>[0]> = {}) {
  const server = await startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret, ...settings })] });
  at.defer(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  const jar = new Map<string, string>();
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...(init.method && init.method !== 'GET' ? { origin } : {}), ...init.headers };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(base + path, { method: init.method ?? 'GET', headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    for (const cookie of response.headers.getSetCookie()) { const [pair = ''] = cookie.split(';'), at = pair.indexOf('='); if (/max-age=0/i.test(cookie)) jar.delete(pair.slice(0, at)); else jar.set(pair.slice(0, at), pair.slice(at + 1)); }
    return response;
  };
  return { call, jar };
}
/** A server in its own process on the project's database, as a second `urlcode serve` would be; its base URL. */
async function serveProcess(at: Awaited<ReturnType<typeof project>>, settings: object = {}): Promise<string> {
  const child = spawn(process.execPath, ['--conditions=development', serveChild, at.app, at.database, at.projectSha256, JSON.stringify(settings)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  at.defer(async () => {
    // Closing stdin closes the server and its SQLite handle (on Windows too) before the directory is removed.
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 10_000);
    await exited; clearTimeout(timer);
  });
  const line = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; if (out.includes('\n')) resolve(out.slice(0, out.indexOf('\n'))); });
    void exited.then(code => reject(new Error(`serve-child exited with ${String(code)} before listening`)));
  });
  return `http://127.0.0.1:${(JSON.parse(line) as { port: number }).port}`;
}
const signIn = (base: string, password: string) => fetch(`${base}/api/auth/sign-in/email`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email: 'ann@example.test', password }) });
async function withUser(at: Awaited<ReturnType<typeof project>>): Promise<string> {
  const options = betterAuthOptions({ database: at.database, secret }, origin, '/api/auth', true);
  try {
    await migrate(options);
    return (await betterAuth(options).api.signUpEmail({ body: { email: 'ann@example.test', password: 'ann-local-password', name: 'Ann' } })).user.id;
  } finally { (options.database as { close(): void }).close(); }
}

test('activation refuses until Better Auth\'s tables exist', async t => {
  const at = await project(t);
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret })] }), /tables are not initialized .*run npx urlcode-auth migrate/);
  // A database migrated without the shared rate-limit table is refused too, naming it.
  const withoutLimits = betterAuthOptions({ database: at.database, secret, betterAuth: { rateLimit: { storage: 'memory' } } }, origin, '/api/auth');
  try { await migrate(withoutLimits); } finally { (withoutLimits.database as DatabaseSync).close(); }
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret })] }), /tables are not initialized \(rateLimit\)/);
  assert.throws(() => createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret, paths: ['../escape'] }), /is not a Better Auth path/);
  assert.throws(() => betterAuthOptions({ database: at.database, secret: 'short' }, origin, '/api/auth'), /at least 32 characters/);
});

test('a protected route sees the verified user id, never the session cookie, and sign-out ends it', async t => {
  const at = await project(t), userId = await withUser(at);
  const { call, jar } = await serve(at);
  assert.deepEqual(await (await call('/me')).json(), { error: 'authentication_required' });
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'wrong-password' } })).status, 401);
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
  assert.ok(jar.size, 'Better Auth set its session cookie');
  assert.deepEqual(await (await call('/me')).json(), { identity: { userId }, cookie: null });
  // A client cannot claim an identity through the reserved context namespace.
  assert.equal((await call('/me', { headers: { 'x-urlcode-context-auth-session': 'someone-else' } })).status, 200);
  // Unsafe methods need same-origin provenance on protected routes, and Better Auth checks its own.
  assert.equal((await call('/me', { method: 'POST', body: {}, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await call('/api/auth/sign-out', { method: 'POST', body: {}, headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await call('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
  assert.equal((await call('/me')).status, 401);
});

test('only allowlisted Better Auth paths answer; sign-up is off unless the operator enables it', async t => {
  const at = await project(t); await withUser(at);
  const { call } = await serve(at);
  for (const path of ['/api/auth/callback/github', '/api/auth/reset-password/token', '/api/auth/update-user', '/api/auth/delete-user']) assert.equal((await call(path)).status, 404, path);
  assert.equal((await call('/api/auth/sign-up/email', { method: 'POST', body: { email: 'bob@example.test', password: 'bob-local-password', name: 'Bob' } })).status, 404);
  assert.equal((await call('/api/auth/ok')).status, 200);
  const open = await serve(at, { signUp: true });
  assert.equal((await open.call('/api/auth/sign-up/email', { method: 'POST', body: { email: 'bob@example.test', password: 'bob-local-password', name: 'Bob' } })).status, 200);
});

test('sign-in is throttled per admitted client address, whatever forwarding header a client sends', async t => {
  const at = await project(t); await withUser(at);
  const { call } = await serve(at);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 12; attempt++) statuses.push((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'guess' }, headers: { 'x-forwarded-for': `203.0.113.${attempt}`, 'x-urlcode-client-address': `203.0.113.${attempt}` } })).status);
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('a storage failure while verifying a session answers 503, not a false 401; a bad session stays 401', async t => {
  const at = await project(t), userId = await withUser(at);
  // updateAge 0: every verification refreshes the session, so it needs the write lock.
  const { call, jar } = await serve(at, { betterAuth: { session: { updateAge: 0 } } });
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
  // Another connection holds the write lock past the busy timeout, as a stuck process would.
  const lock = new DatabaseSync(at.database); at.defer(() => { if (lock.isOpen) lock.close(); });
  lock.exec('BEGIN IMMEDIATE');
  const refused = await call('/me');
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get('retry-after'), '1');
  assert.deepEqual(await refused.json(), { error: 'auth_unavailable' });
  lock.exec('ROLLBACK'); lock.close();
  // The session survived: it was never a sign-out.
  assert.deepEqual(await (await call('/me')).json(), { identity: { userId }, cookie: null });
  for (const [name] of jar) jar.set(name, 'forged.token');
  assert.deepEqual(await (await call('/me')).json(), { error: 'authentication_required' });
});

test('a storage failure during sign-in answers 503 auth_unavailable and sets no cookie, never Better Auth\'s 500', async t => {
  const at = await project(t); await withUser(at);
  const { call, jar } = await serve(at, { betterAuth: { logger: { disabled: true } } });
  // Another connection holds the write lock past the busy timeout, so the session insert fails (test/disk-full.test.ts
  // fails it with a full database instead).
  const lock = new DatabaseSync(at.database); at.defer(() => { if (lock.isOpen) lock.close(); });
  lock.exec('BEGIN IMMEDIATE');
  const refused = await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } });
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get('retry-after'), '1');
  assert.deepEqual(refused.headers.getSetCookie(), []);
  assert.deepEqual(await refused.json(), { error: 'auth_unavailable' });
  assert.equal(jar.size, 0);
  lock.exec('ROLLBACK'); lock.close();
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
});

test('the sign-in limit is one budget across every process serving the database', async t => {
  const at = await project(t); await withUser(at);
  const [first, second] = await Promise.all([serveProcess(at), serveProcess(at)]);
  const statuses: number[] = [];
  // Alternating between the processes: an in-memory limiter would let each take 10.
  for (let attempt = 0; attempt < 12; attempt++) statuses.push((await signIn(attempt % 2 ? second! : first!, 'guess')).status);
  assert.deepEqual(statuses, [...Array<number>(10).fill(401), 429, 429]);
});

test('urlcode-auth create-user succeeds while a serving process commits continuously', async t => {
  const at = await project(t); await withUser(at);
  // A limit high enough that every request below writes its rate-limit row: a steady stream of commits.
  const base = await serveProcess(at, { betterAuth: { rateLimit: { max: 1_000_000 } } });
  let stop = false; const served: number[] = [];
  const load = (async () => { while (!stop) served.push((await fetch(`${base}/api/auth/ok`)).status); })();
  try {
    for (const name of ['bea', 'cai', 'dev']) {
      const created = await new Promise<{ code: number | null; stderr: string }>(resolve => {
        const run = spawn(process.execPath, ['--conditions=development', cli, 'create-user', '--site', at.root], { env: { ...process.env, BETTER_AUTH_SECRET: secret } });
        let stderr = '';
        run.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        run.on('exit', code => resolve({ code, stderr }));
        run.stdin.end(JSON.stringify({ email: `${name}@example.test`, password: `${name}-local-password`, name }));
      });
      assert.equal(created.code, 0, created.stderr);
    }
  } finally { stop = true; await load; }
  assert.ok(served.length > 20, `the server committed throughout (${served.length} requests)`);
  assert.deepEqual([...new Set(served)], [200]);
  assert.equal((await signIn(base, 'ann-local-password')).status, 200);
});

test('the scaffold writes the mount and a private secret; host() reads it; the CLI migrates and creates a user', async t => {
  const site = await mkdtemp(join(tmpdir(), 'urlcode-auth-site-')); t.after(() => rm(site, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const scaffold = await extension.definition.scaffold!({ site, project: join(site, 'app'), installed: ['auth'], acknowledgements: [] });
  assert.deepEqual(Object.keys(scaffold.routes), ['/api/auth/*']);
  const file = scaffold.files![0]!;
  assert.equal(file.path, 'data/auth.secret');
  assert.equal(file.mode, 0o600);
  await assert.rejects(async () => extension.definition.host({ projectSha256: 'a'.repeat(64), site, get: () => undefined } as never, {}), /auth secret data\/auth\.secret is missing/);
  await mkdir(join(site, 'data'), { recursive: true });
  await writeFile(join(site, file.path), file.content, { mode: 0o600 });
  const hosted = await extension.definition.host({ projectSha256: 'a'.repeat(64), site, get: () => undefined } as never, {});
  assert.equal(hosted.registration.name, 'auth');
  const run = (args: string[], input?: string) => spawnSync(process.execPath, ['--conditions=development', cli, ...args, '--site', site], { encoding: 'utf8', input, env: { ...process.env, BETTER_AUTH_SECRET: '' } });
  assert.equal(run(['migrate']).status, 0);
  const database = join(site, 'data', 'auth.sqlite');
  if (process.platform !== 'win32') assert.equal((await stat(database)).mode & 0o777, 0o600);
  const probe = new DatabaseSync(database, { readOnly: true });
  try { assert.equal((probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal'); }
  finally { probe.close(); }
  const created = run(['create-user'], JSON.stringify({ email: 'rita@example.test', password: 'rita-local-password', name: 'Rita' }));
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /"event":"user-created"/);
  // find-user (#917) answers the id create-user printed, for the same email in any case, without raw SQL.
  const createdId = (JSON.parse(created.stdout) as { id: string }).id;
  const found = run(['find-user', '--email', 'RITA@example.test']);
  assert.equal(found.status, 0, found.stderr);
  const user = JSON.parse(found.stdout) as { event: string; id: string; email: string; name: string; createdAt: string };
  assert.deepEqual({ event: user.event, id: user.id, email: user.email, name: user.name }, { event: 'user-found', id: createdId, email: 'rita@example.test', name: 'Rita' });
  assert.ok(Math.abs(Date.parse(user.createdAt) - Date.now()) < 60_000, user.createdAt);
  const missing = run(['find-user', '--email', 'nobody@example.test']);
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout), { event: 'user-not-found', email: 'nobody@example.test' });
  assert.equal(run(['find-user']).status, 2);
  const empty = await mkdtemp(join(tmpdir(), 'urlcode-auth-empty-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const unmigrated = spawnSync(process.execPath, ['--conditions=development', cli, 'find-user', '--email', 'rita@example.test', '--site', empty], { encoding: 'utf8' });
  assert.equal(unmigrated.status, 1);
  assert.match(unmigrated.stderr, /No auth database at .*run urlcode-auth migrate/);
  await assert.rejects(stat(join(empty, 'data', 'auth.sqlite')), 'find-user never creates the database');
  assert.equal(run(['nonsense']).status, 2);
  assert.match(await readFile(join(site, file.path), 'utf8'), /^[A-Za-z0-9_-]{43}\n$/);
  if (process.platform !== 'win32') {
    await chmod(database, 0o644);
    assert.throws(() => betterAuthOptions({ database, secret }, origin, '/api/auth'), /must be a private regular file/);
  }
});
