// A composed application's account plumbing, from the bundled extensions alone (#1137): Better Auth accounts and
// sessions on the auth mount, an `auth: true` function route and an `auth: true` MCP mount. It pins what the
// composition supplies (sign-up, sign-in, sign-out revocation, an operator-selected Better Auth plugin for suspension)
// and where it stops (a session cookie from the site's own origin is the only credential the gate admits, and a tool
// handler is not told who called), so the guides can state both without a reader finding out by trial.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admin, bearer } from 'better-auth/plugins';
import { startServer } from '../packages/core/src/index.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import { createAuthExtension } from '../packages/auth/src/index.ts';
import { createMcpExtension } from '../packages/mcp/src/index.ts';

const origin = 'http://localhost:8137';
const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href);
const password = 'a long local test password';
const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } };

/** The last JSON-RPC message of an MCP reply, which the SDK answers as Server-Sent Events. */
async function rpc(response: Response): Promise<{ result?: { content?: { text: string }[] } }> {
  const text = await response.text();
  const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
  return JSON.parse(events.at(-1) ?? text) as { result?: { content?: { text: string }[] } };
}

async function site(t: test.TestContext) {
  const closers: (() => unknown)[] = [];
  t.after(async () => { while (closers.length) await closers.pop()!(); });
  const root = await mkdtemp(join(tmpdir(), 'urlcode-accounts-'));
  closers.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const app = join(root, 'app');
  await mkdir(join(app, 'functions'), { recursive: true });
  await writeFile(join(app, 'functions', 'me.mjs'), 'export default (request, context) => Response.json({ userId: context.capabilities.auth.identity.userId, authorization: request.headers.get("authorization"), cookie: request.headers.get("cookie") });\n');
  await writeFile(join(app, 'functions', 'open.mjs'), 'export default (request, context) => Response.json({ auth: context.capabilities?.auth ?? null, cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization") });\n');
  await writeFile(join(app, 'whoami.mjs'),'export default (_input, context) => ({ keys: Object.keys(context).sort() });\n');
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({
    version: '1',
    extensions: {
      auth: { version: '1', config: {} },
      mcp: { version: '1', config: { servers: { default: { mount: '/mcp', serverName: 'accounts', serverVersion: '1.0.0', tools: { whoami: { description: 'Reports the handler context keys.', inputSchema: { type: 'object', additionalProperties: false }, handler: './whoami.mjs' } } } } } },
    },
    routes: {
      '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] },
      '/api/me': { methods: ['GET', 'POST'], auth: true, function: { source: 'functions/me.mjs' } },
      '/api/open': { methods: ['GET'], auth: { required: false }, function: { source: 'functions/open.mjs' } },
      '/mcp/*': { extension: 'mcp', methods: ['POST', 'HEAD'], auth: true },
    },
  }));
  const projectSha256 = await inspectExtensionRevision(app);
  const server = await startServer({
    project: app, origin, port: 0, log: () => {},
    extensions: [
      createAuthExtension({
        projectSha256, database: join(root, 'data', 'auth.sqlite'), secret: 's'.repeat(40), hermetic: true, signUp: true,
        paths: ['/admin/ban-user', '/admin/unban-user', '/admin/list-users'],
        // Operator-selected Better Auth plugins: suspension is the admin plugin's, a bearer session token the bearer plugin's.
        betterAuth: {
          plugins: [admin(), bearer()],
          databaseHooks: { user: { create: { before: async user => ({ data: { ...user, role: user.email === 'admin@example.test' ? 'admin' : 'user' } }) } } },
        },
      }),
      createMcpExtension({ projectSha256 }),
    ],
  });
  closers.push(() => server.close());
  const base = `http://127.0.0.1:${server.address.port}`;
  /** One browser-like client: a cookie jar, and the site origin on unsafe methods unless `origin: null`. */
  const client = () => {
    const jar = new Map<string, string>();
    let token: string | null = null;
    const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; origin?: string | null; cookies?: boolean } = {}) => {
      const method = init.method ?? 'GET';
      const headers: Record<string, string> = { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers };
      const from = init.origin === undefined ? (method === 'GET' ? null : origin) : init.origin;
      if (from !== null) headers.origin = from;
      if (init.cookies !== false && jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await fetch(base + path, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = ''] = cookie.split(';'), at = pair.indexOf('=');
        if (/max-age=0/i.test(cookie)) jar.delete(pair.slice(0, at)); else jar.set(pair.slice(0, at), pair.slice(at + 1));
      }
      token = response.headers.get('set-auth-token') ?? token;
      return response;
    };
    const signUp = async (name: string) => {
      const response = await call('/api/auth/sign-up/email', { method: 'POST', body: { email: `${name}@example.test`, password, name } });
      assert.equal(response.status, 200, await response.clone().text());
      return ((await response.json()) as { user: { id: string } }).user.id;
    };
    return { call, signUp, jar, token: () => token };
  };
  return { client };
}

test('accounts, sessions and revocation come from the auth mount; the route reads only the verified user id', async t => {
  const { client } = await site(t);
  const alice = client(), bob = client(), anonymous = client();
  const aliceId = await alice.signUp('alice'), bobId = await bob.signUp('bob');
  assert.notEqual(aliceId, bobId);

  assert.equal((await anonymous.call('/api/me')).status, 401);
  const mine = await alice.call('/api/me');
  // The handler is handed the id and neither credential.
  assert.deepEqual(await mine.json(), { userId: aliceId, authorization: null, cookie: null });
  assert.equal(((await (await bob.call('/api/me')).json()) as { userId: string }).userId, bobId);

  // A write needs the site's own origin as well as the session: a foreign origin and an absent one are both refused.
  assert.equal((await alice.call('/api/me', { method: 'POST', body: {} })).status, 200);
  for (const from of ['https://attacker.example', null]) {
    const refused = await alice.call('/api/me', { method: 'POST', body: {}, origin: from });
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: 'cross_origin_refused' });
  }

  // A route that does not require a session is given no identity, even for a signed-in caller: an operation that
  // admits a session or some other credential cannot read "the session, if any" from the gate.
  const open = (await (await alice.call('/api/open', { headers: { authorization: 'Bearer some-other-credential' } })).json()) as { auth: unknown };
  assert.equal(open.auth, null);

  // Sign-out revokes the session in the database: the copied cookie no longer opens the route.
  const copied = new Map(alice.jar);
  assert.equal((await alice.call('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
  for (const [name, value] of copied) alice.jar.set(name, value);
  assert.equal((await alice.call('/api/me')).status, 401);
  // Another user's session is untouched.
  assert.equal((await bob.call('/api/me')).status, 200);
});

test('suspension is an operator-selected Better Auth plugin on the same mount, refused to everyone but its administrators', async t => {
  const { client } = await site(t);
  const administrator = client(), bob = client(), carol = client(), anonymous = client();
  await administrator.signUp('admin');
  const bobId = await bob.signUp('bob'), carolId = await carol.signUp('carol');

  // Only an administrator may suspend: an anonymous caller and an ordinary account are refused, and nothing changes.
  assert.equal((await anonymous.call('/api/auth/admin/ban-user', { method: 'POST', body: { userId: bobId } })).status, 401);
  assert.equal((await carol.call('/api/auth/admin/ban-user', { method: 'POST', body: { userId: bobId } })).status, 403);
  assert.equal((await carol.call('/api/auth/admin/list-users')).status, 403);
  assert.equal((await bob.call('/api/me')).status, 200);
  // A plugin path the operator did not list is not served at all.
  assert.equal((await administrator.call('/api/auth/admin/remove-user', { method: 'POST', body: { userId: bobId } })).status, 404);

  const banned = await administrator.call('/api/auth/admin/ban-user', { method: 'POST', body: { userId: bobId } });
  assert.equal(banned.status, 200, await banned.clone().text());
  // The suspended account's live session is revoked at once, and it cannot sign in again.
  assert.equal((await bob.call('/api/me')).status, 401);
  assert.notEqual((await bob.call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'bob@example.test', password } })).status, 200);
  assert.equal(((await (await carol.call('/api/me')).json()) as { userId: string }).userId, carolId);

  assert.equal((await administrator.call('/api/auth/admin/unban-user', { method: 'POST', body: { userId: bobId } })).status, 200);
  assert.equal((await bob.call('/api/auth/sign-in/email', { method: 'POST', body: { email: 'bob@example.test', password } })).status, 200);
  assert.equal((await bob.call('/api/me')).status, 200);
});

test('an auth: true MCP mount admits a signed-in browser on the site origin only, and its tool handler is not told who called', async t => {
  const { client } = await site(t);
  const alice = client(), anonymous = client();
  await alice.signUp('alice');
  const post = (who: ReturnType<typeof client>, body: unknown, init: { origin?: string | null; headers?: Record<string, string>; cookies?: boolean } = {}) =>
    who.call('/mcp', { method: 'POST', body, ...init, headers: { ...mcpHeaders, ...init.headers } });

  assert.equal((await post(anonymous, initialize)).status, 401);
  assert.equal((await post(alice, initialize)).status, 200);
  assert.equal((await post(alice, initialize, { origin: 'https://attacker.example' })).status, 403);

  // A non-browser MCP client sends no Origin. The MCP extension alone admits that; the session gate in front does not.
  const headless = await post(alice, initialize, { origin: null });
  assert.equal(headless.status, 403);
  assert.deepEqual(await headless.json(), { error: 'cross_origin_refused' });

  // A bearer session token (Better Auth's bearer plugin) identifies the caller on a read, and is still refused on the
  // MCP POST without the site origin: there is no token mode for an unsafe method.
  const token = alice.token();
  assert.ok(token, 'the bearer plugin returned a session token');
  const read = await anonymous.call('/api/me', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(read.status, 200);
  assert.equal((await post(anonymous, initialize, { origin: null, headers: { authorization: `Bearer ${token}` } })).status, 403);

  // The tool handler's context carries no principal or capability: a per-user tool has nothing to scope by.
  const called = await rpc(await post(alice, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } }));
  const { keys } = JSON.parse(called.result!.content![0]!.text) as { keys: string[] };
  assert.deepEqual(keys, ['env', 'kind', 'progress', 'requestId', 'server', 'signal', 'tool']);
});

test('a Better Auth plugin that adds columns serves from the bundled SQLite file once urlcode-auth migrate reads host.mjs (#1140)', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-accounts-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const app = join(root, 'app');
  await mkdir(app, { recursive: true });
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data', 'auth.secret'), `${'s'.repeat(40)}\n`, { mode: 0o600 });
  await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: {} } }, routes: { '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'] } } }));
  const host = join(root, 'host.mjs');
  await writeFile(host, `import { composeHost } from ${moduleUrl('../packages/core/src/host.ts')};
import auth from ${moduleUrl('../packages/auth/src/extension.ts')};
import { admin } from ${JSON.stringify(import.meta.resolve('better-auth/plugins'))};
export default await composeHost(import.meta.url, [auth({ betterAuth: { plugins: [admin()] }, paths: ['/admin/ban-user'] })]);
`);
  const env = { ...process.env };
  delete env.PROJECT_SHA256; delete env.BETTER_AUTH_SECRET;
  const node = (args: string[], more: Record<string, string> = {}) => spawnSync(process.execPath, ['--conditions=development', ...args], { cwd: root, encoding: 'utf8', env: { ...env, ...more } });
  const authCli = (args: string[]) => node([fileURLToPath(new URL('../packages/auth/src/cli.ts', import.meta.url)), ...args, '--site', root]);
  const validate = (extra: string[], more: Record<string, string> = {}) => node([fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url)), 'validate', '--project', app, '--host-file', host, '--local', ...extra], more);
  const pinned = { PROJECT_SHA256: await inspectExtensionRevision(app) };

  // A hermetic run creates the plugin's schema on its throwaway file, so it passes, and says what serving will need.
  const review = validate(['--local-review']);
  assert.equal(review.status, 0, review.stdout + review.stderr);
  assert.match(review.stdout + review.stderr, /"event":"extension_warning","extension":"auth","message":"betterAuth\.plugins add tables or columns \(user, session\) beyond Better Auth's own schema: before serving the bundled SQLite file, migrate it with npx urlcode-auth migrate --host-file host\.mjs/);

  // Without the host file, migrate creates Better Auth's own schema only, and serving refuses with the remedy that works.
  assert.equal(authCli(['migrate']).status, 0);
  const refused = validate(['--origin', origin], pinned);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout + refused.stderr, /not initialized \(user, session\); run npx urlcode-auth migrate --host-file host\.mjs, which also creates the tables and columns betterAuth\.plugins add/);

  // With it, migrate sees the plugin, creates its columns in the same file, and the site activates.
  const migrated = authCli(['migrate', '--host-file', host]);
  assert.equal(migrated.status, 0, migrated.stderr);
  // host.mjs names its site by its own real path (a macOS temporary directory is behind a symlink).
  assert.deepEqual(JSON.parse(migrated.stdout), { event: 'migrated', database: join(await realpath(root), 'data', 'auth.sqlite') });
  const served = validate(['--origin', origin], pinned);
  assert.equal(served.status, 0, served.stdout + served.stderr);

  // create-user and find-user read the same options, so an account carries the plugin's fields.
  const created = spawnSync(process.execPath, ['--conditions=development', fileURLToPath(new URL('../packages/auth/src/cli.ts', import.meta.url)), 'create-user', '--host-file', host, '--site', root], { cwd: root, encoding: 'utf8', env, input: JSON.stringify({ email: 'ann@example.test', password, name: 'Ann' }) });
  assert.equal(created.status, 0, created.stderr);
  const found = authCli(['find-user', '--email', 'ann@example.test', '--host-file', host]);
  assert.equal(found.status, 0, found.stderr);
  assert.equal((JSON.parse(found.stdout) as { id: string }).id, (JSON.parse(created.stdout) as { id: string }).id);
  const probe = new DatabaseSync(join(root, 'data', 'auth.sqlite'), { readOnly: true });
  try { assert.deepEqual(probe.prepare('SELECT role, banned FROM user').all().map(row => ({ ...row })), [{ role: 'user', banned: 0 }]); }
  finally { probe.close(); }

  // A host file that composes no auth extension is refused by name.
  const bare = join(root, 'bare.mjs');
  await writeFile(bare, `import { composeHost } from ${moduleUrl('../packages/core/src/host.ts')};\nexport default await composeHost(import.meta.url, []);\n`);
  const none = authCli(['migrate', '--host-file', bare]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /composes no auth extension/);
});
