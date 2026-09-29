import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBuilt, missingEntryFiles } from '../scripts/pack-addons.ts';
import { extensionEntryError } from '../packages/core/src/addon-install.ts';

// An add-on packed before it was built installs, then fails to load (#960).
async function addon(t: { after: (fn: () => Promise<void>) => void }, built: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-pack-addons-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'node_modules', '@jimhoyd', 'urlcode-demo');
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode-demo', version: '1.0.0', type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './extension': { types: './dist/extension.d.ts', default: './dist/extension.js' }, './assets/*': './dist/assets/*' },
    bin: { 'urlcode-demo': './dist/cli.js' } }));
  if (built) for (const file of ['index.js', 'index.d.ts', 'extension.js', 'extension.d.ts', 'cli.js']) await writeFile(join(directory, 'dist', file), '');
  return directory;
}

test('pack-addons refuses an add-on whose exports or bin name files that were never built, naming them and the build', async t => {
  const unbuilt = await addon(t, false), built = await addon(t, true);
  assert.deepEqual(await missingEntryFiles(built), []);
  assert.deepEqual((await missingEntryFiles(unbuilt)).sort(), ['./dist/cli.js', './dist/extension.d.ts', './dist/extension.js', './dist/index.d.ts', './dist/index.js']);
  await assertBuilt([{ packageName: '@jimhoyd/urlcode-demo', directory: built, build: 'node scripts/workspaces.ts run build' }]);
  await assert.rejects(assertBuilt([
    { packageName: '@jimhoyd/urlcode-demo', directory: built, build: 'npm run build' },
    { packageName: '@jimhoyd/urlcode-unbuilt', directory: unbuilt, build: 'node scripts/workspaces.ts run build' },
  ]), (error: Error) => {
    assert.match(error.message, /^Refusing to pack unbuilt packages/);
    assert.match(error.message, /@jimhoyd\/urlcode-unbuilt .* is not built: .*\.\/dist\/extension\.js.* are missing; build it with `node scripts\/workspaces\.ts run build`/);
    assert.doesNotMatch(error.message, /urlcode-demo /);
    return true;
  });
});

test('an installed add-on whose ./extension file is missing is told apart from one that declares no ./extension export', async t => {
  const directory = await addon(t, false), site = join(directory, '..', '..', '..');
  const resolveError = (specifier: string): unknown => { try { createRequire(join(site, 'package.json')).resolve(specifier); } catch (error) { return error; } assert.fail(`${specifier} resolved`); };
  const unbuilt = extensionEntryError('@jimhoyd/urlcode-demo', resolveError('@jimhoyd/urlcode-demo/extension'));
  assert.match(unbuilt.message, /declares a \.\/extension export, but its file .*dist[/\\]extension\.js is not installed: the add-on was probably packed without being built/);
  // Node caches a package.json it has read, so the add-on without the export is another package.
  await mkdir(join(site, 'node_modules', '@jimhoyd', 'urlcode-plain'));
  await writeFile(join(site, 'node_modules', '@jimhoyd', 'urlcode-plain', 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode-plain', version: '1.0.0', exports: { '.': './index.js' } }));
  assert.equal(extensionEntryError('@jimhoyd/urlcode-plain', resolveError('@jimhoyd/urlcode-plain/extension')).message, '@jimhoyd/urlcode-plain is installed but has no ./extension export');
  assert.equal(extensionEntryError('@jimhoyd/urlcode-absent', resolveError('@jimhoyd/urlcode-absent/extension')).message, '@jimhoyd/urlcode-absent is installed but has no ./extension export');
});
