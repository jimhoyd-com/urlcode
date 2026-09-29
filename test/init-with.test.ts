import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSiteWith } from '../packages/core/src/init-with.ts';
import { parseAddonManifest } from '../packages/core/src/addon-manifest.ts';
import { ConfigError } from '../packages/core/src/errors.ts';

// #911: an add-on whose entry cannot be imported used to surface as the CLI's generic "Operation failed".
const fixtures = fileURLToPath(new URL('./fixtures/addons/', import.meta.url));
process.env.URLCODE_NPM = join(fixtures, 'fake-npm.mjs');
const coreVersion = (JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

test('init --with names a failed add-on import, the core/catalog skew behind it and the next step, and leaves nothing', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'urlcode-init-with-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  // An add-on built against a newer core: it imports an export the installed core does not have.
  const alpha = join(root, 'alpha');
  await cp(join(fixtures, 'alpha'), alpha, { recursive: true });
  const entry = join(alpha, 'extension.js');
  await writeFile(entry, `import { exportThisCoreLacks } from 'node:path';\n${await readFile(entry, 'utf8')}`);
  // The site's core comes from the (fake) registry, as a fresh `urlcode init` site's exact version pin does.
  const registry = join(root, 'registry'), core = join(registry, `@jimhoyd+urlcode@${coreVersion}`);
  await mkdir(core, { recursive: true });
  await writeFile(join(core, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode', version: coreVersion, type: 'module' }));
  const manifest = parseAddonManifest({ format: 1, version: coreVersion, addons: { alpha: { kind: 'extension', package: '@jimhoyd/urlcode-alpha', description: 'alpha', requires: [], url: `file:${alpha}`, integrity: null } } }, 'test manifest');
  process.env.FAKE_NPM_REGISTRY = registry;
  t.after(() => { delete process.env.FAKE_NPM_REGISTRY; });

  const destination = join(root, 'site');
  const error = await initSiteWith(destination, ['alpha'], { manifest }).then(() => assert.fail('init --with should refuse'), (reason: unknown) => reason);
  assert.ok(error instanceof ConfigError, String(error));
  assert.equal(error.details.code, 'addon-load');
  assert.match(error.message, /^Could not import @jimhoyd\/urlcode-alpha\/extension: SyntaxError: .*exportThisCoreLacks/);
  assert.match(error.message, new RegExp(`Version skew: .* built for core ${coreVersion.replaceAll('.', '\\.')}, but this site installed @jimhoyd/urlcode ${coreVersion.replaceAll('.', '\\.')} from the npm registry`));
  assert.match(error.message, /npm install --save-exact --ignore-scripts/);
  assert.match(error.message, /init --with removed everything it created; .*`urlcode init .*site'?`, then `urlcode extensions add alpha`/);
  assert.deepEqual(await readdir(root).then(names => names.sort()), ['alpha', 'registry'], 'the refused init left nothing behind');
});
