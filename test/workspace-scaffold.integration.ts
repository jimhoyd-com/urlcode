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
test('init --with auth,admin composes the real companion scaffolds', async t => {
  const root = await project(t, {});
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  for (const [name, path] of Object.entries(companions)) await symlink(path, join(root, 'node_modules', '@jimhoyd', name), process.platform === 'win32' ? 'junction' : 'dir');
  const created = run(root, ['init', 'site', '--with', 'auth,admin']);
  assert.equal(created.status, 0, created.stderr);
  const report = parse(created.stdout), site = join(root, 'site'), app = join(site, 'app');
  const loaded = await loadDocument(app);
  assert.deepEqual(Object.keys(loaded.routes), ['/hello/{name}', '/go', '/account/*', '/private', '/admin/*']);
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['auth', 'admin']);
  assert.equal(report.projectSha256, await inspectExtensionRevision(app));
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  assert.ok(host.indexOf("from '@jimhoyd/urlcode-auth'") < host.indexOf("from '@jimhoyd/urlcode-admin'"));
  assert.ok(host.indexOf('authExtension({service, csrfKey, projectSha256}),') < host.indexOf("adminExtension({service, csrfKey, projectSha256, authMount: '/account'}),"));
  assert.ok(host.includes('await service.close();'));
  for (const file of ['operator-service.mjs', 'data/encryption.key', 'data/csrf.key']) { const info = await stat(join(site, file)); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600, file); }
  assert.equal((await stat(join(site, 'data/encryption.key'))).size, 32);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Extension: auth', '## Extension: admin', '## Administration', 'urlcode-auth bootstrap', '- `AUTH_ORIGIN`', '- `PROJECT_SHA256`']) assert.ok(readme.includes(needle), needle);
  // Admin needs auth in the same host; the refusal comes from its scaffold and leaves nothing behind.
  const alone = run(root, ['init', 'other', '--with', 'admin']);
  assert.equal(alone.status, 1); assert.match(alone.stderr, /urlcode-admin scaffold refused: .*requires the auth extension/); assert.ok(await missing(join(root, 'other')));
  const withUi = run(root, ['init', 'ui-site', '--with', 'auth,admin,ui']);
  assert.equal(withUi.status, 0, withUi.stderr);
  assert.deepEqual(parse(withUi.stdout).extensions, ['auth', 'admin', 'ui']);
  t.diagnostic('Serving the composed host needs a patched SQLite for the auth store; this test checks composition only.');
});
