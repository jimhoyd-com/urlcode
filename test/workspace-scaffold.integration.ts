import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDocument } from '../src/config.ts';
import { inspectExtensionRevision } from '../src/extensions.ts';
import { project } from './helpers.ts';
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
const parse = (out: string): Record<string, unknown> => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;
const missing = async (path: string): Promise<boolean> => { try { await lstat(path); return false; } catch { return true; } };
// Run after workspace builds, against actual compiled packages. Missing outputs fail.
const companions = Object.fromEntries(['auth', 'admin', 'ui'].map(name => [`urlcode-${name}`, fileURLToPath(new URL(`../packages/${name}`, import.meta.url))]));
test('init --with ui,auth,admin composes the real companion scaffolds', async t => {
  const root = await project(t, {});
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [name, path] of Object.entries(companions)) await symlink(path, join(root, 'node_modules', '@jimhoyd', name), process.platform === 'win32' ? 'junction' : 'dir');
  const created = run(root, ['init', 'site', '--with', 'ui,auth,admin']);
  assert.equal(created.status, 0, created.stderr);
  const report = parse(created.stdout), site = join(root, 'site'), app = join(site, 'app');
  const loaded = await loadDocument(app);
  assert.deepEqual(Object.keys(loaded.routes), ['/hello/{name}', '/go', '/assets/ui/*', '/account/*', '/private', '/admin/*']);
  // ui must be declared first: the runtime activates extensions in this order, and auth and admin both render
  // only through the kit and refuse to activate before it.
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['ui', 'auth', 'admin']);
  assert.equal(report.projectSha256, await inspectExtensionRevision(app));
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  assert.ok(host.indexOf("from '@jimhoyd/urlcode-auth'") < host.indexOf("from '@jimhoyd/urlcode-admin'"));
  assert.ok(host.indexOf('ui.registration,') < host.indexOf('authExtension({service, csrfKey, projectSha256, ui}),'));
  assert.ok(host.indexOf('authExtension({service, csrfKey, projectSha256, ui}),') < host.indexOf("adminExtension({service, csrfKey, projectSha256, authMount: '/account', ui})"));
  // The kit is built with both peers' copy and templates, or auth and admin refuse at activation.
  assert.ok(host.includes('sources: [authCatalogue], extensions: [authUiTemplates, adminUiTemplates]'));
  assert.ok(host.includes('await service.close();'));
  for (const file of ['operator-service.mjs', 'data/encryption.key', 'data/csrf.key']) { const info = await stat(join(site, file)); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600, file); }
  assert.equal((await stat(join(site, 'data/encryption.key'))).size, 32);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Extension: auth', '## Extension: admin', '## Administration', 'urlcode-auth bootstrap', '- `AUTH_ORIGIN`', '- `PROJECT_SHA256`']) assert.ok(readme.includes(needle), needle);
  // Admin needs auth in the same host; the refusal comes from its scaffold and leaves nothing behind.
  const alone = run(root, ['init', 'other', '--with', 'admin']);
  assert.equal(alone.status, 1); assert.match(alone.stderr, /urlcode-admin scaffold refused: .*requires the auth extension/); assert.ok(await missing(join(root, 'other')));
  // Without ui, and with ui ordered last, the scaffolds refuse before anything is written rather than emitting a
  // project that throws at activation.
  const noKit = run(root, ['init', 'no-kit', '--with', 'auth,admin']);
  assert.equal(noKit.status, 1); assert.match(noKit.stderr, /scaffold refused: .*requires the ui extension/); assert.ok(await missing(join(root, 'no-kit')));
  const late = run(root, ['init', 'late-kit', '--with', 'auth,admin,ui']);
  assert.equal(late.status, 1); assert.match(late.stderr, /scaffold refused: .*requires ui before/); assert.ok(await missing(join(root, 'late-kit')));
  const authOnly = run(root, ['init', 'auth-site', '--with', 'ui,auth']);
  assert.equal(authOnly.status, 0, authOnly.stderr);
  assert.deepEqual(parse(authOnly.stdout).extensions, ['ui', 'auth']);
  t.diagnostic('Serving the composed host needs a patched SQLite for the auth store; this test checks composition only.');
});
