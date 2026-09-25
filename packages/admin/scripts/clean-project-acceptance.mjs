#!/usr/bin/env node
/** Offline-provider acceptance using installed tarballs and a single persistent project. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
/** @type {Record<string, string | true>} */
const options = {};
for (let i = 0; i < args.length; i++) {
  const name = args[i] ?? assert.fail('Missing argument name');
  assert.ok(['--core', '--ui', '--audit', '--mail', '--auth', '--admin', '--out', '--phase', '--keep', '--hostname'].includes(name), `Unknown argument ${name}`);
  assert.equal(options[name], undefined, `Repeated argument ${name}`);
  options[name] = name === '--keep' ? true : (args[++i] ?? assert.fail(`Missing value for ${name}`));
  assert.ok(options[name], `Missing value for ${name}`);
}
assert.ok(options['--out'], 'Required: --core TAR --ui TAR --audit TAR --mail TAR --auth TAR --admin TAR --out NEW_DIRECTORY [--keep]');
const directory = resolve(/** @type {string} */ (options['--out']));
const hostname = /** @type {string} */ (options['--hostname'] || '127.0.0.1');
assert.ok(['127.0.0.1', 'localhost'].includes(hostname), 'Hostname must be localhost or 127.0.0.1');
const env = { ...process.env, NODE_OPTIONS: '', npm_config_cache: join(directory, '.npm-cache') }; // Installed default exports, never development conditions.
async function run(/** @type {string} */ command, /** @type {string[]} */ argv) {
  await /** @type {Promise<void>} */ (new Promise((resolveRun, reject) => {
    const child = spawn(command, argv, { cwd: directory, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} exited ${code}`)));
  }));
}
if (!options['--phase']) {
  /** @type {Record<string, { path: string, sha256: string }>} */
  const archives = {};
  for (const name of ['core', 'ui', 'audit', 'mail', 'auth', 'admin']) {
    assert.ok(options['--' + name], `Missing --${name}`);
    const path = resolve(/** @type {string} */ (options['--' + name]));
    assert.ok((await lstat(path)).isFile(), `${name} must be an actual local tarball`);
    archives[name] = { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  }
  await mkdir(directory, { mode: 0o700 }); // Refuse an existing directory, including a previous test run.
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'urlcode-clean-acceptance', private: true, type: 'module' }) + '\n', { mode: 0o600 });
  await writeFile(join(directory, 'source-manifest.json'), JSON.stringify(archives, null, 2) + '\n', { mode: 0o600 });
  const install = (/** @type {string[]} */ names) => run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...names.map(name => (archives[name] ?? assert.fail(`Missing archive ${name}`)).path)]);
  const phase = (/** @type {string} */ name) => run(process.execPath, [fileURLToPath(import.meta.url), '--phase', name, '--out', directory, '--hostname', hostname, ...(name === 'admin' && options['--keep'] ? ['--keep'] : [])]);
  await install(['core']); await phase('core');
  await install(['ui', 'audit', 'mail', 'auth']); await phase('auth');
  await install(['admin']); await phase('admin');
  process.exit(0);
}

const phase = /** @type {string} */ (options['--phase']);
assert.ok(['core', 'auth', 'admin'].includes(phase));
const require = createRequire(join(directory, 'package.json'));
async function installed(/** @type {string} */ name) {
  assert.equal((await lstat(join(directory, 'node_modules', name))).isSymbolicLink(), false, `No source symlink: ${name}`);
  const path = require.resolve(name);
  assert.ok(path.includes('/dist/'), `${name} must use compiled default exports`);
  return import(pathToFileURL(path).href);
}
const core = await installed('@jimhoyd/urlcode');
const project = join(directory, 'app'), config = join(project, 'urlcode.yaml');
const yaml = createRequire(require.resolve('@jimhoyd/urlcode'))('yaml');
/** @type {any} */
let service;
/** @type {any} */
let runtime;
/** @type {any} */
let host;
const csrfKeyPath = join(directory, 'csrf.key'), encryptionKeyPath = join(directory, 'encryption.key');
const credentials = { admin: { email: 'owner@example.test', password: 'synthetic owner acceptance passphrase' }, member: { email: 'member@example.test', password: 'synthetic member acceptance passphrase' } };
if (phase === 'core') {
  await core.initProject(project);
  const document = yaml.parse(await readFile(config, 'utf8'));
  document.routes['/acceptance'] = { respond: { text: 'Clean project preserved' } };
  await writeFile(config, yaml.stringify(document));
  await writeFile(join(project, 'acceptance-marker.txt'), 'Created before installing auth or admin\n');
  await writeFile(csrfKeyPath, randomBytes(32), { mode: 0o600 });
  await writeFile(encryptionKeyPath, randomBytes(32), { mode: 0o600 });
}
assert.equal(await readFile(join(project, 'acceptance-marker.txt'), 'utf8'), 'Created before installing auth or admin\n');
/** @type {string} */
let origin;
const server = createServer(async (request, response) => {
  try {
    /** @type {Buffer[]} */
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('Body too large'); chunks.push(chunk); }
    const headers = new Headers();
    /** @type {Record<string, number>} */
    const headerCounts = {};
    for (let i = 0; i < request.rawHeaders.length; i += 2) { const name = (request.rawHeaders[i] ?? '').toLowerCase(); headers.append(name, request.rawHeaders[i + 1] ?? ''); headerCounts[name] = (headerCounts[name] || 0) + 1; }
    const result = await runtime.handle({ method: request.method, target: request.url, headers, headerCounts, body: Buffer.concat(chunks), origin, client: request.socket.remoteAddress });
    response.writeHead(result.status, result.headers.flat()); response.end(result.body);
  } catch (error) { console.error(error); response.writeHead(500); response.end('Acceptance host failure'); }
});
await /** @type {Promise<void>} */ (new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); }));
const address = /** @type {import('node:net').AddressInfo} */ (server.address());
origin = `http://${hostname}:${address.port}`;
/** @type {string[]} */
const checks = [];
function check(/** @type {string} */ label, /** @type {unknown} */ actual, /** @type {unknown} */ expected) { assert.equal(actual, expected, label); checks.push(label); }
function browser(/** @type {[string, string][]} */ savedCookies = []) {
  const cookies = new Map(savedCookies);
  /**
   * @param {string} path
   * @param {Record<string, unknown>} [data]
   * @param {string} [csrf]
   * @param {boolean} [html]
   */
  async function request(path, data, csrf, html = false) {
    /** @type {Record<string, string>} */
    const headers = { accept: html ? 'text/html' : 'application/json', cookie: [...cookies].map(([k, v]) => k + '=' + v).join('; ') };
    if (data) { headers.origin = origin; headers['content-type'] = 'application/json'; if (csrf) headers['x-csrf-token'] = csrf; }
    const response = await fetch(origin + path, { headers, method: data ? 'POST' : 'GET', ...(data ? { body: JSON.stringify(data) } : {}), redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) { const [pair = ''] = cookie.split(';'), split = pair.indexOf('='); const key = pair.slice(0, split), value = pair.slice(split + 1); if (/max-age=0/i.test(cookie)) cookies.delete(key); else cookies.set(key, value); }
    const body = await response.text(); /** @type {any} */ let json; try { json = JSON.parse(body); } catch { /* A non-JSON body is a legitimate outcome here; the caller checks the parsed value. */ }
    return { status: response.status, body, json, headers: response.headers };
  }
  return { cookies: () => [...cookies], request };
}
async function login(/** @type {ReturnType<typeof browser>} */ client, /** @type {keyof typeof credentials} */ identity) {
  const csrf = (await client.request('/account/csrf')).json.csrf;
  const result = await client.request('/account/login', credentials[identity], csrf);
  check(identity + ' HTTP login', result.status, 200); return result.json;
}
try {
  if (phase === 'core') runtime = await core.createRuntime(project, { origin });
  else {
    const ui = await installed('@jimhoyd/urlcode-ui');
    if (phase === 'auth') {
      const document = yaml.parse(await readFile(config, 'utf8'));
      await mkdir(join(project, 'public'), { recursive: true });
      await writeFile(join(project, 'public', 'welcome.html'), ui.renderDocument({ title: 'Shared UI in core', trustedContent: '<p>Core uses shared UI before auth activation</p>' }));
      document.routes['/welcome'] = { page: { file: 'public/welcome.html' } };
      await writeFile(config, yaml.stringify(document));
      runtime = await core.createRuntime(project, { origin });
      const welcome = await browser().request('/welcome', undefined, undefined, true);
      check('Core serves shared UI without auth extension', welcome.status, 200);
      assert.ok(welcome.body.includes('Core uses shared UI before auth activation'));
      await runtime.close(); runtime = undefined;
    }
    const auth = await installed('@jimhoyd/urlcode-auth');
    const document = yaml.parse(await readFile(config, 'utf8'));
    // Auth requires ui, audit and mail; admin requires auth, ui and audit. The site composes them as host.mjs would.
    document.extensions = { ui: { version: '1', config: {} }, audit: { version: '1', config: {} }, mail: { version: '1', config: {} }, auth: { version: '1', config: { registration: 'open' } }, ...(phase === 'admin' ? { admin: { version: '1', config: {} } } : {}) };
    document.routes['/assets/ui/*'] = { extension: 'ui', methods: ['GET', 'HEAD'] };
    document.routes['/account/*'] = { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] };
    document.routes['/private'] = { respond: { text: 'Authenticated application' }, policies: { extensions: { auth: {} } } };
    if (phase === 'admin') document.routes['/admin/*'] = { extension: 'admin', methods: ['GET', 'HEAD', 'POST'], auth: { onDeny: 404 } };
    await writeFile(config, yaml.stringify(document));
    service = await auth.createAuthService({ database: join(directory, 'auth.sqlite'), encryptionKey: await readFile(encryptionKeyPath), roles: { member: [], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open' });
    if (phase === 'auth') await service.bootstrapAdmin(credentials.admin);
    const { inspectExtensionRevision } = await import(pathToFileURL(require.resolve('@jimhoyd/urlcode/extensions')).href);
    const { composeHost } = await import(pathToFileURL(require.resolve('@jimhoyd/urlcode/host')).href);
    process.env.PROJECT_SHA256 = await inspectExtensionRevision(project);
    const mail = await installed('@jimhoyd/urlcode-mail');
    const entries = [(await installed('@jimhoyd/urlcode-ui/extension')).default(), (await installed('@jimhoyd/urlcode-audit/extension')).default(), (await installed('@jimhoyd/urlcode-mail/extension')).default({ transport: mail.recordingTransport() }), (await installed('@jimhoyd/urlcode-auth/extension')).default({ service, csrfKey: await readFile(csrfKeyPath) })];
    if (phase === 'admin') entries.push((await installed('@jimhoyd/urlcode-admin/extension')).default());
    host = await composeHost(pathToFileURL(join(directory, 'host.mjs')), entries);
    runtime = await core.createRuntime(project, { origin, extensions: host.extensions });
  }
  const anonymous = browser();
  check('Initial application survives ' + phase, (await anonymous.request('/acceptance')).body, 'Clean project preserved');
  if (phase !== 'core') {
    {
      const signin = await anonymous.request('/account/login', undefined, undefined, true);
      assert.equal(signin.status, 200);
      const stylesheet = /href="(\/assets\/ui\/static\/kit\.[0-9a-f]{12}\.css)"/.exec(signin.body)?.[1];
      assert.ok(stylesheet, 'Installed kit renders auth using its hashed stylesheet');
      assert.match((await anonymous.request(stylesheet)).headers.get('cache-control') ?? '', /immutable/);
      assert.ok(signin.body.includes('data-layout="compact"'), 'Kit auth uses compact layout');
    }
    check('Shared UI page survives integration', (await anonymous.request('/welcome')).status, 200);
    check('Anonymous protected route denied', (await anonymous.request('/private')).status, 401);
    const continuityPath = join(directory, 'synthetic-upgrade-session.json');
    const previous = phase === 'admin' ? JSON.parse(await readFile(continuityPath, 'utf8')) : undefined;
    const member = browser(previous?.cookies);
    if (previous) {
      check('Existing member session survives admin installation', (await member.request('/private')).status, 200);
      const current = await member.request('/account/account');
      check('Existing member identity survives admin installation', current.json.user.id, previous.accountId);
    }
    if (phase === 'auth') {
      const csrf = (await member.request('/account/csrf')).json.csrf;
      check('HTTP member registration', (await member.request('/account/register', credentials.member, csrf)).status, 201);
    }
    const memberLogin = await login(member, 'member');
    if (phase === 'auth') await writeFile(continuityPath, JSON.stringify({ accountId: memberLogin.user.id, cookies: member.cookies() }) + '\n', { mode: 0o600 });
    check('Member protected application', (await member.request('/private')).status, 200);
    check('Account HTML available', (await member.request('/account/account', undefined, undefined, true)).status, 200);
    if (phase === 'admin') {
      check('Anonymous admin denied', (await anonymous.request('/admin')).status, 404);
      check('Member admin denied', (await member.request('/admin')).status, 404);
      const owner = browser(); await login(owner, 'admin');
      const dashboard = await owner.request('/admin');
      check('Admin dashboard', dashboard.status, 200); check('Accounts survive admin installation', dashboard.json.accounts.users, 2);
      const dashboardHtml = await owner.request('/admin', undefined, undefined, true);
      check('Admin dashboard HTML', dashboardHtml.status, 200);
      assert.ok(dashboardHtml.body.includes('data-layout="application"'), 'Admin console uses the kit application layout');
      const users = await owner.request('/admin/users');
      check('Admin user listing', users.status, 200);
      const account = users.json.users.find((/** @type {any} */ user) => user.roles.includes('member')); assert.ok(account);
      const sessions = await owner.request('/admin/sessions?accountId=' + encodeURIComponent(account.id));
      check('Member sessions visible to admin', sessions.status, 200); assert.ok(sessions.json.sessions.length);
      check('Admin revokes member sessions', (await owner.request('/admin/sessions/revoke', { accountId: account.id, reason: 'Synthetic clean-project session revocation acceptance' }, sessions.json.csrf)).status, 200);
      check('Revoked member cannot reach application', (await member.request('/private')).status, 401);
      await login(member, 'member');
      check('Member can sign in after revocation', (await member.request('/private')).status, 200);
      check('Live runtime health available', (await owner.request('/admin/health')).status, 200);
    }
  }
  await writeFile(join(directory, phase + '-results.json'), JSON.stringify({ phase, renderPath: 'kit', checks, passed: true }, null, 2) + '\n', { mode: 0o600 });
  console.log(`${phase}: ${checks.length} clean-project checks passed`);
  if (options['--keep'] && phase === 'admin') {
    await writeFile(join(directory, 'browser-fixture.json'), JSON.stringify({ origin, renderPath: 'kit', pid: process.pid, syntheticOnly: true, credentials }, null, 2) + '\n', { mode: 0o600 });
    console.log(`Synthetic browser fixture: ${join(directory, 'browser-fixture.json')}`);
    await new Promise(resolveStop => { process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop); });
  }
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  if (runtime) await runtime.close();
  if (host) await host.close();
  if (service) await service.close();
}
