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
  // The runtime activates extensions in declaration order, so ui comes before the extensions that render through its kit.
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['ui', 'auth', 'admin']);
  assert.equal(report.projectSha256, await inspectExtensionRevision(app));
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  assert.ok(host.indexOf("from '@jimhoyd/urlcode-ui/host'") < host.indexOf("from '@jimhoyd/urlcode-auth'"));
  assert.ok(host.indexOf("from '@jimhoyd/urlcode-auth'") < host.indexOf("from '@jimhoyd/urlcode-admin'"));
  assert.ok(host.indexOf('ui.registration,') < host.indexOf('authExtension({service, csrfKey, projectSha256, ui}),'));
  assert.ok(host.indexOf('authExtension({service, csrfKey, projectSha256, ui}),') < host.indexOf("adminExtension({service, csrfKey, projectSha256, ui, authMount: '/account'}),"));
  assert.ok(host.includes('await service.close();'));
  for (const file of ['ui/extra.css', 'ui/copy/.gitkeep', 'ui/templates/.gitkeep']) await stat(join(site, file));
  for (const file of ['operator-service.mjs', 'data/encryption.key', 'data/csrf.key']) { const info = await stat(join(site, file)); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600, file); }
  assert.equal((await stat(join(site, 'data/encryption.key'))).size, 32);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Extension: ui', '## Extension: auth', '## Extension: admin', '## Administration', 'urlcode-auth bootstrap', '- `AUTH_ORIGIN`', '- `PROJECT_SHA256`']) assert.ok(readme.includes(needle), needle);
  // Admin needs auth in the same host; the refusal comes from its scaffold and leaves nothing behind.
  const alone = run(root, ['init', 'other', '--with', 'ui,admin']);
  assert.equal(alone.status, 1); assert.match(alone.stderr, /urlcode-admin scaffold refused: .*requires the auth extension/); assert.ok(await missing(join(root, 'other')));
  // Auth and admin render through the ui kit, and the runtime activates in declaration order: ui must be named, and named first.
  const withoutUi = run(root, ['init', 'no-ui', '--with', 'auth,admin']);
  assert.equal(withoutUi.status, 1); assert.match(withoutUi.stderr, /urlcode-auth scaffold refused: .*requires the ui extension/); assert.ok(await missing(join(root, 'no-ui')));
  const uiLast = run(root, ['init', 'ui-last', '--with', 'auth,admin,ui']);
  assert.equal(uiLast.status, 1); assert.match(uiLast.stderr, /urlcode-auth scaffold refused: .*requires the ui extension before auth/); assert.ok(await missing(join(root, 'ui-last')));
  const uiOnly = run(root, ['init', 'ui-site', '--with', 'ui']);
  assert.equal(uiOnly.status, 0, uiOnly.stderr);
  assert.deepEqual(parse(uiOnly.stdout).extensions, ['ui']);
  t.diagnostic('Serving the composed host needs a patched SQLite for the auth store; this test checks composition only.');
});
