// The #843 proof end to end with real npm: pack this checkout's core and add-ons as a release does, install core,
// @jimhoyd/urlcode-auth (Better Auth) and @jimhoyd/urlcode-store into a copy of proofs/private-requests, run the site's own scripts, and exercise
// the served application over HTTP. It needs the npm registry for better-auth and esbuild; run after `npm run build`
// and the add-on builds (npm run test:proof); like the other packaging tests it packs with --ignore-scripts. The test
// acts as the evaluator: it writes the operator policy from `urlcode permissions` explicitly, the step a person
// performs after review.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { packAddons } from '../scripts/pack-addons.ts';
import { repositoryRoot } from '../scripts/workspaces.ts';

const proof = join(repositoryRoot, 'proofs', 'private-requests');
// npm's own CLI under this Node, as `npm run test:proof` provides it: no shell, so Windows needs no npm.cmd quoting.
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface Run { status: number | null; stdout: string; stderr: string }
function run(t: TestContext, cwd: string, command: string, args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env }, shell: command === 'npm.cmd' });
  t.diagnostic(`${command} ${args.join(' ')} -> ${result.status}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const npm = (t: TestContext, cwd: string, args: string[], env: Record<string, string> = {}): Run => run(t, cwd, npmCommand, npmCli ? [npmCli, ...args] : args, env);
const urlcode = (t: TestContext, site: string, args: string[], env: Record<string, string> = {}): Run => run(t, site, process.execPath, [join(site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'cli.js'), ...args], env);
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }).on('error', reject);
});

/** A cookie-keeping client that behaves like a same-origin browser on `origin`. */
function browser(origin: string) {
  const jar = new Map<string, string>();
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal; rawBody?: BodyInit; duplex?: 'half' } = {}): Promise<{ status: number; json: unknown; headers: Headers }> => {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (init.method && init.method !== 'GET') headers.origin ??= origin;
    if (init.body !== undefined) headers['content-type'] ??= 'application/json';
    const response = await fetch(origin + path, { method: init.method ?? 'GET', headers, body: init.rawBody ?? (init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)), signal: init.signal, redirect: 'manual', ...(init.duplex ? { duplex: init.duplex } : {}) } as RequestInit);
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';'), split = pair.indexOf('=');
      if (/max-age=0/i.test(cookie)) jar.delete(pair.slice(0, split)); else jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const text = await response.text();
    let json: unknown = text;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: response.status, json, headers: response.headers };
  };
  return Object.assign(call, { jar });
}
const signIn = async (client: ReturnType<typeof browser>, email: string, password: string): Promise<number> => (await client('/api/auth/sign-in/email', { method: 'POST', body: { email, password } })).status;

test('private-requests: packed consumer, upstream auth, owner-private records and reviewer approval', { timeout: 1200000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-proof-'));
  // One unwind stack: node:test runs separate after hooks in registration order, which would remove the site while
  // the server still holds its SQLite files (EBUSY on Windows). Every closer is attempted, newest first.
  const closers: (() => unknown)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    while (closers.length) try { await closers.pop()!(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Proof cleanup failed');
  });
  closers.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  // Core and the auth extension exactly as a release packs them; `manifest` pins each add-on tarball by sha512.
  const packed = await packAddons(join(root, 'packed'));
  const addons = { URLCODE_ADDONS: packed.manifest };
  const site = join(root, 'site');
  await cp(proof, site, { recursive: true, filter: source => !/[/\\](node_modules|data)$/.test(source) && !source.endsWith('policy.json') && !source.endsWith(join('assets', 'app.js')) });
  // The committed site links the in-repository packages; the copy depends on the packed tarballs at core's pins.
  const manifestFile = join(site, 'package.json'), pkg = JSON.parse(await readFile(manifestFile, 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies['@jimhoyd/urlcode'] = `file:${packed.core}`;
  pkg.dependencies['@jimhoyd/urlcode-auth'] = `file:${packed.tarballs.auth!}`;
  pkg.dependencies['@jimhoyd/urlcode-store'] = `file:${packed.tarballs.store!}`;
  await writeFile(manifestFile, JSON.stringify(pkg, null, 2) + '\n');

  // Installation and build may use the network; nothing after them does.
  assert.equal(npm(t, site, ['install', '--no-audit', '--no-fund']).status, 0);
  assert.equal(npm(t, site, ['run', 'build']).status, 0);
  const setup = npm(t, site, ['run', '-s', 'setup']);
  assert.equal(setup.status, 0, setup.stderr);
  const users = (JSON.parse(setup.stdout.trim().split('\n').at(-1)!) as { users: Record<string, string> }).users;
  assert.equal(Object.keys(users).length, 3);
  // Setup is safe to re-run and keeps the same accounts.
  assert.deepEqual((JSON.parse(npm(t, site, ['run', '-s', 'setup']).stdout.trim().split('\n').at(-1)!) as { users: unknown }).users, users);

  // Auth and the store are first-party catalog extensions, installed at core's pins, declared and hosted; checked
  // statically without host code.
  // Installed by plain npm, so nothing recorded their files yet: naming them to `extensions add` records them (#857).
  const recorded = urlcode(t, site, ['extensions', 'add', 'auth', 'store', '--json'], addons);
  assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
  const listed = urlcode(t, site, ['extensions', 'list', '--strict', '--json'], addons);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const extensions = JSON.parse(listed.stdout) as { addons: { name: string; package: string; independent?: boolean; pinned: boolean; problems: string[] }[]; problems: string[] };
  assert.deepEqual(extensions.addons.map(item => [item.name, item.package, item.independent ?? false, item.pinned, item.problems]), [['auth', '@jimhoyd/urlcode-auth', false, true, []], ['store', '@jimhoyd/urlcode-store', false, true, []]]);
  assert.deepEqual(extensions.problems, []);
  const staticCheck = urlcode(t, site, ['validate', '--project', 'app']);
  assert.equal(staticCheck.status, 0, staticCheck.stdout + staticCheck.stderr);

  const inventory = JSON.parse(npm(t, site, ['run', '-s', 'inventory']).stdout) as { provider: Record<string, { version: string; integrity: string }>; plugins: string[]; endpoints: { path: string | null; served: boolean }[]; servedMatchesOperatorList: boolean };
  assert.equal(inventory.provider['better-auth']?.version, '1.7.6');
  assert.match(inventory.provider['better-auth']!.integrity, /^sha512-/);
  assert.deepEqual(inventory.plugins, []);
  assert.equal(inventory.servedMatchesOperatorList, true);
  t.diagnostic(`served Better Auth endpoints: ${inventory.endpoints.filter(entry => entry.served).map(entry => entry.path).join(', ')}`);

  const port = await freePort(), origin = `http://localhost:${port}`;
  const env = { SITE_ORIGIN: origin };
  const hosted = ['--project', 'app', '--host-file', 'host.mjs', '--origin', origin];
  const policy = join(site, 'operator', 'policy.json');

  // No reviewed policy yet: the revision is not pinned, so nothing activates.
  const unapproved = urlcode(t, site, ['validate', '--local', ...hosted], { ...env, PROJECT_SHA256: '0'.repeat(64) });
  assert.notEqual(unapproved.status, 0);
  // The evaluator's explicit approval: review `urlcode permissions`, then save it outside app/.
  const proposal = urlcode(t, site, ['permissions', '--project', 'app']);
  assert.equal(proposal.status, 0, proposal.stderr);
  await writeFile(policy, proposal.stdout);
  const approved = [...hosted, '--policy', policy];
  const valid = urlcode(t, site, ['validate', '--local', ...approved], env);
  assert.equal(valid.status, 0, valid.stderr);
  // Review facts: the capability a protected handler receives, and the provider mount's unlisted subpaths.
  const reviewEnv = { ...env, PROJECT_SHA256: (JSON.parse(proposal.stdout) as { projectSha256: string }).projectSha256 };
  const protectedRoute = urlcode(t, site, ['explain', '/api/requests', '--project', 'app', '--host-file', 'host.mjs'], reviewEnv);
  assert.match(protectedRoute.stdout, /handler receives context\.capabilities\.auth: identity/);
  const mount = urlcode(t, site, ['explain', '/api/auth/sign-in/email', '--project', 'app', '--host-file', 'host.mjs'], reviewEnv);
  assert.match(mount.stdout, /"subpaths":"provider-defined, not enumerated or inspected by URLCode"/);

  await t.test('provider and target misconfiguration refuses before serving', async () => {
    const empty = join(root, 'empty-data');
    const refusals: [string, Record<string, string>, RegExp][] = [
      ['no secret', { PRIVATE_REQUESTS_DATA: empty }, /auth secret .*is missing/],
      ['uninitialized schema', { PRIVATE_REQUESTS_DATA: empty, BETTER_AUTH_SECRET: 'b'.repeat(43) }, /Better Auth's tables are not initialized/],
    ];
    // There is no origin to mismatch: the extension builds Better Auth's baseURL from the operator's --origin.
    for (const [name, extra, message] of refusals) {
      const refused = urlcode(t, site, ['validate', '--local', ...approved], { ...env, ...extra });
      assert.notEqual(refused.status, 0, name);
      assert.match(refused.stdout + refused.stderr, message, name);
    }
    const yamlFile = join(site, 'app', 'urlcode.yaml'), yaml = await readFile(yamlFile, 'utf8');
    try {
      // An unreviewed edit invalidates the pinned revision.
      await writeFile(yamlFile, yaml.replace('The signed-in user', 'The user'));
      const stale = urlcode(t, site, ['validate', '--local', ...approved], env);
      assert.notEqual(stale.status, 0);
      assert.match(stale.stdout + stale.stderr, /revision|projectSha256|pin/i);
      // A live capability object cannot cross into the sandbox: refused at compile time, not degraded.
      await mkdir(join(site, 'app', 'functions'));
      await writeFile(join(site, 'app', 'functions', 'sandboxed.mjs'), 'export default (_request, context) => Response.json({ capabilities: Object.keys(context.capabilities ?? {}) });\n');
      await writeFile(yamlFile, yaml + '  /api/sandboxed:\n    methods: [GET]\n    auth: true\n    sandbox: true\n    function: {source: functions/sandboxed.mjs}\n');
      const sandboxProposal = urlcode(t, site, ['permissions', '--project', 'app']);
      assert.equal(sandboxProposal.status, 0, sandboxProposal.stdout + sandboxProposal.stderr);
      await writeFile(policy, sandboxProposal.stdout);
      const sandboxed = urlcode(t, site, ['validate', '--local', ...approved], env);
      assert.notEqual(sandboxed.status, 0);
      assert.match(sandboxed.stdout + sandboxed.stderr, /capabilit/);
    } finally {
      await rm(join(site, 'app', 'functions'), { recursive: true, force: true });
      await writeFile(yamlFile, yaml);
      await writeFile(policy, proposal.stdout);
    }
  });

  // The declarative fixtures, signed-in steps included, run on their own synthetic data at the documented origin.
  const fixtureEnv = { PRIVATE_REQUESTS_DATA: join(root, 'fixture-data'), SITE_ORIGIN: 'http://localhost:4180' };
  assert.equal(npm(t, site, ['run', '-s', 'setup'], fixtureEnv).status, 0);
  const documented = ['--project', 'app', '--host-file', 'host.mjs', '--origin', 'http://localhost:4180', '--policy', policy];
  const fixtures = urlcode(t, site, ['test', ...documented], fixtureEnv);
  assert.equal(fixtures.status, 0, fixtures.stdout + fixtures.stderr);
  const audit = urlcode(t, site, ['audit', '--expect-routes', '6', ...documented, '--json'], fixtureEnv);
  const report = JSON.parse(audit.stdout.trim().split('\n').at(-1)!) as { countMatches: boolean; failed: number; ready: boolean; uncovered: unknown[]; ignoredWaivers: unknown[]; coverageNotes: { code: string }[] };
  assert.deepEqual([report.ready, report.countMatches, report.failed, report.uncovered, report.ignoredWaivers], [true, true, 0, [], []], audit.stdout);
  // Every auth: true route is covered by the signed-in steps, so no note asks for a sign-in fixture.
  assert.ok(report.coverageNotes.every(note => note.code === 'unasserted-success'), audit.stdout);
  // The fixtures name the origin as {{origin}}, never a literal one: the same file is ready under another --origin.
  // Its own data: Better Auth's sign-in limit is kept in auth.sqlite, shared by every process (#927), and the two runs
  // above already spent most of this minute's 10 sign-ins from 127.0.0.1.
  const movedEnv = { ...fixtureEnv, PRIVATE_REQUESTS_DATA: join(root, 'fixture-data-moved') };
  assert.equal(npm(t, site, ['run', '-s', 'setup'], movedEnv).status, 0);
  const moved = urlcode(t, site, ['audit', '--expect-routes', '6', ...documented.map(value => value === 'http://localhost:4180' ? 'http://127.0.0.1:4181' : value), '--json'], movedEnv);
  const movedReport = JSON.parse(moved.stdout.trim().split('\n').at(-1)!) as { ready: boolean; failed: number };
  assert.deepEqual([movedReport.ready, movedReport.failed], [true, 0], moved.stdout);

  const server = spawn(process.execPath, [join(site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'cli.js'), 'serve', ...approved, '--port', String(port)], { cwd: site, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  assert.equal(ann.jar.size, 0);
  assert.equal(await signIn(ann, 'ann@example.test', 'ann-local-demo-password'), 200);
  assert.equal(await signIn(bob, 'bob@example.test', 'bob-local-demo-password'), 200);
  assert.equal(await signIn(rita, 'rita@example.test', 'rita-local-demo-password'), 200);
  // Sign-up is disabled over HTTP even though Better Auth ships it.
  assert.equal((await ann('/api/auth/sign-up/email', { method: 'POST', body: { email: 'eve@example.test', password: 'eve-local-demo-password', name: 'Eve' } })).status, 404);

  type Page = { items: { id: string; title: string; status: string }[]; total: number };
  const titles = async (client: ReturnType<typeof browser>, path: string): Promise<string[]> => ((await client(path)).json as Page).items.map(item => item.title);
  const errorCode = (response: { json: unknown }): string => (response.json as { error: { code: string } }).error.code;

  await t.test('identity comes from the verified session, permissions from the application', async () => {
    assert.equal(((await ann('/api/auth/get-session')).json as { user: { id: string } }).user.id, users['ann@example.test']);
    assert.equal(((await rita('/api/auth/get-session')).json as { user: { id: string } }).user.id, users['rita@example.test']);
    // Signing in never grants review: membership of the reviewers collection does.
    assert.equal((await ann('/api/review')).status, 403);
    assert.equal((await rita('/api/review')).status, 200);
    // A client cannot claim another identity through the reserved context namespace.
    assert.equal((await ann('/api/review', { headers: { 'x-urlcode-context-auth': users['rita@example.test']! } })).status, 403);
  });

  let annRequest = '';
  await t.test('owners create, list and read only their own requests', async () => {
    const created = await ann('/api/requests', { method: 'POST', body: { title: 'New laptop', details: 'Synthetic request' } });
    assert.equal(created.status, 201);
    annRequest = (created.json as { id: string }).id;
    assert.equal((created.json as { status: string }).status, 'pending');
    // The store never shows the stored owner, to anyone.
    assert.equal(Object.hasOwn(created.json as object, '_owner'), false);
    assert.equal((await bob('/api/requests', { method: 'POST', body: { title: 'Desk lamp' } })).status, 201);
    assert.deepEqual(await titles(ann, '/api/requests'), ['New laptop']);
    assert.deepEqual(await titles(bob, '/api/requests'), ['Desk lamp']);
    assert.equal((await ann(`/api/requests/${annRequest}`)).status, 200);
    // Another owner cannot tell the request exists, and neither can a reviewer on the owners' mount.
    assert.deepEqual(await bob(`/api/requests/${annRequest}`).then(response => [response.status, errorCode(response)]), [404, 'not_found']);
    assert.equal((await rita(`/api/requests/${annRequest}`)).status, 404);
    // A reviewer reads it through the read-only review mount.
    assert.equal(((await rita(`/api/review/${annRequest}`)).json as { title: string }).title, 'New laptop');
  });

  await t.test('malformed and out-of-contract input is refused by the store', async () => {
    assert.equal((await ann('/api/requests', { method: 'POST', body: '{"title":' })).status, 400);
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: '' } })).status, 422);
    // No body can name the owner or the review state: an undeclared property and a readOnly one are refused.
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: 'x', owner: users['bob@example.test'] } })).status, 422);
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: 'x', _owner: users['bob@example.test'] } })).status, 422);
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: 'x', status: 'approved' } })).status, 422);
    assert.equal((await ann('/api/requests', { method: 'POST', body: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await ann('/api/requests', { method: 'POST' })).status, 415);
    assert.equal((await ann('/api/requests/not-a-uuid')).status, 404);
    // Owners cannot change a request: the route admits GET and POST only.
    assert.equal((await ann(`/api/requests/${annRequest}`, { method: 'PATCH', body: { status: 'approved' } })).status, 405);
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: 'x' }, headers: { origin: 'https://attacker.example' } })).status, 403);
    assert.equal(((await ann('/api/requests')).json as Page).total, 1);
  });

  await t.test('only a reviewer approves, once, and never their own request', async () => {
    const missing = `${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
    // A non-reviewer, owner or not, gets one 403 whether or not the id exists, before any record is read.
    for (const [client, id] of [[bob, annRequest], [ann, annRequest], [bob, missing]] as const) {
      const refused = await client(`/api/approvals/${id}`, { method: 'POST' });
      assert.deepEqual([refused.status, errorCode(refused)], [403, 'membership_required']);
    }
    assert.equal((await bob('/api/review?status=pending')).status, 403);
    assert.equal((await bob(`/api/review/${annRequest}`)).status, 403);
    assert.deepEqual(await titles(rita, '/api/review?status=pending'), ['New laptop', 'Desk lamp']);
    const own = (await rita('/api/requests', { method: 'POST', body: { title: 'Reviewer own request' } })).json as { id: string };
    assert.deepEqual(await rita(`/api/approvals/${own.id}`, { method: 'POST' }).then(response => [response.status, errorCode(response)]), [403, 'own_record_refused']);
    // The review mount is read-only.
    assert.equal((await rita(`/api/review/${annRequest}`, { method: 'POST' })).status, 405);
    // Concurrent approvals: the conditional transition lets exactly one win.
    const racing = await Promise.all([1, 2, 3].map(() => rita(`/api/approvals/${annRequest}`, { method: 'POST' })));
    assert.deepEqual(racing.map(response => response.status).sort(), [200, 409, 409]);
    assert.deepEqual(racing.filter(response => response.status === 409).map(errorCode), ['transition_conflict', 'transition_conflict']);
    const approved = (await ann(`/api/requests/${annRequest}`)).json as { status: string; reviewedAt: string };
    assert.equal(approved.status, 'approved');
    assert.match(approved.reviewedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal((await rita(`/api/approvals/${missing}`, { method: 'POST' })).status, 404);
  });

  await t.test('the application change: owners filter their own list by a declared status field', async () => {
    assert.equal((await ann('/api/requests', { method: 'POST', body: { title: 'Second request' } })).status, 201);
    assert.deepEqual(await titles(ann, '/api/requests?status=approved'), ['New laptop']);
    assert.deepEqual(await titles(ann, '/api/requests?status=pending'), ['Second request']);
    assert.equal((await titles(ann, '/api/requests')).length, 2);
    assert.equal((await ann('/api/requests?reviewedAt=x')).status, 400, 'only declared filters');
    // The filter narrows the caller's own records; it never widens to another owner's.
    assert.deepEqual(await titles(bob, '/api/requests?status=pending'), ['Desk lamp']);
  });

  await t.test('a cancelled request writes nothing', async () => {
    const before = ((await bob('/api/requests')).json as Page).total;
    const controller = new AbortController();
    let pull = 0;
    const body = new ReadableStream({ pull(stream) { if (pull++ === 0) stream.enqueue(new TextEncoder().encode('{"title":"never fin')); else return new Promise(() => { setTimeout(() => controller.abort(), 200); }); } });
    await assert.rejects(bob('/api/requests', { method: 'POST', rawBody: body, duplex: 'half', headers: { 'content-type': 'application/json' }, signal: controller.signal }));
    assert.equal(((await bob('/api/requests')).json as Page).total, before);
  });

  await t.test('sign-out and revocation end access immediately', async () => {
    assert.equal((await bob('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
    assert.equal((await bob('/api/requests')).status, 401);
    // A second device; revoking every session from one ends both.
    const annPhone = browser(origin);
    assert.equal(await signIn(annPhone, 'ann@example.test', 'ann-local-demo-password'), 200);
    const stolen = new Map(annPhone.jar);
    assert.equal((await annPhone('/api/requests')).status, 200);
    assert.equal((await ann('/api/auth/revoke-sessions', { method: 'POST', body: {} })).status, 200);
    assert.equal((await ann('/api/requests')).status, 401);
    assert.equal((await annPhone('/api/requests')).status, 401);
    // Replaying the revoked cookie does not revive it.
    const replay = browser(origin);
    for (const [name, value] of stolen) replay.jar.set(name, value);
    assert.equal((await replay('/api/requests')).status, 401);
    // Signing in again works and the owner's data is intact.
    assert.equal(await signIn(ann, 'ann@example.test', 'ann-local-demo-password'), 200);
    assert.equal(((await ann('/api/requests')).json as Page).total, 2);
  });

  await t.test('sign-in attempts are throttled per client address', async () => {
    const attacker = browser(origin);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt++) statuses.push(await signIn(attacker, 'rita@example.test', 'guess'));
    assert.ok(statuses.includes(429), statuses.join(','));
    // A spoofed forwarding header does not buy a fresh bucket: the mount supplies the admitted address.
    assert.equal((await attacker('/api/auth/sign-in/email', { method: 'POST', body: { email: 'rita@example.test', password: 'guess' }, headers: { 'x-forwarded-for': '203.0.113.7', 'x-urlcode-client-address': '203.0.113.7' } })).status, 429);
  });

  await t.test('the frontend is ordinary static files plus the upstream client bundle', async () => {
    const page = await fetch(origin + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<script type="module" src="\/assets\/app.js">/);
    const script = await fetch(origin + '/assets/app.js');
    assert.equal(script.status, 200);
    assert.match(await script.text(), /\/api\/auth/);
  });

  // The connected authoring workflow (#834): the operator starts the MCP server with the same host, origin and
  // reviewed policy; its runners validate and test the site with no PROJECT_SHA256 export. They pass the child only
  // PATH, so they use the site's own data/, which is why this runs after the HTTP scenario.
  await t.test('the authoring MCP runners validate and test with the operator policy', async () => {
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proof', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      ...['run_validate', 'run_test'].map((name, index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name, arguments: {} } })),
    ];
    // The throttling scenario above spent this minute's sign-ins from 127.0.0.1, and Better Auth keeps that count in
    // data/auth.sqlite for every process (#927); an operator resets it by clearing the table, which is safe to do.
    const counters = new DatabaseSync(join(site, 'data', 'auth.sqlite'), { timeout: 2000 });
    try { counters.exec('DELETE FROM rateLimit'); } finally { counters.close(); }
    const { PROJECT_SHA256: _pin, ...ambient } = process.env;
    const mcp = spawnSync(process.execPath, [join(site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'cli.js'), 'mcp', '--allow-authoring', ...documented], { cwd: site, input: messages.map(message => JSON.stringify(message)).join('\n') + '\n', encoding: 'utf8', timeout: 300000, env: { ...ambient, SITE_ORIGIN: 'http://localhost:4180' } });
    const replies = mcp.stdout.trim().split('\n').map(line => JSON.parse(line) as { id: number; result: { content: { text: string }[] } });
    const result = (id: number) => JSON.parse(replies.find(reply => reply.id === id)!.result.content[0]!.text) as { exitCode: number; stdout: string; stderr: string };
    assert.equal(result(2).exitCode, 0, result(2).stderr);
    assert.equal(result(3).exitCode, 0, result(3).stderr);
    assert.match(result(3).stdout, /"failed":0/);
  });
});
