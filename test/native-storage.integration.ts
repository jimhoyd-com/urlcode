// Owner choice (#1052, slice S7): proofs/native-storage end to end with real npm. The application keeps its data with
// Node's built-in node:sqlite, called directly from trusted function routes, and signs users in with `auth: true`
// through the independent Auth.js provider (proofs/authjs-provider). Neither the bundled store nor audit is installed.
// Core is packed as a release packs it and the provider as a local tarball; installing @auth/core needs the npm
// registry, nothing after it does. Run after `npm run build` (npm run test:proof:native).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { parse } from 'yaml';
import { withPublishedManifest } from '../scripts/published-manifest.mjs';
import { npmCommand } from '../scripts/npm-command.ts';
import { repositoryRoot } from '../scripts/workspaces.ts';

const proof = join(repositoryRoot, 'proofs', 'native-storage'), provider = join(repositoryRoot, 'proofs', 'authjs-provider');
const bundledStorage = /(?:from|import\(|require\()\s*['"]@jimhoyd\/urlcode-(?:store|audit)\b/;

interface Run { status: number | null; stdout: string; stderr: string }
function run(t: TestContext, cwd: string, command: string, args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  t.diagnostic(`${args.slice(0, 3).join(' ')} -> ${result.status}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const npm = (t: TestContext, cwd: string, args: string[], env: Record<string, string> = {}): Run => { const command = npmCommand(args); return run(t, cwd, command.command, command.args, env); };
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }).on('error', reject);
});
/** Every file below `directory` whose name says it is a SQLite database, relative to it. */
async function databases(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter(entry => entry.isFile() && /\.sqlite(?:-wal|-shm|-journal)?$/.test(entry.name)).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();
}

/** A cookie-keeping client that behaves like a same-origin browser on `origin`. */
function browser(origin: string) {
  const jar = new Map<string, string>();
  const call = async (path: string, init: { method?: string; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<{ status: number; json: unknown }> => {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    if (jar.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    if (init.method && init.method !== 'GET') headers.origin ??= origin;
    let body: string | undefined;
    if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
    else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
    const response = await fetch(origin + path, { method: init.method ?? 'GET', headers, redirect: 'manual', ...(body === undefined ? {} : { body }) });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ''] = cookie.split(';'), split = pair.indexOf('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(cookie)) jar.delete(pair.slice(0, split)); else jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    const text = await response.text();
    let json: unknown = text;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: response.status, json };
  };
  return call;
}
/** Auth.js's own Credentials sign-in: a CSRF token, then the callback, answered as JSON rather than a redirect. */
async function signIn(client: ReturnType<typeof browser>, email: string, password: string): Promise<void> {
  const csrf = (await client('/api/auth/csrf')).json as { csrfToken: string };
  const answer = await client('/api/auth/callback/credentials', { method: 'POST', form: { email, password, csrfToken: csrf.csrfToken }, headers: { 'x-auth-return-redirect': '1' } });
  assert.equal(answer.status, 200);
  assert.equal(new URL((answer.json as { url: string }).url).searchParams.has('error'), false, `sign-in as ${email}`);
}

test('native storage: the owner\'s own database library behind auth: true, with no store or audit extension', { timeout: 1200000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-native-storage-'));
  const closers: (() => unknown)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    while (closers.length) try { await closers.pop()!(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Proof cleanup failed');
  });
  closers.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  await t.test('the proof declares only the auth provider and calls node:sqlite directly', async () => {
    const document = parse(await readFile(join(proof, 'app', 'urlcode.yaml'), 'utf8')) as { extensions: Record<string, unknown>; routes: Record<string, { function?: unknown; auth?: boolean }> };
    assert.deepEqual(Object.keys(document.extensions), ['authjs']);
    for (const route of ['/api/notes', '/api/notes/{id}']) assert.deepEqual([document.routes[route]!.auth, Boolean(document.routes[route]!.function)], [true, true], route);
    assert.match(await readFile(join(proof, 'app', 'functions', 'notes.mjs'), 'utf8'), /^import \{ DatabaseSync \} from 'node:sqlite';$/m);
    for (const file of [join(proof, 'host.mjs'), join(proof, 'app', 'functions', 'notes.mjs'), join(proof, 'operator', 'auth.mjs'), join(proof, 'scripts', 'setup.mjs')]) {
      assert.doesNotMatch(await readFile(file, 'utf8'), bundledStorage, file);
    }
    const manifest = JSON.parse(await readFile(join(proof, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@auth/core', '@example/urlcode-authjs', '@jimhoyd/urlcode']);
  });

  // Core exactly as a release packs it, and the provider as a local tarball.
  const packed = join(root, 'packed');
  await mkdir(packed);
  const pack = (directory: string): string => {
    const command = npmCommand(['pack', '--ignore-scripts', '--json', '--pack-destination', packed, directory]);
    const result = spawnSync(command.command, command.args, { cwd: packed, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return join(packed, (JSON.parse(result.stdout) as { filename: string }[])[0]!.filename);
  };
  const core = await withPublishedManifest(repositoryRoot, () => pack(repositoryRoot));
  const tarball = pack(provider);
  const site = join(root, 'site');
  await cp(proof, site, { recursive: true, filter: source => !/[/\\](node_modules|data|package-lock\.json)$/.test(source) && !source.endsWith('policy.json') });
  const manifestFile = join(site, 'package.json'), pkg = JSON.parse(await readFile(manifestFile, 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies['@jimhoyd/urlcode'] = `file:${core}`;
  pkg.dependencies['@example/urlcode-authjs'] = `file:${tarball}`;
  await writeFile(manifestFile, JSON.stringify(pkg, null, 2) + '\n');
  const installed = npm(t, site, ['install', '--no-audit', '--no-fund']);
  assert.equal(installed.status, 0, installed.stderr);
  for (const name of ['urlcode-store', 'urlcode-audit', 'urlcode-auth']) assert.equal(existsSync(join(site, 'node_modules', '@jimhoyd', name)), false, name);

  const cli = join(site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'cli.js');
  const urlcode = (args: string[], env: Record<string, string> = {}): Run => run(t, site, process.execPath, [cli, ...args], env);
  // The operator's own files (the Auth.js secret and account list) live outside the project, in a directory of their own.
  const operatorData = join(root, 'operator-data');
  const operatorEnv = { NATIVE_STORAGE_DATA: operatorData };
  const setup = npm(t, site, ['run', '-s', 'setup'], operatorEnv);
  assert.equal(setup.status, 0, setup.stderr);

  const policy = join(site, 'operator', 'policy.json');
  const proposal = urlcode(['permissions', '--project', 'app']);
  assert.equal(proposal.status, 0, proposal.stderr);
  const proposed = JSON.parse(proposal.stdout) as { projectSha256: string; routes: Record<string, { env?: string[] }> };
  // The application's only operator grant is its data directory, named in the reviewed revision.
  assert.deepEqual(proposed.routes['/api/notes']?.env, ['URLCODE_DATA_DIR']);
  assert.deepEqual(proposed.routes['/api/notes/{id}']?.env, ['URLCODE_DATA_DIR']);
  await writeFile(policy, proposal.stdout);
  const origin = 'http://localhost:4200';
  const documented = ['--project', 'app', '--host-file', 'host.mjs', '--policy', policy, '--origin', origin];

  await t.test('validate, explain and review see the auth gate and the trusted function, not the database', () => {
    const valid = urlcode(['validate', '--local', ...documented], { ...operatorEnv, URLCODE_DATA_DIR: join(root, 'live-data') });
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    const explained = urlcode(['explain', '/api/notes', '--project', 'app', '--host-file', 'host.mjs'], { ...operatorEnv, PROJECT_SHA256: proposed.projectSha256 });
    assert.equal(explained.status, 0, explained.stderr);
    assert.match(explained.stdout, /extensions\.authjs: requires \{\}/);
    assert.match(explained.stdout, /handler receives context\.capabilities\.authjs: identity/);
    assert.match(explained.stdout, /^execution: trusted \(in-process\)$/m);
    assert.match(explained.stdout, /handler execution are not evaluated/);
    const review = urlcode(['review', '--project', 'app', '--host-file', 'host.mjs', '--json'], { ...operatorEnv, PROJECT_SHA256: proposed.projectSha256 });
    assert.equal(review.status, 0, review.stderr);
    const reviewed = JSON.parse(review.stdout) as { routeCount: number; trustedDependencies: { files: { path: string }[]; packages: string[]; complete: boolean }; observations: unknown[] };
    // The function is reviewed as trusted code bound to this revision; node:sqlite is a Node built-in, not a package,
    // and the declared body schema leaves review nothing to suggest.
    assert.equal(reviewed.routeCount, 3);
    assert.ok(reviewed.trustedDependencies.files.some(file => file.path === 'functions/notes.mjs'));
    assert.deepEqual([reviewed.trustedDependencies.packages, reviewed.trustedDependencies.complete, reviewed.observations], [[], true, []]);
    // Serving without the granted data directory refuses before any request, rather than guessing a location.
    const unset = urlcode(['validate', '--local', ...documented], operatorEnv);
    assert.notEqual(unset.status, 0);
    assert.match(unset.stdout + unset.stderr, /Route \/api\/notes: Environment binding DATA_DIR reads URLCODE_DATA_DIR, which is not set/);
  });

  await t.test('test runs twice and audit is ready, each on a fresh database outside the project', () => {
    // The first signed-in fixture step expects zero notes: a second run passing proves it did not see the first's.
    for (const attempt of [1, 2]) {
      const fixtures = urlcode(['test', ...documented], operatorEnv);
      assert.equal(fixtures.status, 0, `run ${attempt}: ${fixtures.stdout}${fixtures.stderr}`);
    }
    const audit = urlcode(['audit', '--expect-routes', '3', ...documented, '--json'], operatorEnv);
    const report = JSON.parse(audit.stdout.trim().split('\n').at(-1)!) as { countMatches: boolean; failed: number; ready: boolean; uncovered: unknown[]; ignoredWaivers: unknown[] };
    assert.deepEqual([report.ready, report.countMatches, report.failed, report.uncovered, report.ignoredWaivers], [true, true, 0, [], []], audit.stdout);
  });

  await t.test('the hermetic runs left no database in the site or the operator\'s directory', async () => {
    assert.deepEqual(await databases(site), []);
    assert.deepEqual((await readdir(operatorData)).sort(), ['authjs.secret', 'users.json']);
  });

  await t.test('store vocabulary without the store extension is refused, not emulated on node:sqlite', async () => {
    const yamlFile = join(site, 'app', 'urlcode.yaml'), yaml = await readFile(yamlFile, 'utf8');
    const store = [
      'extensions:',
      '  store:',
      '    version: "1"',
      '    config:',
      '      collections:',
      '        notes: {mount: /api/store-notes, ownership: owner, schema: {type: object, properties: {title: {type: string, maxLength: 120}}}}',
    ].join('\n');
    const route = '  /api/store-notes/*:\n    extension: store\n    methods: [GET, POST]\n    auth: true\n';
    try {
      await writeFile(yamlFile, yaml.replace(/^extensions:$/m, store) + route);
      const reviewed = urlcode(['permissions', '--project', 'app']);
      assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
      const pin = { PROJECT_SHA256: (JSON.parse(reviewed.stdout) as { projectSha256: string }).projectSha256, URLCODE_DATA_DIR: join(root, 'live-data') };
      for (const command of [['validate', '--local'], ['test'], ['serve', '--port', '0']]) {
        const name = command[0]!;
        const refused = urlcode([...command, '--project', 'app', '--host-file', 'host.mjs', '--origin', origin], { ...operatorEnv, ...pin });
        assert.notEqual(refused.status, 0, name);
        // Both the declaration and the mount are named; nothing falls back to the application's own database.
        const message = (JSON.parse(refused.stderr.trim().split('\n').at(-1)!) as { message: string }).message;
        assert.match(message, /^\(project\)\n(?:.*\n)*? {2}Not registered by the host file: store$/m, name);
        assert.match(message, /^\/api\/store-notes\/\*\n(?:.*\n)*? {2}Not registered by the host file: store$/m, name);
      }
    } finally { await writeFile(yamlFile, yaml); }
    assert.deepEqual(await databases(site), []);
  });

  // Serving: the operator grants a data directory outside the project, and the application's database appears there.
  const liveData = join(root, 'live-data');
  await mkdir(liveData, { mode: 0o700 });
  const port = await freePort(), served = `http://localhost:${port}`;
  const server = spawn(process.execPath, [cli, 'serve', '--project', 'app', '--host-file', 'host.mjs', '--policy', policy, '--origin', served, '--port', String(port)], { cwd: site, env: { ...process.env, ...operatorEnv, URLCODE_DATA_DIR: liveData }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => server.once('exit', resolve));
  closers.push(async () => { if (server.exitCode === null && server.signalCode === null) server.kill(); await exited; });
  for (let attempt = 0; ; attempt++) {
    if (await fetch(`${served}/_urlcode/ready`).then(response => response.ok, () => false)) break;
    assert.ok(attempt < 100 && server.exitCode === null, `server did not start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  await t.test('served: owners see only their own notes, kept in the operator\'s directory by node:sqlite', async () => {
    const ann = browser(served), bob = browser(served);
    assert.equal((await ann('/api/notes')).status, 401);
    await signIn(ann, 'ann@example.test', 'ann-local-demo-password');
    await signIn(bob, 'bob@example.test', 'bob-local-demo-password');
    const created = await ann('/api/notes', { method: 'POST', body: { title: 'Ann\'s note', body: 'private' } });
    assert.equal(created.status, 201);
    const id = (created.json as { id: string }).id;
    assert.equal((await bob('/api/notes', { method: 'POST', body: { title: 'Bob\'s note' } })).status, 201);
    // Concurrent writes from one owner: each commits in its own transaction.
    const burst = await Promise.all([1, 2, 3, 4, 5].map(n => ann('/api/notes', { method: 'POST', body: { title: `Burst ${n}` } })));
    assert.deepEqual(burst.map(response => response.status), [201, 201, 201, 201, 201]);
    assert.equal(((await ann('/api/notes')).json as { total: number }).total, 6);
    assert.deepEqual(((await bob('/api/notes')).json as { items: { title: string }[] }).items.map(item => item.title), ['Bob\'s note']);
    assert.equal((await bob(`/api/notes/${id}`)).status, 404);
    assert.equal(((await ann(`/api/notes/${id}`)).json as { body: string }).body, 'private');
    assert.equal((await ann('/api/notes', { method: 'POST', body: { title: 'x' }, headers: { origin: 'https://attacker.example' } })).status, 403);

    // The database is an ordinary SQLite file in the granted directory, readable with the same library, and nowhere else.
    assert.deepEqual(await databases(site), []);
    assert.equal(existsSync(join(liveData, 'notes.sqlite')), true);
    const database = new DatabaseSync(join(liveData, 'notes.sqlite'), { readOnly: true });
    try {
      const owners = database.prepare('SELECT owner, count(*) AS notes FROM notes GROUP BY owner ORDER BY owner').all().map(row => ({ ...row }));
      assert.deepEqual(owners, [{ owner: 'ann', notes: 6 }, { owner: 'bob', notes: 1 }]);
    } finally { database.close(); }
  });
});
