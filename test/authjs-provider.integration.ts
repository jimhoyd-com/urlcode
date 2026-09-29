// Auth replaceability (#841): the private-requests application with a second, independently owned auth library,
// Auth.js (@auth/core), behind the same principal and `identity` capability boundary as the first-party Better Auth
// extension. The provider is an independent package, proofs/authjs-provider (`@example/urlcode-authjs`), packed to a
// local tarball; core and the store are packed exactly as a release packs them. Nothing here imports
// @jimhoyd/urlcode-auth or Better Auth. Like test:proof it needs the npm registry for @auth/core; run it after
// `npm run build` and the add-on builds (npm run test:proof:authjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { parse } from 'yaml';
import { packAddons } from '../scripts/pack-addons.ts';
import { repositoryRoot } from '../scripts/workspaces.ts';

const proofs = join(repositoryRoot, 'proofs');
const proof = join(proofs, 'private-requests-authjs'), betterAuthProof = join(proofs, 'private-requests'), provider = join(proofs, 'authjs-provider');
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface Run { status: number | null; stdout: string; stderr: string }
function run(t: TestContext, cwd: string, command: string, args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env }, shell: command === 'npm.cmd' });
  t.diagnostic(`${command === process.execPath ? 'node' : command} ${args.join(' ').slice(0, 160)} -> ${result.status}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const npm = (t: TestContext, cwd: string, args: string[], env: Record<string, string> = {}): Run => run(t, cwd, npmCommand, npmCli ? [npmCli, ...args] : args, env);
const urlcode = (t: TestContext, site: string, args: string[], env: Record<string, string> = {}): Run => run(t, site, process.execPath, [join(site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'cli.js'), ...args], env);
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }).on('error', reject);
});
const packDirectory = (t: TestContext, directory: string, out: string): string => {
  const packed = npm(t, out, ['pack', '--ignore-scripts', '--json', '--pack-destination', out, directory]);
  assert.equal(packed.status, 0, packed.stderr);
  return join(out, (JSON.parse(packed.stdout) as { filename: string }[])[0]!.filename);
};

/** A cookie-keeping client that behaves like a same-origin browser on `origin`. */
function browser(origin: string) {
  const jar = new Map<string, string>();
  const call = async (path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<{ status: number; json: unknown; headers: Headers }> => {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (init.method && init.method !== 'GET') headers.origin ??= origin;
    let body: string | undefined;
    if (init.form) { headers['content-type'] ??= 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
    else if (init.body !== undefined) { headers['content-type'] ??= 'application/json'; body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body); }
    const response = await fetch(origin + path, { method: init.method ?? 'GET', headers, redirect: 'manual', ...(body === undefined ? {} : { body }) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';'), split = pair.indexOf('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(cookie)) jar.delete(pair.slice(0, split)); else jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const text = await response.text();
    let json: unknown = text;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: response.status, json, headers: response.headers };
  };
  return Object.assign(call, { jar });
}
type Browser = ReturnType<typeof browser>;
/** Auth.js's own sign-in: a CSRF token, then the Credentials callback, answered as JSON rather than a redirect. */
async function authjsAction(client: Browser, action: string, fields: Record<string, string> = {}): Promise<{ status: number; url?: string | undefined }> {
  const csrf = await client('/api/auth/csrf');
  if (csrf.status !== 200) return { status: csrf.status };
  const answer = await client(`/api/auth/${action}`, { method: 'POST', form: { ...fields, csrfToken: (csrf.json as { csrfToken: string }).csrfToken }, headers: { 'x-auth-return-redirect': '1' } });
  return { status: answer.status, url: (answer.json as { url?: string }).url };
}
/** 200 for a completed sign-in, 401 for one Auth.js reported as failed, or the HTTP status that refused it. */
async function signIn(client: Browser, email: string, password: string): Promise<number> {
  const { status, url } = await authjsAction(client, 'callback/credentials', { email, password });
  if (status !== 200) return status;
  return new URL(url!).searchParams.has('error') ? 401 : 200;
}

test('private-requests with Auth.js: an independently owned provider behind the same boundary', { timeout: 1200000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-authjs-'));
  const closers: (() => unknown)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    while (closers.length) try { await closers.pop()!(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Proof cleanup failed');
  });
  closers.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  await t.test('only the provider and its host wiring differ from the Better Auth application', async () => {
    const [ours, theirs] = await Promise.all([proof, betterAuthProof].map(async site => parse(await readFile(join(site, 'app', 'urlcode.yaml'), 'utf8')) as { extensions: Record<string, unknown>; routes: Record<string, Record<string, unknown>> }));
    assert.deepEqual(ours!.extensions.store, theirs!.extensions.store, 'the store declaration is identical');
    for (const route of ['/', '/assets/*']) {
      const { description: _a, ...before } = theirs!.routes[route]!, { description: _b, ...after } = ours!.routes[route]!;
      assert.deepEqual(after, before);
    }
    assert.deepEqual(Object.keys(ours!.routes).sort(), Object.keys(theirs!.routes).sort());
    for (const route of ['/api/requests/*', '/api/approvals/*', '/api/review/*']) {
      const { description: _a, ...before } = theirs!.routes[route]!, { description: _b, ...after } = ours!.routes[route]!;
      // Protection is written identically: `auth: true` expands to the one declared extension that provides the
      // principal (#888), policies.extensions.auth there and policies.extensions.authjs here.
      assert.equal(after.auth, true);
      assert.deepEqual(after, before);
    }
    for (const file of ['index.html', join('assets', 'style.css')]) assert.equal(await readFile(join(proof, 'app', 'public', file), 'utf8'), await readFile(join(betterAuthProof, 'app', 'public', file), 'utf8'));
    // No default-provider types or packages anywhere in the provider package or the site's own code.
    for (const file of [join(provider, 'extension.js'), join(proof, 'host.mjs'), join(proof, 'operator', 'auth.mjs'), join(proof, 'operator', 'users.mjs'), join(proof, 'scripts', 'setup.mjs'), join(proof, 'client', 'main.js')]) {
      assert.doesNotMatch(await readFile(file, 'utf8'), /(?:from|import\(|require\()\s*['"](?:@jimhoyd\/urlcode-auth|better-auth|@better-auth\/)/, file);
    }
    for (const file of [join(provider, 'package.json'), join(proof, 'package.json')]) {
      const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, string> | undefined>;
      const named = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap(field => Object.keys(manifest[field] ?? {}));
      assert.deepEqual(named.filter(name => /urlcode-auth$|better-auth/.test(name)), [], file);
    }
  });

  const packed = await packAddons(join(root, 'packed'));
  const addons = { URLCODE_ADDONS: packed.manifest };
  const tarball = packDirectory(t, provider, join(root, 'packed'));
  // This checkout's CLI with the packed add-on pins, for a site that has not installed its own core yet.
  const checkout = (t: TestContext, cwd: string, args: string[], env: Record<string, string> = {}): Run => run(t, cwd, process.execPath, [join(repositoryRoot, 'dist', 'cli.js'), ...args], { ...addons, ...env });

  await t.test('the provider installs from a local tarball with extensions add, as an independent package', async () => {
    const created = checkout(t, root, ['init', 'fresh']);
    assert.equal(created.status, 0, created.stderr);
    const fresh = join(root, 'fresh'), file = join(fresh, 'package.json');
    const pkg = JSON.parse(await readFile(file, 'utf8')) as { dependencies: Record<string, string> };
    pkg.dependencies['@jimhoyd/urlcode'] = `file:${packed.core}`;
    await writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
    const added = checkout(t, fresh, ['extensions', 'add', tarball, '--json']);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    const result = JSON.parse(added.stdout) as { added: string[]; projectSha256: string };
    assert.deepEqual(result.added, ['authjs']);
    const lock = JSON.parse(await readFile(join(fresh, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity?: string; version?: string }> };
    assert.match(lock.packages['node_modules/@example/urlcode-authjs']?.integrity ?? '', /^sha512-/);
    assert.equal(lock.packages['node_modules/@auth/core']?.version, '0.41.3');
    const listed = checkout(t, fresh, ['extensions', 'list', '--strict', '--json']);
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    const report = JSON.parse(listed.stdout) as { addons: { name: string; package: string; independent?: boolean; pinned: boolean }[] };
    assert.deepEqual(report.addons.map(item => [item.name, item.package, item.independent, item.pinned]), [['authjs', '@example/urlcode-authjs', true, true]]);
    assert.match(await readFile(join(fresh, 'app', 'routes', 'authjs.yaml'), 'utf8'), /\/api\/auth\/\*:[\s\S]*extension: authjs/);
    assert.match(await readFile(join(fresh, 'host.mjs'), 'utf8'), /from '@example\/urlcode-authjs\/extension'/);
    // Scaffolded host.mjs passes no Auth.js providers: activation refuses before serving rather than serving nothing.
    const refused = checkout(t, fresh, ['validate', '--local', '--project', 'app', '--host-file', 'host.mjs', '--origin', 'https://site.example'], { PROJECT_SHA256: result.projectSha256 });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /no Auth\.js providers are configured/);
    assert.equal(checkout(t, fresh, ['extensions', 'remove', 'authjs', '--json']).status, 0);
  });

  await t.test('an independent package cannot take the first-party name auth, and the auth: short form does not need it', async () => {
    const renamed = join(root, 'renamed');
    await cp(provider, renamed, { recursive: true });
    const descriptor = JSON.parse(await readFile(join(renamed, 'urlcode.json'), 'utf8')) as { name: string };
    await writeFile(join(renamed, 'urlcode.json'), JSON.stringify({ ...descriptor, name: 'auth' }));
    const pkgFile = join(renamed, 'package.json'), pkg = JSON.parse(await readFile(pkgFile, 'utf8')) as { name: string };
    await writeFile(pkgFile, JSON.stringify({ ...pkg, name: '@example/urlcode-authjs-as-auth' }));
    const renamedTarball = packDirectory(t, renamed, join(root, 'packed'));
    const refused = checkout(t, join(root, 'fresh'), ['extensions', 'add', renamedTarball, '--json']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /names itself auth, which is a first-party extension released with this core/);
  });

  const site = join(root, 'site');
  await cp(proof, site, { recursive: true, filter: source => !/[/\\](node_modules|data)$/.test(source) && !source.endsWith('policy.json') && !source.endsWith(join('assets', 'app.js')) });
  const manifestFile = join(site, 'package.json'), pkg = JSON.parse(await readFile(manifestFile, 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies['@jimhoyd/urlcode'] = `file:${packed.core}`;
  pkg.dependencies['@jimhoyd/urlcode-store'] = `file:${packed.tarballs.store!}`;
  pkg.dependencies['@example/urlcode-authjs'] = `file:${tarball}`;
  await writeFile(manifestFile, JSON.stringify(pkg, null, 2) + '\n');

  assert.equal(npm(t, site, ['install', '--no-audit', '--no-fund']).status, 0);
  assert.equal(npm(t, site, ['run', 'build']).status, 0);
  const setup = npm(t, site, ['run', '-s', 'setup']);
  assert.equal(setup.status, 0, setup.stderr);
  const users = (JSON.parse(setup.stdout.trim().split('\n').at(-1)!) as { users: Record<string, string> }).users;
  assert.equal(Object.keys(users).length, 3);
  assert.deepEqual((JSON.parse(npm(t, site, ['run', '-s', 'setup']).stdout.trim().split('\n').at(-1)!) as { users: unknown }).users, users);

  // Installed by plain npm, so nothing recorded their files yet: naming them to `extensions add` records them (#857).
  const recorded = urlcode(t, site, ['extensions', 'add', 'store', tarball, '--json'], addons);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const listed = urlcode(t, site, ['extensions', 'list', '--strict', '--json'], addons);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const extensions = JSON.parse(listed.stdout) as { addons: { name: string; package: string; independent?: boolean; pinned: boolean; problems: string[] }[]; problems: string[] };
  assert.deepEqual(extensions.addons.map(item => [item.name, item.package, item.independent ?? false, item.pinned, item.problems]).sort(), [['authjs', '@example/urlcode-authjs', true, true, []], ['store', '@jimhoyd/urlcode-store', false, true, []]]);
  assert.equal(urlcode(t, site, ['validate', '--project', 'app']).status, 0);

  const port = await freePort(), origin = `http://localhost:${port}`;
  const hosted = ['--project', 'app', '--host-file', 'host.mjs', '--origin', origin];
  const policy = join(site, 'operator', 'policy.json');
  const proposal = urlcode(t, site, ['permissions', '--project', 'app']);
  assert.equal(proposal.status, 0, proposal.stderr);
  await writeFile(policy, proposal.stdout);
  const approved = [...hosted, '--policy', policy];
  const valid = urlcode(t, site, ['validate', '--local', ...approved]);
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  const reviewEnv = { PROJECT_SHA256: (JSON.parse(proposal.stdout) as { projectSha256: string }).projectSha256 };
  const protectedRoute = urlcode(t, site, ['explain', '/api/requests', '--project', 'app', '--host-file', 'host.mjs'], reviewEnv);
  assert.match(protectedRoute.stdout, /handler receives context\.capabilities\.authjs: identity/);
  // `auth: true` expanded to the principal provider, not to an extension named auth (#888).
  assert.match(protectedRoute.stdout, /extensions\.authjs: requires \{\}/);
  assert.doesNotMatch(protectedRoute.stdout, /extensions\.auth:/);

  await t.test('OpenAPI describes a route gated by authjs with its 401/403 and session scheme (#888)', async () => {
    // The protected routes are store mounts, which OpenAPI lists but never enumerates; one ordinary route shows the gate.
    const yamlFile = join(site, 'app', 'urlcode.yaml'), yaml = await readFile(yamlFile, 'utf8');
    try {
      await writeFile(yamlFile, yaml + '  /api/whoami:\n    methods: [GET]\n    auth: true\n    respond: {text: signed in}\n');
      for (const args of [[], ['--host-file', 'host.mjs']]) {
        const exported = urlcode(t, site, ['openapi', '--project', 'app', ...args], reviewEnv);
        assert.equal(exported.status, 0, exported.stdout + exported.stderr);
        const document = JSON.parse(exported.stdout) as { paths: Record<string, { get: { security?: unknown; responses: Record<string, unknown> } }>; components: { securitySchemes?: Record<string, { 'x-urlcode'?: unknown }> } };
        assert.deepEqual(document.paths['/api/whoami']!.get.security, [{ 'urlcodeSession.authjs': [] }]);
        assert.deepEqual(Object.keys(document.paths['/api/whoami']!.get.responses).sort(), ['200', '401']); // 403 is declared only on unsafe methods (#881)
        assert.deepEqual(document.components.securitySchemes?.['urlcodeSession.authjs']?.['x-urlcode'], { extension: 'authjs', cookieName: 'operator-defined' });
      }
    } finally { await writeFile(yamlFile, yaml); }
  });

  await t.test('provider misconfiguration and a sandboxed capability refuse before serving', async () => {
    const empty = join(root, 'empty-data');
    const missing = urlcode(t, site, ['validate', '--local', ...approved], { PRIVATE_REQUESTS_DATA: empty });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout + missing.stderr, /authjs secret .*is missing/);
    const short = urlcode(t, site, ['validate', '--local', ...approved], { AUTH_SECRET: 'too-short' });
    assert.notEqual(short.status, 0);
    assert.match(short.stdout + short.stderr, /at least 32 characters/);
    const yamlFile = join(site, 'app', 'urlcode.yaml'), yaml = await readFile(yamlFile, 'utf8');
    try {
      await mkdir(join(site, 'app', 'functions'));
      await writeFile(join(site, 'app', 'functions', 'sandboxed.mjs'), 'export default (_request, context) => Response.json({ capabilities: Object.keys(context.capabilities ?? {}) });\n');
      await writeFile(yamlFile, yaml + '  /api/sandboxed:\n    methods: [GET]\n    auth: true\n    sandbox: true\n    function: {source: functions/sandboxed.mjs}\n');
      const sandboxProposal = urlcode(t, site, ['permissions', '--project', 'app']);
      assert.equal(sandboxProposal.status, 0, sandboxProposal.stdout + sandboxProposal.stderr);
      await writeFile(policy, sandboxProposal.stdout);
      const sandboxed = urlcode(t, site, ['validate', '--local', ...approved]);
      assert.notEqual(sandboxed.status, 0);
      assert.match(sandboxed.stdout + sandboxed.stderr, /capabilit/);
    } finally {
      await rm(join(site, 'app', 'functions'), { recursive: true, force: true });
      await writeFile(yamlFile, yaml);
      await writeFile(policy, proposal.stdout);
    }
  });

  // The declarative fixtures, signed-in steps included, on their own synthetic data at the documented origin.
  const fixtureEnv = { PRIVATE_REQUESTS_DATA: join(root, 'fixture-data') };
  assert.equal(npm(t, site, ['run', '-s', 'setup'], fixtureEnv).status, 0);
  const documented = ['--project', 'app', '--host-file', 'host.mjs', '--origin', 'http://localhost:4180', '--policy', policy];
  const fixtures = urlcode(t, site, ['test', ...documented], fixtureEnv);
  assert.equal(fixtures.status, 0, fixtures.stdout + fixtures.stderr);
  const audit = urlcode(t, site, ['audit', '--expect-routes', '6', ...documented, '--json'], fixtureEnv);
  const report = JSON.parse(audit.stdout.trim().split('\n').at(-1)!) as { countMatches: boolean; failed: number; ready: boolean; uncovered: unknown[] };
  assert.deepEqual([report.ready, report.countMatches, report.failed, report.uncovered], [true, true, 0, []], audit.stdout);

  const server = spawn(process.execPath, [join(site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'cli.js'), 'serve', ...approved, '--port', String(port)], { cwd: site, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => server.once('exit', resolve));
  closers.push(async () => { if (server.exitCode === null && server.signalCode === null) server.kill(); await exited; });
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`${origin}/_urlcode/ready`).then(response => response.ok, () => false)) break;
    assert.ok(attempt < 100 && server.exitCode === null, `server did not start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const ann = browser(origin), bob = browser(origin), rita = browser(origin);
  assert.equal(await signIn(ann, 'ann@example.test', 'wrong-password'), 401);
  assert.equal(ann.jar.has('authjs.session-token'), false);
  assert.equal(await signIn(ann, 'ann@example.test', 'ann-local-demo-password'), 200);
  assert.equal(await signIn(bob, 'bob@example.test', 'bob-local-demo-password'), 200);
  assert.equal(await signIn(rita, 'rita@example.test', 'rita-local-demo-password'), 200);

  type Page = { items: { id: string; title: string; status: string }[]; total: number };
  const titles = async (client: Browser, path: string): Promise<string[]> => ((await client(path)).json as Page).items.map(item => item.title);
  const errorCode = (response: { json: unknown }): string => (response.json as { error: { code: string } }).error.code;

  await t.test('identity comes from the verified session, permissions from the application', async () => {
    assert.equal(((await ann('/api/auth/session')).json as { user: { id: string } }).user.id, users['ann@example.test']);
    assert.equal(((await rita('/api/auth/session')).json as { user: { id: string } }).user.id, users['rita@example.test']);
    assert.equal((await ann('/api/review')).status, 403);
    assert.equal((await rita('/api/review')).status, 200);
    assert.equal((await ann('/api/review', { headers: { 'x-urlcode-context-authjs': users['rita@example.test']! } })).status, 403);
    // A session token Auth.js did not issue is no session: the secret encrypts it.
    const forged = browser(origin);
    forged.jar.set('authjs.session-token', ann.jar.get('authjs.session-token')!.slice(0, -4) + 'AAAA');
    assert.equal((await forged('/api/requests')).status, 401);
  });

  let annRequest = '';
  await t.test('owners create, list and read only their own requests', async () => {
    const created = await ann('/api/requests', { method: 'POST', body: { title: 'New laptop', details: 'Synthetic request' } });
    assert.equal(created.status, 201);
    annRequest = (created.json as { id: string }).id;
    assert.equal(Object.hasOwn(created.json as object, '_owner'), false);
    assert.equal((await bob('/api/requests', { method: 'POST', body: { title: 'Desk lamp' } })).status, 201);
    assert.deepEqual(await titles(ann, '/api/requests'), ['New laptop']);
    assert.deepEqual(await titles(bob, '/api/requests'), ['Desk lamp']);
    assert.deepEqual(await bob(`/api/requests/${annRequest}`).then(response => [response.status, errorCode(response)]), [404, 'not_found']);
    assert.equal((await rita(`/api/requests/${annRequest}`)).status, 404);
    assert.equal(((await rita(`/api/review/${annRequest}`)).json as { title: string }).title, 'New laptop');
  });

  await t.test('malformed and cross-origin input is refused', async () => {
    assert.equal((await ann('/api/requests', { method: 'POST', body: '{"title":' })).status, 400);
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: 'x', _owner: users['bob@example.test'] } })).status, 422);
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: 'x', status: 'approved' } })).status, 422);
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: 'x' }, headers: { origin: 'https://attacker.example' } })).status, 403);
    // Sign-in from another origin is refused by the mount; without the CSRF cookie Auth.js refuses it too.
    assert.equal((await browser(origin)('/api/auth/callback/credentials', { method: 'POST', form: { email: 'ann@example.test', password: 'ann-local-demo-password' }, headers: { origin: 'https://attacker.example' } })).status, 403);
    const noToken = await browser(origin)('/api/auth/callback/credentials', { method: 'POST', form: { email: 'ann@example.test', password: 'ann-local-demo-password' }, headers: { 'x-auth-return-redirect': '1' } });
    assert.match((noToken.json as { url: string }).url, /error=MissingCSRF/);
    // Only the allowlisted Auth.js actions are served: its built-in pages and OAuth callbacks are 404.
    for (const path of ['/api/auth/signin', '/api/auth/error', '/api/auth/callback/github']) assert.equal((await ann(path)).status, 404, path);
    assert.equal(((await ann('/api/requests')).json as Page).total, 1);
  });

  await t.test('only a reviewer approves, once, and never their own request', async () => {
    const missing = `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
    for (const [client, id] of [[bob, annRequest], [ann, annRequest], [bob, missing]] as const) {
      const refused = await client(`/api/approvals/${id}`, { method: 'POST' });
      assert.deepEqual([refused.status, errorCode(refused)], [403, 'membership_required']);
    }
    const own = (await rita('/api/requests', { method: 'POST', body: { title: 'Reviewer own request' } })).json as { id: string };
    assert.deepEqual(await rita(`/api/approvals/${own.id}`, { method: 'POST' }).then(response => [response.status, errorCode(response)]), [403, 'own_record_refused']);
    const racing = await Promise.all([1, 2, 3].map(() => rita(`/api/approvals/${annRequest}`, { method: 'POST' })));
    assert.deepEqual(racing.map(response => response.status).sort(), [200, 409, 409]);
    const approved = (await ann(`/api/requests/${annRequest}`)).json as { status: string; reviewedAt: string };
    assert.equal(approved.status, 'approved');
    assert.match(approved.reviewedAt, /^\d{4}-\d\d-\d\dT/);
  });

  await t.test('sign-out ends the browser session; Auth.js JWT sessions are not revocable server-side', async () => {
    const copied = ann.jar.get('authjs.session-token')!;
    const signedOut = await authjsAction(ann, 'signout');
    assert.equal(signedOut.status, 200);
    assert.equal(ann.jar.has('authjs.session-token'), false);
    assert.equal((await ann('/api/requests')).status, 401);
    // The gap, recorded rather than hidden: the signed-out token is still a valid encrypted JWT until it expires
    // (one hour in operator/auth.mjs). The Better Auth proof answers 401 here; Auth.js has no server-side session
    // to delete when Credentials sign-in forces the JWT strategy.
    const replay = browser(origin);
    replay.jar.set('authjs.session-token', copied);
    assert.equal((await replay('/api/requests')).status, 200);
    assert.equal(await signIn(ann, 'ann@example.test', 'ann-local-demo-password'), 200);
    assert.equal(((await ann('/api/requests')).json as Page).total, 1);
  });

  await t.test('sign-in attempts are throttled per client address by the declared policy', async () => {
    const attacker = browser(origin);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 40 && !statuses.includes(429); attempt++) statuses.push(await signIn(attacker, 'rita@example.test', 'guess'));
    assert.ok(statuses.includes(429), statuses.join(','));
    assert.ok(statuses.slice(0, -1).every(status => status === 401), statuses.join(','));
  });

  await t.test('the frontend is ordinary static files and the application client', async () => {
    const page = await fetch(origin + '/');
    assert.match(await page.text(), /<script type="module" src="\/assets\/app.js">/);
    const script = await fetch(origin + '/assets/app.js');
    assert.equal(script.status, 200);
    assert.match(await script.text(), /\/api\/auth\/callback\/credentials|callback\/credentials/);
  });
});
