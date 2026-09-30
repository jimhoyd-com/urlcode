import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi, renderOpenApi, startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { serverLockHeld } from '@jimhoyd/urlcode/sqlite';
import { betterAuth } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { authOpenApiSecurity, betterAuthOptions, createAuthExtension, migrate } from '../src/index.ts';
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
  return { call, jar, base };
}
/** The server in its own process on the project's database, as `urlcode serve` runs it; its base URL. */
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
/** `urlcode-auth create-user` in its own process for `<name>@example.test`: its exit code and stderr. */
const createUser = (at: Awaited<ReturnType<typeof project>>, name: string) => new Promise<{ code: number | null; stderr: string }>(resolve => {
  const run = spawn(process.execPath, ['--conditions=development', cli, 'create-user', '--site', at.root], { env: { ...process.env, BETTER_AUTH_SECRET: secret } });
  let stderr = '';
  run.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  run.on('exit', code => resolve({ code, stderr }));
  run.stdin.end(JSON.stringify({ email: `${name}@example.test`, password: `${name}-local-password`, name }));
});
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

test('an auth database directory on a network filesystem is refused on Linux and not checked elsewhere (#941)', async t => {
  const at = await project(t); await withUser(at);
  const start = (probe: object) => startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret, probe })] });
  for (const [type, name] of [[0x6969, 'NFS'], [0xff534d42 - 2 ** 32, 'CIFS'], [0x65735546, 'FUSE']] as const)
    await assert.rejects(start({ platform: 'linux', statfs: async () => ({ type }) }), new RegExp(`The auth database is on a ${name} filesystem`));
  const darwin = await start({ platform: 'darwin', statfs: async () => ({ type: 0x6969 }) });
  at.defer(() => darwin.close());
  const ext4 = await start({ platform: 'linux', statfs: async () => ({ type: 0xef53 }) });
  at.defer(() => ext4.close());
});

test('a second serving process for the auth database is refused, and a restart after SIGKILL is accepted', { timeout: 120_000 }, async t => {
  const at = await project(t), userId = await withUser(at);
  /** A server process (serve-child.ts) killed with SIGKILL by the test; resolves with its port, or its stderr if it exits first. */
  const launch = async (): Promise<{ port?: number; stderr: string; kill(): Promise<void> }> => {
    const child = spawn(process.execPath, ['--conditions=development', serveChild, at.app, at.database, at.projectSha256, '{}'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const kill = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } };
    at.defer(kill);
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    return new Promise(resolve => {
      let out = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; if (out.includes('\n')) resolve({ port: (JSON.parse(out.slice(0, out.indexOf('\n'))) as { port: number }).port, stderr, kill }); });
      void exited.then(() => resolve({ stderr, kill }));
    });
  };
  const first = await launch();
  assert.ok(first.port, first.stderr);
  const second = await launch();
  assert.equal(second.port, undefined);
  assert.match(second.stderr, /Another process is already serving this auth database \(.+auth\.sqlite\): URLCode serves each database from one process/);
  // The first one is killed: the operating system drops its lock, and a restart serves the same accounts at once.
  await first.kill();
  // Windows releases a terminated process's locks after an OS-determined delay rather than at exit.
  for (const deadline = Date.now() + 10_000; serverLockHeld(at.database);) {
    assert.ok(Date.now() < deadline, 'the killed server\'s lock was not released within 10 s');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const restarted = await launch();
  assert.ok(restarted.port, restarted.stderr);
  const answered = await signIn(`http://127.0.0.1:${restarted.port!}`, 'ann-local-password');
  assert.equal(answered.status, 200);
  assert.equal(((await answered.json()) as { user: { id: string } }).user.id, userId);
});

test('an activation that fails after taking the server lock releases it (#979)', async t => {
  const at = await project(t);
  const registration = createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret, hermetic: true });
  const users = [{ id: 'ann', email: 'ann@example.test', password: 'ann-local-password' }, { id: 'bob', email: 'ann@example.test', password: 'bob-local-password' }];
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [registration], seed: { auth: { users } } }), /UNIQUE constraint failed/);
  assert.equal(serverLockHeld(at.database), false);
});

test('a hermetic host ignores the site database and secret, creates the tables and seeds accounts with their ids (#930)', async t => {
  const at = await project(t);
  const data = await mkdtemp(join(tmpdir(), 'urlcode-auth-hermetic-')); at.defer(() => rm(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const hosted = await extension.definition.host({ projectSha256: at.projectSha256, site: at.root, data, hermetic: true, get: () => undefined as never }, { database: at.database, secretFile: 'missing.secret' });
  assert.ok(hosted.registration.seedSchema, 'a hermetic registration accepts a seed');
  const seed = { auth: { users: [{ id: 'ann', email: 'Ann@Example.test', password: 'ann-local-password' }] } };
  const server = await startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [hosted.registration], seed });
  at.defer(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  const signedIn = await signIn(base, 'ann-local-password');
  assert.equal(signedIn.status, 200, await signedIn.clone().text());
  const cookie = signedIn.headers.getSetCookie().map(line => line.split(';')[0]).join('; ');
  assert.deepEqual((await (await fetch(`${base}/me`, { headers: { cookie } })).json() as { identity: unknown }).identity, { userId: 'ann' });
  assert.equal(await stat(at.database).then(() => true, () => false), false, 'the site database is never created');
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [hosted.registration], seed: { auth: { users: [{ id: 'not an id', email: 'x@example.test', password: 'long enough' }] } } }), /tests\/seed\.json auth\.users\.0\.id: must match pattern/);
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

test('OpenAPI states the session cookie without publishing or inventing the name the operator configures (#1047)', async t => {
  const at = await project(t); await withUser(at);
  const prefix = 'operator-chosen-prefix', settings = { betterAuth: { advanced: { cookiePrefix: prefix } } };
  const registration = createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret, ...settings });
  // One declaration: the definition (so urlcode.json and the release catalog) and the registration host() returns.
  const descriptor = JSON.parse(await readFile(fileURLToPath(new URL('../urlcode.json', import.meta.url)), 'utf8')) as { openapiSecurity?: unknown };
  assert.deepEqual(registration.openapiSecurity, authOpenApiSecurity);
  assert.deepEqual(extension.definition.openapiSecurity, authOpenApiSecurity);
  assert.deepEqual(descriptor.openapiSecurity, authOpenApiSecurity);
  assert.deepEqual({ type: authOpenApiSecurity.type, in: 'in' in authOpenApiSecurity ? authOpenApiSecurity.in : undefined, name: 'name' in authOpenApiSecurity ? authOpenApiSecurity.name : undefined }, { type: 'apiKey', in: 'cookie', name: undefined });
  for (const extensions of [undefined, [registration]]) {
    const document = await buildOpenApi(at.app, { origin, ...(extensions ? { extensions } : {}) });
    const me = document.paths['/me']!.get as { security?: unknown; responses: Record<string, unknown>; 'x-urlcode'?: { authentication?: unknown } };
    assert.equal(me.security, undefined, 'no security requirement names a cookie a client would have to invent');
    assert.deepEqual(me['x-urlcode']?.authentication, [{ extension: 'auth', credential: 'cookie', cookieName: 'operator-defined', description: authOpenApiSecurity.description }]);
    assert.ok(me.responses['401']);
    assert.equal(document.components.securitySchemes, undefined);
    const text = renderOpenApi(document);
    for (const leaked of [prefix, 'better-auth', 'session_token', secret]) assert.ok(!text.includes(leaked), leaked);
  }
  // The name really is the operator's: the served sign-in sets the prefixed cookie the document leaves out.
  const { call, jar } = await serve(at, settings);
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
  assert.ok([...jar.keys()].some(name => name.startsWith(`${prefix}.`)), [...jar.keys()].join(', '));
});

test('a sign-out whose session delete fails answers 503 and keeps the cookie, and the session still works (#980)', async t => {
  const at = await project(t), userId = await withUser(at);
  const { call, jar } = await serve(at, { betterAuth: { logger: { disabled: true } } });
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
  const cookies = [...jar];
  const fault = new DatabaseSync(at.database, { timeout: 5000 }); at.defer(() => { if (fault.isOpen) fault.close(); });
  fault.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON session BEGIN SELECT RAISE(ABORT, 'simulated disk I/O error'); END");
  // Better Auth logs the failed delete and answers success with a cleared cookie; the mount confirms and refuses.
  for (const path of ['/api/auth/sign-out', '/api/auth/revoke-sessions']) {
    const refused = await call(path, { method: 'POST', body: {} });
    assert.equal(refused.status, 503, path);
    assert.deepEqual(refused.headers.getSetCookie(), [], path);
    assert.deepEqual(await refused.json(), { error: 'auth_unavailable' });
  }
  assert.deepEqual([...jar], cookies, 'the client keeps its cookie');
  assert.deepEqual(await (await call('/me')).json(), { identity: { userId }, cookie: null }, 'and it was told the truth: the session is valid');
  fault.exec('DROP TRIGGER fail_delete');
  assert.equal((await call('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
  assert.equal(jar.size, 0);
  // The token taken before sign-out is dead too.
  const stolen = cookies.map(([name, value]) => `${name}=${value}`).join('; ');
  assert.equal((await call('/me', { headers: { cookie: stolen } })).status, 401);
  // No session at all: sign-out is still a success.
  assert.equal((await call('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
});

test('a storage failure reading the session answers 503 on the session endpoints, never a 401 that signs the client out (#980)', async t => {
  const at = await project(t); await withUser(at);
  const { call, jar } = await serve(at, { betterAuth: { logger: { disabled: true } } });
  assert.equal((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status, 200);
  // Better Auth on its own, without the mount, for comparison.
  const raw = betterAuthOptions({ database: at.database, secret, betterAuth: { logger: { disabled: true } } }, origin, '/api/auth');
  at.defer(() => (raw.database as DatabaseSync).close());
  const upstream = betterAuth(raw);
  assert.equal((await upstream.handler(new Request(`${origin}/api/auth/ok`))).status, 200);
  const fault = new DatabaseSync(at.database, { timeout: 5000 }); at.defer(() => { if (fault.isOpen) fault.close(); });
  // Every read of the session table fails, as an I/O error would.
  fault.exec('ALTER TABLE session RENAME TO session_moved');
  // Its session middleware reads the failure as "no session": a 401 that tells the client it is signed out.
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  assert.equal((await upstream.handler(new Request(`${origin}/api/auth/list-sessions`, { headers: { cookie } }))).status, 401);
  const attempts: [string, string, unknown][] = [['GET', '/api/auth/list-sessions', undefined], ['POST', '/api/auth/revoke-session', { token: 'x' }], ['POST', '/api/auth/revoke-other-sessions', {}], ['POST', '/api/auth/change-password', { currentPassword: 'ann-local-password', newPassword: 'ann-other-password' }]];
  for (const [method, path, body] of attempts) {
    const refused = await call(path, { method, body });
    assert.equal(refused.status, 503, path);
    assert.deepEqual(refused.headers.getSetCookie(), [], path);
  }
  fault.exec('ALTER TABLE session_moved RENAME TO session');
  assert.equal((await call('/api/auth/list-sessions')).status, 200);
  // Without a session, those endpoints still answer 401.
  assert.equal((await call('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
  assert.equal((await call('/api/auth/list-sessions')).status, 401);
  assert.equal((await call('/api/auth/list-sessions', { headers: { cookie: 'better-auth.session_token=forged.token' } })).status, 401);
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

test('a body holding an unpaired surrogate is refused with core\'s 400 invalid_unicode before Better Auth parses it (#1016)', async t => {
  const at = await project(t); await withUser(at);
  const { call, jar } = await serve(at, { signUp: true });
  const refused = async (path: string, body: unknown) => {
    const response = await call(path, { method: 'POST', body });
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: 'invalid_unicode' });
  };
  await refused('/api/auth/sign-up/email', { email: 'bob@example.test', password: 'bob-local-password', name: '\ud800Bob' });
  await refused('/api/auth/sign-up/email', { email: 'bob@example.test', password: 'bob-local-password', name: 'Bob', ['\udc00']: 1 });
  await refused('/api/auth/sign-in/email', { email: 'ann@example.test', password: 'ann-local-password\udbff' });
  assert.equal(jar.size, 0, 'no session cookie was set');
  const probe = new DatabaseSync(at.database, { readOnly: true });
  try { assert.equal((probe.prepare('SELECT count(*) AS n FROM user WHERE email = ?').get('bob@example.test') as { n: number }).n, 0, 'no account was created'); }
  finally { probe.close(); }
  // The reader's other refusals apply too; a well-formed body, a surrogate pair included, still reaches Better Auth.
  const plain = await call('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: { email: 'ann@example.test', password: 'ann-local-password' } });
  assert.equal(plain.status, 415);
  assert.equal((await plain.json() as { code: string }).code, 'UNSUPPORTED_MEDIA_TYPE');
  const signedUp = await call('/api/auth/sign-up/email', { method: 'POST', body: { email: 'bob@example.test', password: 'bob-local-password', name: 'Bob 😀' } });
  assert.equal(signedUp.status, 200);
  assert.equal(((await signedUp.json()) as { user: { name: string } }).user.name, 'Bob \u{1F600}');
});

test('sign-in is throttled per admitted client address, whatever forwarding header a client sends', async t => {
  const at = await project(t); await withUser(at);
  const { call } = await serve(at);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 12; attempt++) statuses.push((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'guess' }, headers: { 'x-forwarded-for': `203.0.113.${attempt}`, 'x-urlcode-client-address': `203.0.113.${attempt}` } })).status);
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('a served, non-hermetic mount answers 429 on the eleventh sign-in within a minute (#1019)', async t => {
  const at = await project(t); await withUser(at);
  const { call } = await serve(at);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 11; attempt++) statuses.push((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status);
  assert.deepEqual(statuses, [...Array<number>(10).fill(200), 429]);
});

test('a hermetic instance allows ten times each rate limit and still answers 429 past it (#1019)', async t => {
  const at = await project(t); await withUser(at);
  const rules = (options: ReturnType<typeof betterAuthOptions>) => { (options.database as DatabaseSync).close(); return options.rateLimit!; };
  const served = rules(betterAuthOptions({ database: at.database, secret }, origin, '/api/auth'));
  assert.deepEqual([served.enabled, served.storage, served.max, served.customRules], [true, 'database', 100, { '/sign-in/email': { window: 60, max: 10 }, '/sign-up/email': { window: 60, max: 5 } }]);
  const hermetic = rules(betterAuthOptions({ database: at.database, secret, hermetic: true }, origin, '/api/auth'));
  assert.deepEqual([hermetic.enabled, hermetic.storage, hermetic.max, hermetic.customRules], [true, 'database', 1000, { '/sign-in/email': { window: 60, max: 100 }, '/sign-up/email': { window: 60, max: 50 } }]);
  // An operator's own rules are scaled the same way; one they disabled stays disabled, and a rule function's answer is scaled.
  const custom = rules(betterAuthOptions({ database: at.database, secret, hermetic: true, betterAuth: { rateLimit: { max: 7, customRules: { '/sign-in/email': () => ({ window: 30, max: 3 }), '/ok': false } } } }, origin, '/api/auth'));
  assert.equal(custom.max, 70);
  assert.equal(custom.customRules!['/ok'], false);
  const rule = custom.customRules!['/sign-in/email'];
  assert.ok(typeof rule === 'function');
  assert.deepEqual(await rule(new Request(origin), { window: 60, max: 10 }), { window: 30, max: 30 });
  // Served for a hermetic run: the limiter is still on, keyed by the admitted address, at its raised bound.
  const { call } = await serve(at, { hermetic: true, betterAuth: { rateLimit: { customRules: { '/sign-in/email': { window: 60, max: 2 } } } } });
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 21; attempt++) statuses.push((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'ann-local-password' } })).status);
  assert.deepEqual(statuses, [...Array<number>(20).fill(200), 429]);
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

test('the sign-in limit is kept in the database, so a restart does not reset it', async t => {
  const at = await project(t); await withUser(at);
  const statuses: number[] = [];
  for (const round of [0, 1]) {
    const server = await startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret })] });
    try { for (let attempt = 0; attempt < 6; attempt++) statuses.push((await signIn(`http://127.0.0.1:${server.address.port}`, 'guess')).status); }
    finally { await server.close(); }
    assert.equal(statuses.length, 6 * (round + 1));
  }
  // An in-memory limiter would start over at the restart and let each run take 10.
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
      const created = await createUser(at, name);
      assert.equal(created.code, 0, created.stderr);
    }
  } finally { stop = true; await load; }
  assert.ok(served.length > 20, `the server committed throughout (${served.length} requests)`);
  assert.deepEqual([...new Set(served)], [200]);
  assert.equal((await signIn(base, 'ann-local-password')).status, 200);
});

test('urlcode-auth create-user takes the write lock between the slow commits of a saturated server', async t => {
  const at = await project(t); await withUser(at);
  // A writer that holds the write lock for 100 ms of every commit and frees it for a 2 ms timer between commits (a
  // request's response I/O), as a saturated server does when each flush is slow (FlushFileBuffers on Windows). SQLite's
  // busy handler, polling up to every 100 ms for 2 seconds, mostly found the lock held and failed with "database is
  // locked". A writer with no gap at all can still starve the operator command for its whole 10 seconds (README).
  const writer = spawn(process.execPath, [fileURLToPath(new URL('../../../test/slow-commit-writer.ts', import.meta.url)), at.database, '100', '2'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => writer.once('exit', resolve));
  let out = '';
  writer.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
  at.defer(async () => { writer.stdin.end(); await exited; });
  await new Promise<void>((resolve, reject) => { writer.stdout.on('data', () => { if (out.includes('ready')) resolve(); }); void exited.then(() => reject(new Error(`slow-commit-writer exited: ${out}`))); });
  for (const name of ['eve', 'fay', 'gus']) {
    const created = await createUser(at, name);
    assert.equal(created.code, 0, created.stderr);
  }
  writer.stdin.end(); await exited;
  const { commits } = JSON.parse(out.slice(out.indexOf('{'))) as { commits: number };
  assert.ok(commits > 5, `the writer committed throughout (${commits} commits)`);
});

test('the scaffold writes the mount and a private secret; host() reads it; the CLI migrates and creates a user', async t => {
  const site = await mkdtemp(join(tmpdir(), 'urlcode-auth-site-')); t.after(() => rm(site, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const scaffold = await extension.definition.scaffold!({ site, project: join(site, 'app'), installed: ['auth'], principalProviders: ['auth'], acknowledgements: [] });
  assert.deepEqual(Object.keys(scaffold.routes), ['/api/auth/*']);
  const file = scaffold.files![0]!;
  assert.equal(file.path, 'data/auth.secret');
  assert.equal(file.mode, 0o600);
  await assert.rejects(async () => extension.definition.host({ projectSha256: 'a'.repeat(64), site, data: join(site, 'data'), hermetic: false, get: () => undefined as never }, {}), /auth secret data\/auth\.secret is missing/);
  await mkdir(join(site, 'data'), { recursive: true });
  await writeFile(join(site, file.path), file.content, { mode: 0o600 });
  const hosted = await extension.definition.host({ projectSha256: 'a'.repeat(64), site, data: join(site, 'data'), hermetic: false, get: () => undefined as never }, {});
  assert.equal(hosted.registration.name, 'auth');
  assert.equal(hosted.registration.seedSchema, undefined, 'only a hermetic host accepts a test seed');
  const run =(args: string[], input?: string) => spawnSync(process.execPath, ['--conditions=development', cli, ...args, '--site', site], { encoding: 'utf8', input, env: { ...process.env, BETTER_AUTH_SECRET: '' } });
  assert.equal(run(['migrate']).status, 0);
  const database = join(site, 'data', 'auth.sqlite');
  if (process.platform !== 'win32') assert.equal((await stat(database)).mode & 0o777, 0o600);
  const probe = new DatabaseSync(database, { readOnly: true });
  try { assert.equal((probe.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal'); }
  finally { probe.close(); }
  const created = run(['create-user'], JSON.stringify({ email: 'rita@example.test', password: 'rita-local-password', name: 'Rita' }));
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /"event":"user-created"/);
  // An unpaired surrogate is refused, never stored as U+FFFD (#1016).
  const surrogate = run(['create-user'], JSON.stringify({ email: 'sam@example.test', password: 'sam-local-password', name: '\ud800Sam' }));
  assert.equal(surrogate.status, 2);
  assert.match(surrogate.stderr, /unpaired surrogate escape/);
  assert.equal(run(['find-user', '--email', 'sam@example.test']).status, 1);
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


test('native JSON, form sign-in and declared plugin formats agree with Better Auth (#1039)', async t => {
  const at = await project(t); await withUser(at);
  const plugin = { id: 'format-proof', endpoints: {
    echo: createAuthEndpoint('/format-proof', { method: 'POST', metadata: { allowedMediaTypes: ['text/plain', 'application/example+json'] } }, async ctx => ctx.json({ body: ctx.body })),
  } };
  const settings = { paths: ['/format-proof'], betterAuth: { plugins: [plugin] } };
  const { base } = await serve(at, settings);
  const options = betterAuthOptions({ database: at.database, secret, ...settings }, origin, '/api/auth');
  at.defer(() => (options.database as DatabaseSync).close());
  const upstream = betterAuth(options);
  const compare = async (path: string, contentType: string, body: string, source = origin) => {
    const init = { method: 'POST', headers: { 'content-type': contentType, origin: source }, body };
    const direct = await upstream.handler(new Request(origin + '/api/auth' + path, init));
    const mounted = await fetch(base + '/api/auth' + path, init);
    assert.equal(mounted.status, direct.status, path);
    return { direct, mounted };
  };
  for (const [type, body] of [
    ['application/json', JSON.stringify({ email: 'ann@example.test', password: 'ann-local-password' })],
    ['application/x-www-form-urlencoded', 'email=ann%40example.test&password=ann-local-password'],
  ]) {
    const { direct, mounted } = await compare('/sign-in/email', type!, body!);
    assert.equal(mounted.status, 200);
    assert.ok(mounted.headers.getSetCookie().length);
    assert.equal((await mounted.json() as { user: { email: string } }).user.email, (await direct.json() as { user: { email: string } }).user.email);
  }
  const echoed = await compare('/format-proof', 'text/plain; charset=utf-8', 'provider-native 😀 %FF');
  assert.equal(echoed.mounted.status, 200);
  assert.deepEqual(await echoed.mounted.json(), await echoed.direct.json());
  const suffix = await compare('/format-proof', 'application/example+json', '{"native":true}');
  assert.equal(suffix.mounted.status, 200);
  assert.deepEqual(await suffix.mounted.json(), await suffix.direct.json());
  const malformed = await fetch(base + '/api/auth/format-proof', { method: 'POST', headers: { origin, 'content-type': 'application/example+json' }, body: '{"native":"\\ud800"}' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid_unicode' });
  const denied = await compare('/sign-in/email', 'application/x-www-form-urlencoded', 'email=ann%40example.test&password=ann-local-password', 'https://foreign.example');
  assert.equal(denied.mounted.status, 403);
  assert.equal(denied.mounted.headers.getSetCookie().length, 0);
  const unsupported = await compare('/format-proof', 'application/octet-stream', 'provider-native');
  assert.equal(unsupported.mounted.status, 415);
  assert.deepEqual(await unsupported.mounted.json(), await unsupported.direct.json());
  const closed = await fetch(base + '/api/auth/another-plugin', { method: 'POST', body: 'x' });
  assert.equal(closed.status, 404);
});

test('form and plugin bodies retain size and encoding guards without rewriting fields (#1039)', async t => {
  const at = await project(t); await withUser(at);
  const { base } = await serve(at);
  for (const body of ['email=%ED%A0%80&password=x', 'email=%FF&password=x', new Uint8Array([0xff])]) {
    const response = await fetch(base + '/api/auth/sign-in/email', { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_encoding' });
    assert.equal(response.headers.getSetCookie().length, 0);
  }
  // Only the head is sent: the 413 must arrive while the declared body is still unsent, i.e. before it is read (#1046).
  const { host, port } = new URL(base);
  const large = await new Promise<string>((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1');
    let data = '';
    socket.on('error', reject);
    socket.on('data', chunk => { data += chunk; if (data.includes('\r\n')) { socket.destroy(); resolve(data.slice(0, data.indexOf('\r\n'))); } });
    socket.on('close', () => reject(new Error('closed before a status line: ' + JSON.stringify(data))));
    socket.write(`POST /api/auth/sign-in/email HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${1024 * 1024 + 1}\r\n\r\n`);
  });
  assert.match(large, /^HTTP\/1\.1 413 /);
});
