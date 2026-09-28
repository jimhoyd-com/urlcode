import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/** A project with a Better Auth mount and one protected function route that echoes its identity. */
async function project(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app'); await mkdir(join(app, 'functions'), { recursive: true });
  await writeFile(join(app, 'functions', 'me.mjs'), 'export default (request, context) => Response.json({ identity: context.capabilities?.auth?.identity ?? null, cookie: request.headers.get("cookie") });\n');
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: {} } }, routes: {
    '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] },
    '/me': { methods: ['GET', 'POST'], auth: true, function: { source: 'functions/me.mjs' } },
  } }));
  return { root, app, database: join(root, 'auth.sqlite'), projectSha256: await inspectExtensionRevision(app) };
}
async function serve(t: test.TestContext, at: Awaited<ReturnType<typeof project>>, settings: { signUp?: boolean } = {}) {
  const server = await startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret, ...settings })] });
  t.after(() => server.close());
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
async function withUser(at: Awaited<ReturnType<typeof project>>): Promise<string> {
  const options = betterAuthOptions({ database: at.database, secret }, origin, '/api/auth', true);
  await migrate(options);
  return (await betterAuth(options).api.signUpEmail({ body: { email: 'ann@example.test', password: 'ann-local-password', name: 'Ann' } })).user.id;
}

test('activation refuses until Better Auth\'s tables exist', async t => {
  const at = await project(t);
  await assert.rejects(startServer({ project: at.app, origin, port: 0, log: () => {}, extensions: [createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret })] }), /tables are not initialized .*run npx urlcode-auth migrate/);
  assert.throws(() => createAuthExtension({ projectSha256: at.projectSha256, database: at.database, secret, paths: ['../escape'] }), /is not a Better Auth path/);
  assert.throws(() => betterAuthOptions({ database: at.database, secret: 'short' }, origin, '/api/auth'), /at least 32 characters/);
});

test('a protected route sees the verified user id, never the session cookie, and sign-out ends it', async t => {
  const at = await project(t), userId = await withUser(at);
  const { call, jar } = await serve(t, at);
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
  const { call } = await serve(t, at);
  for (const path of ['/api/auth/callback/github', '/api/auth/reset-password/token', '/api/auth/update-user', '/api/auth/delete-user']) assert.equal((await call(path)).status, 404, path);
  assert.equal((await call('/api/auth/sign-up/email', { method: 'POST', body: { email: 'bob@example.test', password: 'bob-local-password', name: 'Bob' } })).status, 404);
  assert.equal((await call('/api/auth/ok')).status, 200);
  const open = await serve(t, at, { signUp: true });
  assert.equal((await open.call('/api/auth/sign-up/email', { method: 'POST', body: { email: 'bob@example.test', password: 'bob-local-password', name: 'Bob' } })).status, 200);
});

test('sign-in is throttled per admitted client address, whatever forwarding header a client sends', async t => {
  const at = await project(t); await withUser(at);
  const { call } = await serve(t, at);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 12; attempt++) statuses.push((await call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'ann@example.test', password: 'guess' }, headers: { 'x-forwarded-for': `203.0.113.${attempt}`, 'x-urlcode-client-address': `203.0.113.${attempt}` } })).status);
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('the scaffold writes the mount and a private secret; host() reads it; the CLI migrates and creates a user', async t => {
  const site = await mkdtemp(join(tmpdir(), 'urlcode-auth-site-')); t.after(() => rm(site, { recursive: true, force: true }));
  const scaffold = await extension.definition.scaffold!({ site, project: join(site, 'app'), installed: ['auth'], acknowledgements: [] });
  assert.deepEqual(Object.keys(scaffold.routes), ['/api/auth/*']);
  const file = scaffold.files![0]!;
  assert.equal(file.path, 'data/auth.secret');
  assert.equal(file.mode, 0o600);
  await assert.rejects(async () => extension.definition.host({ projectSha256: 'a'.repeat(64), site, get: () => undefined, contributions: () => [] } as never, {}), /auth secret data\/auth\.secret is missing/);
  await mkdir(join(site, 'data'), { recursive: true });
  await writeFile(join(site, file.path), file.content, { mode: 0o600 });
  const hosted = await extension.definition.host({ projectSha256: 'a'.repeat(64), site, get: () => undefined, contributions: () => [] } as never, {});
  assert.equal(hosted.registration.name, 'auth');
  const run = (args: string[], input?: string) => spawnSync(process.execPath, ['--conditions=development', cli, ...args, '--site', site], { encoding: 'utf8', input, env: { ...process.env, BETTER_AUTH_SECRET: '' } });
  assert.equal(run(['migrate']).status, 0);
  await stat(join(site, 'data', 'auth.sqlite'));
  const created = run(['create-user'], JSON.stringify({ email: 'rita@example.test', password: 'rita-local-password', name: 'Rita' }));
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /"event":"user-created"/);
  assert.equal(run(['nonsense']).status, 2);
  assert.match(await readFile(join(site, file.path), 'utf8'), /^[A-Za-z0-9_-]{43}\n$/);
});
