import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { composeHost } from '../packages/core/src/host.ts';
import { initSite } from '../packages/core/src/authoring.ts';
import { addAddons, hostWithExtension, hostWithoutExtension, listAddons, removeAddon, renderInitialHost, validateDeclaredExtensions, describeInstalledArtifacts, readArtifactMember } from '../packages/core/src/addon-install.ts';
import { parseAddonManifest, withRequirements } from '../packages/core/src/addon-manifest.ts';
import type { AddonManifest } from '../packages/core/src/addon-manifest.ts';
import type { ExtensionEntry } from '../packages/core/src/extensions.ts';
import { loadDocument } from '../packages/core/src/config.ts';

const fixtures = fileURLToPath(new URL('./fixtures/addons/', import.meta.url));
const pin = 'a'.repeat(64);
process.env.URLCODE_NPM = join(fixtures, 'fake-npm.mjs');

async function fixture(name: string): Promise<ExtensionEntry & ((options?: unknown) => ExtensionEntry)> {
  return (await import(pathToFileURL(join(fixtures, name, 'extension.js')).href) as { default: ExtensionEntry & ((options?: unknown) => ExtensionEntry) }).default;
}
function manifest(dirs: Record<string, string> = {}): AddonManifest {
  const dir = (name: string): string => dirs[name] ?? join(fixtures, name);
  return parseAddonManifest({ format: 1, version: '9.9.9', addons: {
    alpha: { kind: 'extension', package: '@jimhoyd/urlcode-alpha', description: 'alpha', requires: [], url: `file:${dir('alpha')}`, integrity: null },
    beta: { kind: 'extension', package: '@jimhoyd/urlcode-beta', description: 'beta', requires: ['alpha'], url: `file:${dir('beta')}`, integrity: null },
    notes: { kind: 'artifact', package: '@jimhoyd/urlcode-notes', description: 'notes', requires: [], url: `file:${dir('notes')}`, integrity: null },
  } }, 'test manifest');
}
async function site(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-site-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return (await initSite(join(root, 'site'))).site;
}

test('composeHost orders by requires, shares exports and contributions, and closes in reverse', async t => {
  const alpha = await fixture('alpha'), beta = await fixture('beta');
  const root = await mkdtemp(join(tmpdir(), 'urlcode-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(fixtures, 'alpha'), root, { recursive: true });
  await writeFile(join(root, 'data-placeholder'), '');
  await (await import('node:fs/promises')).mkdir(join(root, 'data'));
  await writeFile(join(root, 'data', 'alpha.key'), new Uint8Array(32));
  const hostUrl = pathToFileURL(join(root, 'host.mjs'));
  const previous = process.env.PROJECT_SHA256;
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });

  delete process.env.PROJECT_SHA256;
  assert.deepEqual(await composeHost(hostUrl, []), { extensions: [] }, 'a site with no extensions needs no pin');
  await assert.rejects(composeHost(hostUrl, [alpha()]), /PROJECT_SHA256/);

  process.env.PROJECT_SHA256 = pin;
  await assert.rejects(composeHost(hostUrl, [beta()]), /beta requires alpha; add it with `urlcode extensions add alpha`/);
  const host = await composeHost(hostUrl, [beta(), alpha({ suffix: '!' })]);
  assert.deepEqual(host.extensions!.map(item => item.name), ['alpha', 'beta'], 'the list order does not matter');
  const seen = (globalThis as { betaSaw?: unknown }).betaSaw;
  assert.deepEqual(seen, { alpha: { keyLength: 32 }, contributions: [{ from: 'alpha' }] });
  (globalThis as { alphaClosed?: number }).alphaClosed = 0;
  await host.close!();
  assert.equal((globalThis as { alphaClosed?: number }).alphaClosed, 1);
});

test('host.mjs lines are added and removed one line each, and hand edits refuse', () => {
  const initial = renderInitialHost();
  const withAlpha = hostWithExtension(initial, 'alpha');
  assert.match(withAlpha, /^import alpha from '@jimhoyd\/urlcode-alpha\/extension';$/m);
  assert.match(withAlpha, /^ {2}alpha\(\),$/m);
  assert.equal(hostWithExtension(withAlpha, 'alpha'), withAlpha, 'adding twice is a no-op');
  const both = hostWithExtension(withAlpha, 'beta');
  assert.equal(hostWithoutExtension(hostWithoutExtension(both, 'beta'), 'alpha'), initial);
  assert.equal(hostWithExtension(initial, 'default').includes('import defaultExtension from'), true, 'reserved words get a suffix');
  const edited = both.replace('  alpha(),', '  alpha({\n    suffix: "!",\n  }),');
  assert.throws(() => hostWithoutExtension(edited, 'alpha'), /remove alpha from host\.mjs yourself/);
  assert.throws(() => hostWithExtension('export default {};\n', 'alpha'), /add these two lines yourself/);
});

test('withRequirements adds requirements once, in dependency order', () => {
  assert.deepEqual(withRequirements(manifest(), ['beta', 'alpha']), ['alpha', 'beta']);
  assert.throws(() => withRequirements(manifest(), ['gamma']), /Unknown add-on gamma/);
});

test('extensions add, list, validate and remove a site end to end', async t => {
  const dir = await site(t), m = manifest();
  const log = join(dir, 'npm.log'); process.env.FAKE_NPM_LOG = log;
  t.after(() => { delete process.env.FAKE_NPM_LOG; });

  await assert.rejects(addAddons(dir, 'extension', ['notes'], { manifest: m }), /notes is an artifact; use `urlcode artifacts add notes`/);
  await assert.rejects(addAddons(dir, 'extension', ['gamma'], { manifest: m }), /Unknown extension gamma; this core \(9\.9\.9\) has: alpha, beta/);
  const before = await readFile(join(dir, 'package.json'), 'utf8');
  await assert.rejects(addAddons(dir, 'extension', ['beta'], { manifest: m }), /beta is risky\. If you accept that risk, re-run with the acknowledgement: urlcode extensions add beta --ack beta:risky/);
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), before, 'a refusal rolls package.json back');
  await assert.rejects(stat(join(dir, 'data', 'alpha.key')), /ENOENT/, 'nothing is written before the refusal');

  const added = await addAddons(dir, 'extension', ['beta'], { manifest: m, acknowledgements: ['beta:risky'] });
  assert.deepEqual(added.added, ['alpha', 'beta'], 'requirements are added first');
  assert.match(added.projectSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(added.env, { ALPHA_MODE: 'Optional mode for the fixture' });
  assert.deepEqual(added.notes, ['installed: alpha,beta']);
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies['@jimhoyd/urlcode-alpha'], `file:${join(fixtures, 'alpha')}`);
  const loaded = await loadDocument(join(dir, 'app'));
  assert.deepEqual(loaded.document.extensions, { alpha: { version: '1', config: { greeting: 'hello' } }, beta: { version: '1', config: {} } });
  assert.deepEqual(loaded.document.includes, ['routes/alpha.yaml', 'routes/beta.yaml']);
  assert.match(await readFile(join(dir, 'app', 'routes', 'beta.yaml'), 'utf8'), /# risky on purpose/);
  // Windows has no POSIX modes; everywhere else the key must be private to its owner.
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'data', 'alpha.key'))).mode & 0o777, 0o600);
  const host = await readFile(join(dir, 'host.mjs'), 'utf8');
  assert.match(host, /import alpha from '@jimhoyd\/urlcode-alpha\/extension';\nimport beta from '@jimhoyd\/urlcode-beta\/extension';/);

  const again = await addAddons(dir, 'extension', ['alpha'], { manifest: m });
  assert.deepEqual([again.added, again.alreadyInstalled], [[], ['alpha']], 'adding an installed extension is a no-op');

  const report = await listAddons(dir, 'extension', { manifest: m });
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.addons.map(item => [item.name, item.pinned, item.declared, item.hosted]), [['alpha', true, true, true], ['beta', true, true, true]]);
  assert.deepEqual(await validateDeclaredExtensions(join(dir, 'app')), []);
  const yaml = join(dir, 'app', 'urlcode.yaml');
  await writeFile(yaml, (await readFile(yaml, 'utf8')).replace('greeting: hello', 'greeting: 5'));
  assert.match((await validateDeclaredExtensions(join(dir, 'app'))).join('\n'), /extensions\.alpha\.config: data\/greeting must be string/);
  await writeFile(yaml, (await readFile(yaml, 'utf8')).replace('greeting: 5', 'greeting: hello'));

  await assert.rejects(removeAddon(dir, 'extension', 'alpha', { manifest: m }), /beta requires alpha; remove it first/);
  const removed = await removeAddon(dir, 'extension', 'beta', { manifest: m });
  assert.deepEqual(removed.kept, []);
  await assert.rejects(stat(join(dir, 'app', 'routes', 'beta.yaml')), /ENOENT/);
  const afterBeta = await loadDocument(join(dir, 'app'));
  assert.deepEqual(Object.keys(afterBeta.document.extensions ?? {}), ['alpha']);
  assert.deepEqual(afterBeta.document.includes, ['routes/alpha.yaml']);

  // A route outside alpha's own file that uses it blocks removal until it is changed.
  await writeFile(join(dir, 'app', 'urlcode.yaml'), (await readFile(join(dir, 'app', 'urlcode.yaml'), 'utf8')).replace('routes: {}', 'routes:\n  /mine:\n    extension: alpha\n    methods: [GET]'));
  await assert.rejects(removeAddon(dir, 'extension', 'alpha', { manifest: m }), /still uses alpha in \/mine/);
  await writeFile(join(dir, 'app', 'urlcode.yaml'), (await readFile(join(dir, 'app', 'urlcode.yaml'), 'utf8')).replace('routes:\n  /mine:\n    extension: alpha\n    methods: [GET]', 'routes: {}'));
  const removedAlpha = await removeAddon(dir, 'extension', 'alpha', { manifest: m });
  assert.deepEqual(removedAlpha.kept, ['data/alpha.key'], 'operator files and data are never deleted');
  assert.equal(await readFile(join(dir, 'host.mjs'), 'utf8'), renderInitialHost());
  const readded = await addAddons(dir, 'extension', ['alpha'], { manifest: m });
  assert.deepEqual(readded.keptFiles, ['data/alpha.key'], 're-adding keeps the existing key');
  assert.ok((await readFile(log, 'utf8')).split('\n').filter(Boolean).every(line => JSON.parse(line).includes('--ignore-scripts')), 'npm never runs lifecycle scripts');
});

test('a failed npm install rolls every file back', async t => {
  const dir = await site(t);
  process.env.FAKE_NPM_FAIL = 'install';
  t.after(() => { delete process.env.FAKE_NPM_FAIL; });
  const files = ['package.json', 'host.mjs', 'app/urlcode.yaml'];
  const before = await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')));
  await assert.rejects(addAddons(dir, 'extension', ['alpha'], { manifest: manifest() }), /npm install .* failed/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, file), 'utf8'))), before);
});

test('artifacts share the shape but stay inert', async t => {
  const dir = await site(t);
  await assert.rejects(addAddons(dir, 'artifact', ['alpha'], { manifest: manifest() }), /alpha is an extension; use `urlcode extensions add alpha`/);
  const added = await addAddons(dir, 'artifact', ['notes'], { manifest: manifest() });
  assert.deepEqual(added.added, ['notes']);
  assert.equal(added.projectSha256, undefined, 'an artifact never changes the project');
  assert.doesNotMatch(await readFile(join(dir, 'host.mjs'), 'utf8'), /notes/);
  assert.deepEqual((await listAddons(dir, 'artifact', { manifest: manifest() })).problems, []);
  const described = await describeInstalledArtifacts(join(dir, 'app'), { manifest: manifest() });
  assert.deepEqual(described.artifacts.map(item => [item.name, item.files]), [['notes', ['package.json', 'schemas/config.json', 'urlcode.json']]]);
  assert.deepEqual((await readArtifactMember(join(dir, 'app'), 'notes', 'schemas/config.json', { manifest: manifest() })).content, { type: 'object' });
  await removeAddon(dir, 'artifact', 'notes', { manifest: manifest() });

  const unsafe = await mkdtemp(join(tmpdir(), 'urlcode-unsafe-'));
  t.after(() => rm(unsafe, { recursive: true, force: true }));
  await cp(join(fixtures, 'notes'), unsafe, { recursive: true });
  await writeFile(join(unsafe, 'index.js'), 'export default 1;\n');
  await assert.rejects(addAddons(dir, 'artifact', ['notes'], { manifest: manifest({ notes: unsafe }) }), /contains index\.js, which is not declarative data/);
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['@jimhoyd/urlcode-notes'], undefined, 'the refused artifact is rolled back');
});

test('a development manifest is refused if it is mixed into a pinned one, and pins must be sha512', () => {
  assert.throws(() => parseAddonManifest({ format: 1, version: '1.0.0', addons: { x: { kind: 'extension', package: '@jimhoyd/urlcode-x', description: '', requires: [], url: 'https://example.com/x.tgz', integrity: 'sha512-abc' } } }, 'm'), /invalid URL/);
  assert.throws(() => parseAddonManifest({ format: 1, version: '1.0.0', addons: { x: { kind: 'extension', package: '@jimhoyd/urlcode-x', description: '', requires: [], url: 'https://github.com/jimhoyd-com/urlcode/releases/download/v1.0.0/x.tgz', integrity: null } } }, 'm'), /must pin a sha512 integrity/);
  assert.throws(() => parseAddonManifest({ format: 1, version: '1.0.0', addons: { x: { kind: 'extension', package: '@jimhoyd/urlcode-x', description: '', requires: ['y'], url: 'file:/x', integrity: null } } }, 'm'), /requires y, which the manifest does not list/);
});
