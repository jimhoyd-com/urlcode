// The release-wide add-on agent catalog (#721): dist/addon-catalog.json, generated from every add-on descriptor,
// drift-checked with the descriptors, and read back as metadata without importing any add-on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { addonCatalog, developmentManifest, syncExpectedFiles } from '../scripts/build-addon-manifest.ts';
import { buildAddonCatalog, parseAddonCatalog, parseAddonManifest, parseDescriptor, readAddonCatalog, withRequirements } from '../packages/core/src/addon-manifest.ts';

const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const agent = (name: string) => ({ description: `References for ${name}.`, references: [{ name: `${name} guide`, description: `How to configure ${name}.`, path: 'README.md' }] });

/** A checkout-shaped root: one extension with a built ./extension definition, one artifact with a hand-written descriptor. */
async function checkout(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-addon-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path: string, text: string): Promise<void> => { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), text); };
  await write('package.json', json({ name: '@jimhoyd/urlcode', version: '9.9.9' }));
  await write('packages/alpha/package.json', json({ name: '@jimhoyd/urlcode-alpha', version: '9.9.9', type: 'module' }));
  await write('packages/alpha/urlcode.json', json({ kind: 'extension', name: 'alpha', description: 'stub', requires: [], schema: {} }));
  await write('packages/alpha/dist/extension.js', `export default { definition: ${JSON.stringify({ name: 'alpha', description: 'Alpha extension', schema: { type: 'object' }, agent: agent('alpha') })} };\n`);
  await write('artifacts/notes/package.json', json({ name: '@jimhoyd/urlcode-notes', version: '9.9.9' }));
  await write('artifacts/notes/urlcode.json', json({ kind: 'artifact', name: 'notes', description: 'Notes artifact', requires: ['alpha'], agent: agent('notes') }));
  return root;
}

test('the catalog is generated from every add-on descriptor, extension and artifact, with its agent metadata', async t => {
  const root = await checkout(t);
  // Before the build rewrites urlcode.json the catalog already follows what the code says, not the stale descriptor.
  assert.deepEqual((await syncExpectedFiles(root, { check: true })).map(path => path.slice(root.length + 1).split('\\').join('/')).sort(), ['dist/addon-catalog.json', 'packages/alpha/urlcode.json']);
  assert.equal((await syncExpectedFiles(root)).length, 2);
  assert.deepEqual(await syncExpectedFiles(root, { check: true }), []);
  const written = JSON.parse(await readFile(join(root, 'dist', 'addon-catalog.json'), 'utf8')) as unknown;
  assert.deepEqual(written, {
    format: 1, scope: 'release', version: '9.9.9',
    addons: [
      { name: 'alpha', kind: 'extension', package: '@jimhoyd/urlcode-alpha', version: '9.9.9', description: 'Alpha extension', requires: [], agent: agent('alpha') },
      { name: 'notes', kind: 'artifact', package: '@jimhoyd/urlcode-notes', version: '9.9.9', description: 'Notes artifact', requires: ['alpha'], agent: agent('notes') },
    ],
  });
  // Metadata only: the extension's schema and code-level contract stay in its own descriptor.
  assert.equal(JSON.stringify(written).includes('schema'), false);
  assert.equal(await addonCatalog(root), await readFile(join(root, 'dist', 'addon-catalog.json'), 'utf8'));
});

test('the drift check fails when the built catalog or an artifact descriptor changes without a rebuild', async t => {
  const root = await checkout(t);
  await syncExpectedFiles(root);
  assert.deepEqual(await syncExpectedFiles(root, { check: true }), []);
  const catalog = join(root, 'dist', 'addon-catalog.json');
  await writeFile(catalog, (await readFile(catalog, 'utf8')).replace('Alpha extension', 'Edited by hand'));
  assert.deepEqual(await syncExpectedFiles(root, { check: true }), [catalog]);
  await syncExpectedFiles(root);
  const descriptor = join(root, 'artifacts', 'notes', 'urlcode.json');
  await writeFile(descriptor, json({ kind: 'artifact', name: 'notes', description: 'Renamed notes', requires: [] }));
  assert.deepEqual(await syncExpectedFiles(root, { check: true }), [catalog]);
  await rm(catalog);
  assert.deepEqual(await syncExpectedFiles(root, { check: true }), [catalog]);
});

test('building and parsing refuse a catalog that is not bounded metadata of one release', () => {
  const source = (descriptor: Record<string, unknown>, version = '1.0.0') => ({ descriptor: { kind: 'artifact', requires: [], ...descriptor }, package: `@jimhoyd/urlcode-${String(descriptor.name)}`, version, source: `${String(descriptor.name)}/urlcode.json` });
  const catalog = buildAddonCatalog('1.0.0', [source({ name: 'zeta', description: 'z' }), source({ name: 'beta', description: 'b', requires: ['zeta'] })]);
  assert.deepEqual(catalog.addons.map(entry => entry.name), ['beta', 'zeta']);
  assert.deepEqual(parseAddonCatalog(JSON.parse(JSON.stringify(catalog)), 'round trip'), catalog);
  assert.throws(() => buildAddonCatalog('1.0.0', [source({ name: 'beta', description: 'b', requires: ['missing'] })]), /requires missing/);
  assert.throws(() => buildAddonCatalog('1.0.0', [source({ name: 'beta', description: 'b' }, '0.9.0')]), /shares core's version/);
  assert.throws(() => buildAddonCatalog('1.0.0', [{ ...source({ name: 'beta', description: 'b' }), package: '@other/beta' }]), /must be packaged as/);
  assert.throws(() => buildAddonCatalog('1.0.0', [source({ name: 'beta', description: 'b', agent: { description: 'x', references: [{ name: 'r', description: 'd', path: '../secret.txt' }] } })]), /bounded local \.md or \.json/);
  assert.throws(() => parseAddonCatalog({ ...catalog, scope: 'project' }, 'wrong scope'), /is not an add-on catalog/);
  assert.throws(() => parseAddonCatalog({ ...catalog, addons: [...catalog.addons, catalog.addons[0]] }, 'duplicate'), /listed twice/);
  assert.throws(() => parseAddonCatalog({ ...catalog, addons: [{ ...catalog.addons[0], package: '@jimhoyd/urlcode-other' }] }, 'package'), /malformed/);
});

test('uses round-trips from the definition through urlcode.json, the catalog and the development manifest, never as a requirement', async t => {
  const root = await checkout(t);
  await writeFile(join(root, 'packages/alpha/dist/extension.js'), `export default { definition: ${JSON.stringify({ name: 'alpha', description: 'Alpha extension', schema: { type: 'object' }, uses: ['zeta', 'mail'] })} };\n`);
  await syncExpectedFiles(root);
  const descriptor = JSON.parse(await readFile(join(root, 'packages/alpha/urlcode.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(descriptor).slice(0, 5), ['kind', 'name', 'description', 'requires', 'uses'], 'uses follows requires');
  assert.deepEqual([descriptor.requires, descriptor.uses], [[], ['mail', 'zeta']]);
  const catalog = parseAddonCatalog(JSON.parse(await readFile(join(root, 'dist', 'addon-catalog.json'), 'utf8')), 'catalog');
  assert.deepEqual(catalog.addons.find(entry => entry.name === 'alpha'), { name: 'alpha', kind: 'extension', package: '@jimhoyd/urlcode-alpha', version: '9.9.9', description: 'Alpha extension', requires: [], uses: ['mail', 'zeta'] }, 'a used add-on need not be in the release');
  const manifest = parseAddonManifest(JSON.parse(await developmentManifest(root)), 'development manifest');
  assert.deepEqual([manifest.addons.alpha!.requires, manifest.addons.alpha!.uses], [[], ['mail', 'zeta']]);
  assert.deepEqual(withRequirements(manifest, ['alpha']), ['alpha'], 'uses never enters the requires closure');
  assert.throws(() => parseDescriptor({ ...descriptor, requires: ['mail'] }, 'overlap'), /uses must be a list of other extension names, disjoint from requires/);
  assert.throws(() => parseDescriptor({ ...descriptor, uses: ['alpha'] }, 'self'), /disjoint from requires/);
  assert.throws(() => parseDescriptor({ kind: 'artifact', name: 'notes', description: 'n', requires: [], uses: ['alpha'] }, 'artifact'), /carries no extension contract/);
});

test('readAddonCatalog reads the catalog file without importing, installing or activating any add-on', async t => {
  const root = await checkout(t);
  await syncExpectedFiles(root);
  const file = join(root, 'dist', 'addon-catalog.json');
  assert.deepEqual(await readAddonCatalog(file), JSON.parse(await readFile(file, 'utf8')));
  await assert.rejects(readAddonCatalog(join(root, 'missing.json')), /no add-on catalog/);
  // In a fresh process, record every module the public agent-context entry point and a catalog read resolve: none is
  // an add-on package or an add-on workspace. The fixture's extension module would throw if it were ever imported.
  await writeFile(join(root, 'packages', 'alpha', 'dist', 'extension.js'), 'throw new Error("imported an add-on");\n');
  const entry = new URL('../packages/core/src/agent-context.ts', import.meta.url).href;
  const script = `import {registerHooks} from 'node:module';
const seen = [];
registerHooks({resolve(specifier, context, next) { const result = next(specifier, context); seen.push(result.url); return result; }});
const {readAddonCatalog} = await import(${JSON.stringify(entry)});
const catalog = await readAddonCatalog(${JSON.stringify(file)});
process.stdout.write(JSON.stringify({names: catalog.addons.map(addon => addon.name), addons: seen.filter(url => /@jimhoyd[\\/+]urlcode-|[\\/](?:packages[\\/](?!core[\\/])|artifacts[\\/])/.test(url))}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { names: ['alpha', 'notes'], addons: [] });
});
