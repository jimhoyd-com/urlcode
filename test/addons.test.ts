import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { composeHost } from '../packages/core/src/host.ts';
import { initSite } from '../packages/core/src/authoring.ts';
import { addAddons, assertInertArtifact, hostWithExtension, hostWithoutExtension, listAddons, removeAddon, renderInitialHost, validateDeclaredExtensions, describeInstalledArtifacts, readArtifactMember, yamlAppendItem, yamlDelete, yamlInsertEntry } from '../packages/core/src/addon-install.ts';
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
/** Every path under node_modules with its type (a link names its target), or undefined when there is none. */
async function modules(dir: string): Promise<Record<string, string> | undefined> {
  const out: Record<string, string> = {};
  const walk = async (path: string, rel: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), key = rel ? `${rel}/${name}` : name, info = await lstat(child);
      if (info.isSymbolicLink()) out[key] = `link:${await readlink(child)}`;
      else if (info.isDirectory()) { out[key] = 'dir'; await walk(child, key); }
      else out[key] = await readFile(child, 'utf8');
    }
  };
  try { await walk(join(dir, 'node_modules'), ''); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  return out;
}
const lockText = (dir: string): Promise<string | undefined> => readFile(join(dir, 'package-lock.json'), 'utf8').catch(() => undefined);
/** A copy of the notes fixture whose package.json `change` edits, so its pin URL differs from the fixture's. */
async function notesCopy(t: TestContext, change: (pkg: Record<string, unknown>) => void = () => undefined): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-notes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(join(fixtures, 'notes'), dir, { recursive: true });
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  change(pkg);
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
  return dir;
}
function env(t: TestContext, values: Record<string, string>): void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
/** A fake registry holding the site's own core pin plus `extra` packages (name@version -> package.json). */
async function registry(t: TestContext, dir: string, extra: Record<string, Record<string, unknown>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const core = (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@jimhoyd/urlcode']!;
  for (const [id, pkg] of Object.entries({ [`@jimhoyd/urlcode@${core}`]: { name: '@jimhoyd/urlcode', version: core }, ...extra })) {
    const target = join(root, id.replace('/', '+'));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'package.json'), JSON.stringify(pkg));
  }
  return root;
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
  const optional = parseAddonManifest({ format: 1, version: '9.9.9', addons: { ...manifest().addons, alpha: { ...manifest().addons.alpha!, uses: ['notes'] } } }, 'uses manifest');
  assert.deepEqual(optional.addons.alpha!.uses, ['notes']);
  assert.deepEqual(withRequirements(optional, ['alpha']), ['alpha'], 'uses is never followed');
  assert.throws(() => parseAddonManifest({ format: 1, version: '9.9.9', addons: { ...manifest().addons, beta: { ...manifest().addons.beta!, uses: ['alpha'] } } }, 'overlap'), /beta has malformed uses/);
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
  // An add-on that only uses the removed one does not block removal; it gets one note.
  const using = parseAddonManifest({ ...structuredClone(m), addons: { ...structuredClone(m.addons), alpha: { ...m.addons.alpha!, uses: ['beta'] } } }, 'uses manifest');
  const removed = await removeAddon(dir, 'extension', 'beta', { manifest: using });
  assert.deepEqual(removed.kept, []);
  assert.deepEqual(removed.notes, ['alpha uses beta; features of alpha that need beta will refuse to activate']);
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
  assert.deepEqual(removedAlpha.notes, []);
  assert.equal(await readFile(join(dir, 'host.mjs'), 'utf8'), renderInitialHost());
  const readded = await addAddons(dir, 'extension', ['alpha'], { manifest: m });
  assert.deepEqual(readded.keptFiles, ['data/alpha.key'], 're-adding keeps the existing key');
  assert.ok((await readFile(log, 'utf8')).split('\n').filter(Boolean).every(line => JSON.parse(line).includes('--ignore-scripts')), 'npm never runs lifecycle scripts');
});

test('extensions add installs the capability only; --example adds the example on top (#711)', async t => {
  const m = manifest();
  const blank = await site(t);
  const plain = await addAddons(blank, 'extension', ['alpha'], { manifest: m });
  assert.deepEqual(plain.examples, []);
  const loadedBlank = await loadDocument(join(blank, 'app'));
  assert.deepEqual(Object.keys(loadedBlank.routes), ['/alpha/*'], 'a blank install adds no sample endpoint');
  assert.deepEqual(loadedBlank.document.extensions?.alpha?.config, { greeting: 'hello' });
  assert.deepEqual(plain.notes, ['installed: alpha']);
  await assert.rejects(addAddons(blank, 'extension', ['alpha'], { manifest: m, example: true }), /--example has no effect: alpha is already installed/);

  const demo = await site(t);
  const withExample = await addAddons(demo, 'extension', ['alpha'], { manifest: m, example: true });
  assert.deepEqual(withExample.examples, ['alpha']);
  const loaded = await loadDocument(join(demo, 'app'));
  assert.deepEqual(Object.keys(loaded.routes).sort(), ['/alpha-demo', '/alpha/*']);
  assert.deepEqual(loaded.document.extensions?.alpha?.config, { greeting: 'hello from the example' }, 'example config merges over the capability');
  assert.deepEqual(withExample.notes, ['installed: alpha', 'example: open /alpha-demo']);
  assert.deepEqual(withExample.env, { ALPHA_MODE: 'Optional mode for the fixture' });

  // An extension with no example refuses --example rather than silently doing nothing, and rolls back.
  const before = await readFile(join(demo, 'package.json'), 'utf8');
  await assert.rejects(addAddons(demo, 'extension', ['beta'], { manifest: m, example: true, acknowledgements: ['beta:risky'] }), /--example has no effect: beta ships no example/);
  assert.equal(await readFile(join(demo, 'package.json'), 'utf8'), before);
  await assert.rejects(addAddons(demo, 'artifact', ['notes'], { manifest: m, example: true }), /--example is only supported by extensions add/);
});

// Flow collections without padding, odd spacing, a long plain scalar, comments and a blank line: everything a
// whole-document re-serialisation would rewrite (#715).
const handWritten = [
  '# yaml-language-server: $schema=./schema.json',
  '# Odd   spacing   on purpose.',
  'version:   "1"',
  'includes: [routes/mine.yaml]   # flow, unpadded',
  'routes:',
  '  /go:    {redirect: {url: \'https://example.com/\'}}',
  '  /moved:',
  '    redirect: {url: \'https://example.com/new\',status: 308}',
  '    response:',
  '      headers:',
  '        Cache-Control: public, max-age=60, stale-while-revalidate=86400, stale-if-error=604800, must-revalidate',
  '',
  '# a trailing comment',
  '',
].join('\n');

test('extensions add and remove edit only the extensions and includes nodes of urlcode.yaml (#715)', async t => {
  const m = manifest();
  const write = async (dir: string): Promise<string> => {
    await writeFile(join(dir, 'app', 'urlcode.yaml'), handWritten);
    await mkdir(join(dir, 'app', 'routes'), { recursive: true });
    await writeFile(join(dir, 'app', 'routes', 'mine.yaml'), 'version: "1"\nroutes:\n  /mine: {respond: {text: mine}}\n');
    return join(dir, 'app', 'urlcode.yaml');
  };
  const inserted = (greeting: string): string => handWritten
    .replace('includes: [routes/mine.yaml]', 'includes: [routes/mine.yaml, routes/alpha.yaml]')
    .replace('must-revalidate\n', `must-revalidate\nextensions:\n  alpha:\n    version: "1"\n    config:\n      greeting: ${greeting}\n`);

  const blank = await site(t), blankYaml = await write(blank);
  await addAddons(blank, 'extension', ['alpha'], { manifest: m });
  assert.equal(await readFile(blankYaml, 'utf8'), inserted('hello'), 'a blank add inserts the extensions block and one include, byte for byte');

  const demo = await site(t), demoYaml = await write(demo);
  await addAddons(demo, 'extension', ['alpha'], { manifest: m, example: true });
  const withAlpha = inserted('hello from the example');
  assert.equal(await readFile(demoYaml, 'utf8'), withAlpha, '--example changes only the same two nodes');
  await addAddons(demo, 'extension', ['beta'], { manifest: m, acknowledgements: ['beta:risky'] });
  assert.equal(await readFile(demoYaml, 'utf8'), withAlpha
    .replace('routes/alpha.yaml]', 'routes/alpha.yaml, routes/beta.yaml]')
    .replace('greeting: hello from the example\n', 'greeting: hello from the example\n  beta:\n    version: "1"\n    config: {}\n'), 'a second extension appends to the existing block');
  await removeAddon(demo, 'extension', 'beta', { manifest: m });
  assert.equal(await readFile(demoYaml, 'utf8'), withAlpha, 'remove deletes exactly what add inserted');
  await removeAddon(demo, 'extension', 'alpha', { manifest: m });
  assert.equal(await readFile(demoYaml, 'utf8'), handWritten, 'removing every extension restores the hand-written file');
});

test('the minimal YAML edits handle block and flow collections and keep CRLF', () => {
  const block = 'version: "1"\nextensions:\n    kept:   {version: "1", config: {}}\nincludes:\n-   routes/kept.yaml   # mine\nroutes: {}\n';
  const added = yamlAppendItem(yamlInsertEntry(block, ['extensions'], 'alpha', { version: '1', config: { a: [1, 2] } }), ['includes'], 'routes/alpha.yaml');
  assert.equal(added, 'version: "1"\nextensions:\n    kept:   {version: "1", config: {}}\n    alpha:\n      version: "1"\n      config:\n        a:\n          - 1\n          - 2\nincludes:\n-   routes/kept.yaml   # mine\n- routes/alpha.yaml\nroutes: {}\n');
  assert.equal(yamlDelete(yamlDelete(added, ['includes', 1]), ['extensions', 'alpha']), block);
  const flow = 'version: "1"\nextensions: {kept: {version: "1", config: {}}}\nincludes: []\nroutes: {}\n';
  const flowAdded = yamlAppendItem(yamlInsertEntry(flow, ['extensions'], 'alpha', { version: '1', config: {} }), ['includes'], 'routes/alpha.yaml');
  assert.equal(flowAdded, 'version: "1"\nextensions: {kept: {version: "1", config: {}}, alpha: {version: "1", config: {}}}\nincludes: [routes/alpha.yaml]\nroutes: {}\n');
  assert.equal(yamlDelete(yamlDelete(flowAdded, ['extensions', 'alpha']), ['includes', 0]), 'version: "1"\nextensions: {kept: {version: "1", config: {}}}\nroutes: {}\n', 'an emptied sequence goes');
  const crlf = 'version: "1"\r\nroutes: {}\r\n';
  assert.equal(yamlAppendItem(crlf, ['includes'], 'routes/a.yaml'), 'version: "1"\r\nroutes: {}\r\nincludes:\r\n  - routes/a.yaml\r\n');
  assert.equal(yamlInsertEntry('version: "1"\nroutes: {}', ['extensions'], 'a', { version: '1' }), 'version: "1"\nroutes: {}\nextensions:\n  a:\n    version: "1"\n', 'a file without a final newline gets one before the insert');
});

test('list --strict accepts an extension installed only as a library, but not drift or a pin mismatch (#718)', async t => {
  const m = manifest(), dir = await site(t);
  await addAddons(dir, 'extension', ['alpha'], { manifest: m });
  const yaml = join(dir, 'app', 'urlcode.yaml'), hostFile = join(dir, 'host.mjs'), lockFile = join(dir, 'package-lock.json');
  const wired = { yaml: await readFile(yaml, 'utf8'), host: await readFile(hostFile, 'utf8') };
  // Unwire alpha as remove would, keeping the package installed: a library dependency, not an extension.
  const library = { yaml: yamlDelete(yamlDelete(wired.yaml, ['includes', 0]), ['extensions', 'alpha']), host: hostWithoutExtension(wired.host, 'alpha') };
  await rm(join(dir, 'app', 'routes', 'alpha.yaml'));
  const state = async (files: { yaml: string; host: string }): Promise<{ mode: string; problems: string[] }> => {
    await writeFile(yaml, files.yaml); await writeFile(hostFile, files.host);
    const report = await listAddons(dir, 'extension', { manifest: m });
    return { mode: report.addons.find(item => item.name === 'alpha')!.mode, problems: report.problems };
  };

  assert.deepEqual(await state(library), { mode: 'library', problems: [] }, 'installed, pinned and neither declared nor imported: clean');
  const declaredOnly = yamlInsertEntry(library.yaml, ['extensions'], 'alpha', { version: '1', config: {} });
  assert.deepEqual(await state({ yaml: declaredOnly, host: library.host }), { mode: 'extension', problems: ['alpha: host.mjs does not import @jimhoyd/urlcode-alpha/extension'] });
  assert.deepEqual(await state({ yaml: library.yaml, host: wired.host }), { mode: 'extension', problems: ['alpha: app/urlcode.yaml does not declare extensions.alpha'] });
  const handWired = library.host.replace("import { composeHost }", "import a from \"@jimhoyd/urlcode-alpha/extension\";\nimport { composeHost }");
  assert.deepEqual((await state({ yaml: library.yaml, host: handWired })).problems, ['alpha: app/urlcode.yaml does not declare extensions.alpha', 'alpha: host.mjs does not import @jimhoyd/urlcode-alpha/extension'], 'an import in another form still wires it as an extension');

  const lock = JSON.parse(await readFile(lockFile, 'utf8')) as { packages: Record<string, Record<string, unknown>> };
  lock.packages['node_modules/@jimhoyd/urlcode-alpha'] = { version: '9.9.9', resolved: 'https://example.test/alpha.tgz', integrity: 'sha512-other' };
  await writeFile(lockFile, JSON.stringify(lock));
  const mismatch = await state(library);
  assert.equal(mismatch.mode, 'library');
  assert.deepEqual(mismatch.problems, [`alpha: @jimhoyd/urlcode-alpha should link the development source file:${join(fixtures, 'alpha')}`], 'a library install is still checked against the pin');
});

test('a failed npm install rolls every file back, and node_modules with them', async t => {
  const dir = await site(t);
  process.env.FAKE_NPM_FAIL = 'install';
  t.after(() => { delete process.env.FAKE_NPM_FAIL; });
  const files = ['package.json', 'host.mjs', 'app/urlcode.yaml'];
  const before = await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')));
  await assert.rejects(addAddons(dir, 'extension', ['alpha'], { manifest: manifest() }), /npm install .* failed/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, file), 'utf8'))), before);
  delete process.env.FAKE_NPM_FAIL;

  // npm can extract packages and write the lock before it fails; node_modules goes back too.
  env(t, { FAKE_NPM_FAIL_AFTER: 'install' });
  await assert.rejects(addAddons(dir, 'extension', ['alpha'], { manifest: manifest() }), /npm install .* failed/);
  assert.deepEqual(await Promise.all(files.map(file => readFile(join(dir, file), 'utf8'))), before);
  assert.equal(await modules(dir), undefined, 'a site without node_modules is left without one');
  assert.equal(await lockText(dir), undefined, 'and without a lock');

  delete process.env.FAKE_NPM_FAIL_AFTER;
  await addAddons(dir, 'artifact', ['notes'], { manifest: manifest() });
  const tree = await modules(dir), lock = await lockText(dir);
  assert.ok(tree?.['@jimhoyd/urlcode-notes']?.startsWith('link:'));
  process.env.FAKE_NPM_FAIL_AFTER = 'install';
  await assert.rejects(addAddons(dir, 'extension', ['alpha'], { manifest: manifest() }), /npm install .* failed/);
  assert.deepEqual([await modules(dir), await lockText(dir)], [tree, lock], 'a locked site is reinstalled from its restored lock');
  await assert.rejects(removeAddon(dir, 'artifact', 'notes', { manifest: manifest() }), /npm install .* failed/);
  assert.deepEqual([await modules(dir), await lockText(dir)], [tree, lock], 'a failed remove puts the removed package back');
  assert.ok((await listAddons(dir, 'artifact', { manifest: manifest() })).addons.some(item => item.name === 'notes' && item.problems.length === 0));
});

test('a refusal after npm has run restores node_modules as well as the files', async t => {
  const dir = await site(t);
  await addAddons(dir, 'artifact', ['notes'], { manifest: manifest() });
  const tree = await modules(dir), lock = await lockText(dir), pkg = await readFile(join(dir, 'package.json'), 'utf8');
  await assert.rejects(addAddons(dir, 'extension', ['beta'], { manifest: manifest() }), /beta is risky/);
  assert.deepEqual([await modules(dir), await lockText(dir), await readFile(join(dir, 'package.json'), 'utf8')], [tree, lock, pkg], 'a refused scaffold leaves no extracted extension behind');
  assert.equal(tree?.['@jimhoyd/urlcode-alpha'], undefined);
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
  const tree = await modules(dir), lock = await lockText(dir);
  await assert.rejects(addAddons(dir, 'artifact', ['notes'], { manifest: manifest({ notes: unsafe }) }), /contains index\.js, which is not declarative data/);
  assert.equal(JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).dependencies['@jimhoyd/urlcode-notes'], undefined, 'the refused artifact is rolled back');
  assert.deepEqual([await modules(dir), await lockText(dir)], [tree, lock], 'and is not left extracted in node_modules');
  assert.equal(tree?.['@jimhoyd/urlcode-notes'], undefined);
});

test('an artifact package.json may carry only identity, notice and file-list keys', async t => {
  const clean = await notesCopy(t, pkg => Object.assign(pkg, { description: 'd', license: 'Apache-2.0', repository: { type: 'vcs', url: 'x' }, homepage: 'h', bugs: { url: 'b' }, keywords: ['k'], author: 'a', contributors: [] }));
  await assertInertArtifact(clean, 'notes');
  await assertInertArtifact(fileURLToPath(new URL('../artifacts/store-schema/', import.meta.url)), 'store-schema');
  for (const [key, value] of [['peerDependencies', { 'is-number': '7.0.0' }], ['peerDependenciesMeta', { 'is-number': { optional: true } }], ['type', 'module'], ['workspaces', ['x']], ['overrides', {}], ['scripts', {}], ['dependencies', {}], ['main', 'index.json']] as const) {
    const dir = await notesCopy(t, pkg => { pkg[key] = value; });
    await assert.rejects(assertInertArtifact(dir, 'notes'), new RegExp(`package\\.json declares ${key}; an artifact's package\\.json may declare only name, version`), key);
  }
});

test('an artifact that would pull in a peer is refused, and neither the peer nor the artifact stays installed', async t => {
  const dir = await site(t);
  env(t, { FAKE_NPM_REGISTRY: await registry(t, dir, { 'is-number@7.0.0': { name: 'is-number', version: '7.0.0' }, 'left-pad@1.0.0': { name: 'left-pad', version: '1.0.0' } }) });
  await addAddons(dir, 'artifact', ['notes'], { manifest: manifest() });
  const tree = await modules(dir), lock = await lockText(dir), pkg = await readFile(join(dir, 'package.json'), 'utf8');

  const peer = await notesCopy(t, item => { item.peerDependencies = { 'is-number': '7.0.0' }; });
  await assert.rejects(addAddons(dir, 'artifact', ['notes'], { manifest: manifest({ notes: peer }) }), /Refusing notes: @jimhoyd\/urlcode-notes declares peerDependencies in package-lock\.json/);
  assert.deepEqual([await modules(dir), await lockText(dir), await readFile(join(dir, 'package.json'), 'utf8')], [tree, lock, pkg]);
  assert.equal(tree?.['is-number'], undefined);

  // Belt and braces: an artifacts-only add to a locked site may add nothing to the lock but the artifacts.
  const moved = await notesCopy(t);
  const edited = JSON.parse(pkg) as { dependencies: Record<string, string> };
  edited.dependencies['left-pad'] = '1.0.0';
  await writeFile(join(dir, 'package.json'), JSON.stringify(edited));
  await assert.rejects(addAddons(dir, 'artifact', ['notes'], { manifest: manifest({ notes: moved }) }), /npm install also added node_modules\/left-pad to package-lock\.json, which no artifact accounts for/);
  assert.deepEqual([await modules(dir), await lockText(dir)], [tree, lock]);

  // An installed artifact whose manifest later gains a peer fails list --strict.
  await writeFile(join(dir, 'package.json'), pkg);
  const drifting = await notesCopy(t);
  await addAddons(dir, 'artifact', ['notes'], { manifest: manifest({ notes: drifting }) });
  await writeFile(join(drifting, 'package.json'), JSON.stringify({ ...JSON.parse(await readFile(join(drifting, 'package.json'), 'utf8')) as object, peerDependencies: { 'is-number': '7.0.0' } }));
  assert.match((await listAddons(dir, 'artifact', { manifest: manifest({ notes: drifting }) })).problems.join('\n'), /notes: Artifact notes package\.json declares peerDependencies/);
});

test('a development manifest is refused if it is mixed into a pinned one, and pins must be sha512', () => {
  assert.throws(() => parseAddonManifest({ format: 1, version: '1.0.0', addons: { x: { kind: 'extension', package: '@jimhoyd/urlcode-x', description: '', requires: [], url: 'https://example.com/x.tgz', integrity: 'sha512-abc' } } }, 'm'), /invalid URL/);
  assert.throws(() => parseAddonManifest({ format: 1, version: '1.0.0', addons: { x: { kind: 'extension', package: '@jimhoyd/urlcode-x', description: '', requires: [], url: 'https://github.com/jimhoyd-com/urlcode/releases/download/v1.0.0/x.tgz', integrity: null } } }, 'm'), /must pin a sha512 integrity/);
  assert.throws(() => parseAddonManifest({ format: 1, version: '1.0.0', addons: { x: { kind: 'extension', package: '@jimhoyd/urlcode-x', description: '', requires: ['y'], url: 'file:/x', integrity: null } } }, 'm'), /requires y, which the manifest does not list/);
});
