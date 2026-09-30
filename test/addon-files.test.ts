// #857 items 2 and 6: `add` records the sha256 of every installed file in addon-files.lock.json; list --strict,
// inspect and `verify` compare against it offline; `verify --online` re-downloads the locked tarball (here from a local
// http server and a file: path, never the real registry); re-running `add <spec>` upgrades an independent package
// through the same checks with full rollback; `outdated` asks the registry (the fake npm's `view`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { initSite } from '../packages/core/src/authoring.ts';
import { addAddons, describeInstalledArtifacts, listAddons, outdatedAddons, removeAddon, validateDeclaredExtensions, verifyAddons } from '../packages/core/src/addon-install.ts';
import { composeHost } from '../packages/core/src/host.ts';
import type { ExtensionEntry } from '../packages/core/src/extensions.ts';
import { parseAddonManifest } from '../packages/core/src/addon-manifest.ts';
import type { AddonManifest } from '../packages/core/src/addon-manifest.ts';
import { inspectInstalledArtifact } from '../packages/core/src/artifact-inspect.ts';
import { runAddonCommand } from '../packages/core/src/extensions-cli.ts';
import { ADDON_FILES_LOCK, newestVersion, readFilesLock, readTarball, registrySpecName } from '../packages/core/src/package-files.ts';
import { loadDocument } from '../packages/core/src/config.ts';
// @ts-expect-error: a plain JavaScript test fixture without type declarations.
import { packTarball } from './fixtures/addons/tarball.mjs';

const fixtures = fileURLToPath(new URL('./fixtures/addons/', import.meta.url));
process.env.URLCODE_NPM = join(fixtures, 'fake-npm.mjs');
const manifest: AddonManifest = parseAddonManifest({ format: 1, version: '9.9.9', addons: {
  notes: { kind: 'artifact', package: '@jimhoyd/urlcode-notes', description: 'notes', requires: [], url: `file:${join(fixtures, 'notes')}`, integrity: null },
} }, 'test manifest');
const pack = packTarball as (dir: string) => Buffer;
const petstorePackage = '@example/urlcode-petstore-docs';

async function temp(t: TestContext, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function env(t: TestContext, values: Record<string, string>): void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
/** A fake registry directory that also holds the site's own core pin, which the fake npm resolves on every install. */
async function registryFor(t: TestContext, dir: string): Promise<string> {
  const root = await temp(t, 'urlcode-registry-');
  const core = (JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@jimhoyd/urlcode']!;
  await mkdir(join(root, `@jimhoyd+urlcode@${core}`));
  await writeFile(join(root, `@jimhoyd+urlcode@${core}`, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode', version: core }));
  return root;
}
async function site(t: TestContext): Promise<string> {
  return (await initSite(join(await temp(t, 'urlcode-files-'), 'site'))).site;
}
/** A copy of fixture `name` at `version`, changed by `change`, packed as a tarball in `into`. */
async function tarball(t: TestContext, into: string, name: string, version: string, change: (dir: string) => Promise<void> = async () => undefined): Promise<string> {
  const dir = await temp(t, 'urlcode-pkg-');
  await cp(join(fixtures, name), dir, { recursive: true });
  const pkgFile = join(dir, 'package.json');
  await writeFile(pkgFile, JSON.stringify({ ...JSON.parse(await readFile(pkgFile, 'utf8')) as object, version }));
  await change(dir);
  const file = join(into, `${name}-${version}.tgz`);
  await writeFile(file, pack(dir));
  return file;
}
const installedPetstore = (dir: string): string => join(dir, 'node_modules', '@example', 'urlcode-petstore-docs');
const printer = (): { printed: unknown[]; print: (value: unknown) => boolean } => { const printed: unknown[] = []; return { printed, print: value => printed.push(value) > 0 }; };

test('the core tarball reader, spec and version helpers', async t => {
  const dir = await temp(t, 'urlcode-tar-');
  const files = readTarball(await readFile(await tarball(t, dir, 'petstore-docs', '1.4.0')));
  assert.deepEqual(Object.keys(files).sort(), ['README.md', 'openapi/petstore.yaml', 'package.json', 'schemas/order.json', 'schemas/pet.json', 'urlcode.json']);
  assert.match(files['README.md']!, /^[a-f0-9]{64}$/);
  assert.throws(() => readTarball(Buffer.from('not gzip')), /not gzip data/);
  assert.deepEqual(['name', 'name@^1.2.0', '@scope/name@1.2.3', '@scope/name', './x.tgz', '/abs/dir', 'file:x', 'https://example.test/x.tgz', 'github:user/repo', 'user/repo', 'name-1.0.0.tgz'].map(registrySpecName),
    ['name', 'name', '@scope/name', '@scope/name', undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.equal(newestVersion(['1.10.0', '1.9.0', '2.0.0-alpha.2', '2.0.0-alpha.10', '1.2.3']), '2.0.0-alpha.10');
  assert.equal(newestVersion(['2.0.0-alpha.1', '2.0.0']), '2.0.0');
});

test('add records every installed file; list --strict, describe, inspect and verify catch a hand-edited file offline; remove drops the record', async t => {
  const dir = await site(t), packages = await temp(t, 'urlcode-tarballs-');
  const file = await tarball(t, packages, 'petstore-docs', '1.4.0');
  const added = await addAddons(dir, 'artifact', [file, 'notes'], { manifest });
  assert.deepEqual(added.added, ['notes', 'petstore-docs']);
  const lock = await readFilesLock(dir);
  assert.deepEqual(Object.keys(lock.packages), [petstorePackage, '@jimhoyd/urlcode-notes'].sort());
  const recorded = lock.packages[petstorePackage]!;
  assert.deepEqual([recorded.name, recorded.kind, recorded.spec, recorded.version, recorded.resolved], ['petstore-docs', 'artifact', file, '1.4.0', `file:${file}`]);
  assert.match(recorded.integrity ?? '', /^sha512-/);
  assert.deepEqual(Object.keys(recorded.files), ['README.md', 'openapi/petstore.yaml', 'package.json', 'schemas/order.json', 'schemas/pet.json', 'urlcode.json']);
  assert.deepEqual(lock.packages['@jimhoyd/urlcode-notes'], { name: 'notes', kind: 'artifact', spec: null, version: '1.0.0', integrity: null, resolved: join(fixtures, 'notes'), linked: true, files: {} }, 'a linked development source is recorded, not hashed');
  assert.match(await readFile(join(dir, ADDON_FILES_LOCK), 'utf8'), /^\{\n {2}"lockfileVersion": 1,/);

  assert.deepEqual((await listAddons(dir, 'artifact', { manifest })).problems, []);
  assert.deepEqual((await inspectInstalledArtifact(dir, 'petstore-docs', { manifest })).artifact.files, { status: 'match', recorded: 6 });
  const clean = printer();
  assert.equal(await runAddonCommand('artifacts', 'verify', [], { site: dir }, clean.print), undefined);
  assert.match(String(clean.printed[0]), /offline: compared with addon-files\.lock\.json/);
  assert.match(String(clean.printed[0]), /petstore-docs 1\.4\.0 @example\/urlcode-petstore-docs: files match addon-files\.lock\.json/);
  assert.match(String(clean.printed[0]), /notes 1\.0\.0 @jimhoyd\/urlcode-notes: linked directory, not hashed/);

  // A hand edit, an added file and a deleted file, all offline.
  await writeFile(join(installedPetstore(dir), 'schemas', 'order.json'), JSON.stringify({ type: 'object', title: 'edited' }));
  await writeFile(join(installedPetstore(dir), 'extra.json'), '{}');
  await rm(join(installedPetstore(dir), 'schemas', 'pet.json'));
  const drift = { added: ['extra.json'], removed: ['schemas/pet.json'], changed: ['schemas/order.json'], counts: { added: 1, removed: 1, changed: 1 } };
  const listed = await listAddons(dir, 'artifact', { manifest });
  assert.deepEqual(listed.addons.find(item => item.name === 'petstore-docs')!.files, { status: 'modified', recorded: 6, drift, message: `${petstorePackage}'s installed files differ from addon-files.lock.json (changed schemas/order.json; added extra.json; removed schemas/pet.json); reinstall with \`npm ci --ignore-scripts\`, or compare with the published tarball using \`urlcode artifacts verify --online\`` });
  assert.match(listed.problems.join('\n'), /petstore-docs: .*installed files differ from addon-files\.lock\.json/);
  const strict = printer();
  assert.equal(await runAddonCommand('artifacts', 'list', [], { site: dir, strict: true }, strict.print), 1);
  const described = (await describeInstalledArtifacts(join(dir, 'app'), { manifest })).artifacts.find(item => item.name === 'petstore-docs')!;
  assert.equal(described.status, 'modified');
  await assert.rejects(inspectInstalledArtifact(dir, 'petstore-docs', { manifest }), /petstore-docs is modified: .*changed schemas\/order\.json; added extra\.json; removed schemas\/pet\.json/);
  const verified = await verifyAddons(dir, 'artifact', 'petstore-docs', { manifest });
  assert.deepEqual([verified.online, verified.addons.map(item => [item.name, item.files.status]), verified.problems.length], [false, [['petstore-docs', 'modified']], 1]);
  const failing = printer();
  assert.equal(await runAddonCommand('artifacts', 'verify', ['petstore-docs'], { site: dir, json: true }, failing.print), 1);
  await assert.rejects(verifyAddons(dir, 'artifact', 'absent', { manifest }), /absent is not an installed artifact/);
  await assert.rejects(runAddonCommand('artifacts', 'list', [], { site: dir, online: true }, failing.print), /--online is only supported by artifacts verify/);

  const removed = await removeAddon(dir, 'artifact', 'petstore-docs', { manifest });
  assert.equal(removed.removed, 'petstore-docs');
  assert.deepEqual(Object.keys((await readFilesLock(dir)).packages), ['@jimhoyd/urlcode-notes'], 'remove drops the record');
  await removeAddon(dir, 'artifact', 'notes', { manifest });
  await assert.rejects(stat(join(dir, ADDON_FILES_LOCK)), /ENOENT/, 'an empty record is no file at all');
});

test('verify --online downloads the locked tarball over http, checks its sha512 and compares file by file; a file: tarball is read locally', async t => {
  const dir = await site(t), registry = await registryFor(t, dir);
  await tarball(t, registry, 'petstore-docs', '1.4.0');
  const { rename } = await import('node:fs/promises');
  await rename(join(registry, 'petstore-docs-1.4.0.tgz'), join(registry, `${petstorePackage.replace('/', '+')}@1.4.0.tgz`));
  let served = await readFile(join(registry, `${petstorePackage.replace('/', '+')}@1.4.0.tgz`));
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(request.url ?? ''); response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(served); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  env(t, { FAKE_NPM_REGISTRY: registry, FAKE_NPM_TARBALL_BASE: base });

  await addAddons(dir, 'artifact', [`${petstorePackage}@1.4.0`], { manifest });
  const recorded = (await readFilesLock(dir)).packages[petstorePackage]!;
  assert.deepEqual([recorded.spec, recorded.resolved], [`${petstorePackage}@1.4.0`, `${base}${petstorePackage.replace('/', '+')}@1.4.0.tgz`]);
  assert.deepEqual(requests, [], 'add, list and offline verify never download anything');
  await listAddons(dir, 'artifact', { manifest });
  await verifyAddons(dir, 'artifact', undefined, { manifest });
  assert.deepEqual(requests, []);

  const clean = await verifyAddons(dir, 'artifact', undefined, { online: true, manifest });
  assert.deepEqual(clean.problems, []);
  const none = { added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0 } };
  assert.deepEqual(clean.addons[0]!.online, { url: recorded.resolved, bytes: served.length, integrity: 'match', installed: none, recorded: none });
  assert.equal(requests.length, 1);

  await writeFile(join(installedPetstore(dir), 'openapi', 'petstore.yaml'), 'openapi: 3.1.0\ninfo: {title: edited, version: "1"}\npaths: {}\n');
  const edited = printer();
  assert.equal(await runAddonCommand('artifacts', 'verify', ['petstore-docs'], { site: dir, online: true }, edited.print), 1);
  const text = String(edited.printed[0]);
  assert.match(text, /--online: a network operation that downloaded each locked tarball/);
  assert.match(text, /sha512 matches package-lock\.json/);
  assert.match(text, /installed vs published: changed openapi\/petstore\.yaml/);
  assert.match(text, /recorded vs published: identical/);

  // A server answering with other bytes: the lock's integrity does not describe them, so nothing is compared.
  served = Buffer.from('tampered');
  const tampered = await verifyAddons(dir, 'artifact', 'petstore-docs', { online: true, manifest });
  assert.deepEqual(tampered.addons[0]!.online, { url: recorded.resolved, bytes: 8, integrity: 'mismatch' });
  assert.match(tampered.problems.join('\n'), /does not match the sha512 integrity package-lock\.json records/);
  await new Promise<void>(resolve => server.close(() => resolve()));
  const offline = await verifyAddons(dir, 'artifact', 'petstore-docs', { online: true, manifest });
  assert.match(JSON.stringify(offline.addons[0]!.online), /"error":"downloading http:\/\/127\.0\.0\.1:\d+\/.* failed/);

  // A package locked to a local tarball is compared the same way, read from disk.
  const local = await site(t), packages = await temp(t, 'urlcode-tarballs-');
  await addAddons(local, 'artifact', [await tarball(t, packages, 'petstore-docs', '1.4.0')], { manifest });
  const fromFile = await verifyAddons(local, 'artifact', undefined, { online: true, manifest });
  assert.deepEqual([fromFile.problems, (fromFile.addons[0]!.online as { integrity: string }).integrity], [[], 'match']);
});

test('re-running add upgrades an independent artifact in place through the same checks, and rolls back fully on refusal', async t => {
  const dir = await site(t), registry = await registryFor(t, dir);
  const publish = async (version: string, change?: (pkgDir: string) => Promise<void>): Promise<void> => {
    const file = await tarball(t, registry, 'petstore-docs', version, change);
    const { rename } = await import('node:fs/promises');
    await rename(file, join(registry, `${petstorePackage.replace('/', '+')}@${version}.tgz`));
  };
  await publish('1.4.0');
  env(t, { FAKE_NPM_REGISTRY: registry });
  await addAddons(dir, 'artifact', [`${petstorePackage}@1.4.0`], { manifest });

  await publish('1.4.1', async pkgDir => { await writeFile(join(pkgDir, 'schemas', 'extra.json'), '{"type":"string"}'); });
  const upgraded = await addAddons(dir, 'artifact', [petstorePackage], { manifest });
  assert.deepEqual([upgraded.added, upgraded.upgraded], [[], [{ name: 'petstore-docs', package: petstorePackage, from: '1.4.0', to: '1.4.1' }]]);
  const recorded = (await readFilesLock(dir)).packages[petstorePackage]!;
  assert.deepEqual([recorded.version, recorded.spec, Object.hasOwn(recorded.files, 'schemas/extra.json')], ['1.4.1', petstorePackage, true]);
  assert.equal((JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies[petstorePackage], '1.4.1');
  assert.deepEqual((await listAddons(dir, 'artifact', { manifest })).problems, []);
  const again = await addAddons(dir, 'artifact', [petstorePackage], { manifest });
  assert.deepEqual([again.upgraded, again.alreadyInstalled], [[], [petstorePackage]], 'already the newest: a no-op');

  // A newer version that is not inert is refused, and the site is exactly as it was.
  const snapshot = async (): Promise<string[]> => [await readFile(join(dir, 'package.json'), 'utf8'), await readFile(join(dir, 'package-lock.json'), 'utf8'), await readFile(join(dir, ADDON_FILES_LOCK), 'utf8'), JSON.stringify((await readdir(installedPetstore(dir), { recursive: true })).sort())];
  const before = await snapshot();
  await publish('1.4.2', async pkgDir => { await writeFile(join(pkgDir, 'index.js'), 'export default 1;\n'); });
  await assert.rejects(addAddons(dir, 'artifact', [`${petstorePackage}@1.4.2`], { manifest }), /Refusing @example\/urlcode-petstore-docs: Artifact petstore-docs contains index\.js, which is not declarative data/);
  assert.deepEqual(await snapshot(), before, 'package.json, both locks and node_modules are restored');
  // A version that provides another name is refused rather than silently renaming the installed one.
  await publish('1.4.3', async pkgDir => { const file = join(pkgDir, 'urlcode.json'); await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')) as object, name: 'pet-docs' })); });
  await assert.rejects(addAddons(dir, 'artifact', [`${petstorePackage}@1.4.3`], { manifest }), /the installed version provides the artifact petstore-docs, but the new one provides the artifact pet-docs; remove petstore-docs first/);
  assert.deepEqual(await snapshot(), before);
  // A lock moved by hand, outside `artifacts add`, is stale until it goes through add.
  const lockFile = join(dir, 'package-lock.json'), lock = JSON.parse(before[1]!) as { packages: Record<string, { version: string }> };
  lock.packages[`node_modules/${petstorePackage}`]!.version = '1.4.9';
  await writeFile(lockFile, JSON.stringify(lock));
  assert.match((await listAddons(dir, 'artifact', { manifest })).problems.join('\n'), /package-lock\.json locks @example\/urlcode-petstore-docs 1\.4\.9 .* but addon-files\.lock\.json recorded 1\.4\.1 .*changed outside `urlcode artifacts add`/);
  await writeFile(lockFile, before[1]!);
});

test('re-running extensions add upgrades an independent extension without touching its declaration, and refuses a version that rejects it', async t => {
  const dir = await site(t), packages = await temp(t, 'urlcode-tarballs-');
  const first = await tarball(t, packages, 'greeting', '2.3.4');
  await addAddons(dir, 'extension', [first], { manifest });
  const project = { yaml: await readFile(join(dir, 'app', 'urlcode.yaml'), 'utf8'), host: await readFile(join(dir, 'host.mjs'), 'utf8'), routes: await readFile(join(dir, 'app', 'routes', 'greeting.yaml'), 'utf8') };
  const read = async (): Promise<typeof project> => ({ yaml: await readFile(join(dir, 'app', 'urlcode.yaml'), 'utf8'), host: await readFile(join(dir, 'host.mjs'), 'utf8'), routes: await readFile(join(dir, 'app', 'routes', 'greeting.yaml'), 'utf8') });

  const next = await tarball(t, packages, 'greeting', '2.3.5');
  const upgraded = await addAddons(dir, 'extension', [next], { manifest });
  assert.deepEqual([upgraded.added, upgraded.upgraded, upgraded.projectSha256], [[], [{ name: 'greeting', package: '@example/urlcode-greeting', from: '2.3.4', to: '2.3.5' }], undefined]);
  assert.deepEqual(await read(), project, 'the declaration, routes and host.mjs line are unchanged');
  assert.equal((await readFilesLock(dir)).packages['@example/urlcode-greeting']!.version, '2.3.5');
  assert.deepEqual((await listAddons(dir, 'extension', { manifest })).problems, []);
  await assert.rejects(addAddons(dir, 'extension', [await tarball(t, packages, 'greeting', '2.3.5b')], { manifest, example: true }), /--example has no effect: no extension is being added/);

  // 2.3.6 requires `text` to be a number: the project's `text: hi` no longer validates, so the upgrade is refused.
  const before = [await readFile(join(dir, 'package.json'), 'utf8'), await readFile(join(dir, 'package-lock.json'), 'utf8'), await readFile(join(dir, ADDON_FILES_LOCK), 'utf8')];
  const stricter = await tarball(t, packages, 'greeting', '2.3.6', async pkgDir => {
    const file = join(pkgDir, 'urlcode.json'), descriptor = JSON.parse(await readFile(file, 'utf8')) as { schema: { properties: { text: { type: string } } } };
    descriptor.schema.properties.text.type = 'number';
    await writeFile(file, JSON.stringify(descriptor));
  });
  await assert.rejects(addAddons(dir, 'extension', [stricter], { manifest }), /Refusing @example\/urlcode-greeting: the new version does not accept the project's declaration: extensions\.greeting\.config: data\/text must be number/);
  assert.deepEqual([await readFile(join(dir, 'package.json'), 'utf8'), await readFile(join(dir, 'package-lock.json'), 'utf8'), await readFile(join(dir, ADDON_FILES_LOCK), 'utf8')], before);
  assert.deepEqual(await read(), project);
  assert.equal((JSON.parse(await readFile(join(dir, 'node_modules', '@example', 'urlcode-greeting', 'package.json'), 'utf8')) as { version: string }).version, '2.3.5', 'node_modules is back at the installed version');
  await loadDocument(join(dir, 'app'));
});

test('outdated compares each independent package with the newest version its recorded spec resolves to, and says when it cannot ask', async t => {
  const dir = await site(t), registry = await registryFor(t, dir), packages = await temp(t, 'urlcode-tarballs-');
  const file = await tarball(t, registry, 'petstore-docs', '1.4.0');
  const { rename } = await import('node:fs/promises');
  await rename(file, join(registry, `${petstorePackage.replace('/', '+')}@1.4.0.tgz`));
  env(t, { FAKE_NPM_REGISTRY: registry });
  await addAddons(dir, 'artifact', [`${petstorePackage}@1.4.0`], { manifest });
  await addAddons(dir, 'extension', [await tarball(t, packages, 'greeting', '2.3.4')], { manifest });

  env(t, { FAKE_NPM_VIEW: JSON.stringify(['1.4.0', '1.10.0', '1.9.1']) });
  const report = await outdatedAddons(dir, 'artifact', { manifest });
  assert.deepEqual(report.addons, [{ name: 'petstore-docs', package: petstorePackage, locked: '1.4.0', spec: `${petstorePackage}@1.4.0`, latest: '1.10.0', status: 'outdated', upgrade: `urlcode artifacts add ${petstorePackage}@1.4.0` }]);
  assert.match(report.note, /never moves an independent package/);
  const out = printer();
  assert.equal(await runAddonCommand('artifacts', 'outdated', [], { site: dir }, out.print), undefined);
  assert.match(String(out.printed[0]), /asked the npm registry: a network operation/);
  assert.match(String(out.printed[0]), /1\.10\.0 available; upgrade with: urlcode artifacts add/);
  env(t, { FAKE_NPM_VIEW: JSON.stringify('1.4.0') });
  assert.equal((await outdatedAddons(dir, 'artifact', { manifest })).addons[0]!.status, 'current');
  env(t, { FAKE_NPM_FAIL: 'view' });
  const offline = (await outdatedAddons(dir, 'artifact', { manifest })).addons[0]!;
  assert.deepEqual([offline.status, offline.latest], ['unknown', null]);
  assert.match(offline.message ?? '', /could not ask the registry \(offline, or the spec does not resolve\)/);
  const extension = (await outdatedAddons(dir, 'extension', { manifest })).addons;
  assert.deepEqual(extension.map(item => [item.name, item.status, item.message]), [['greeting', 'not-registry', 'added from a path, URL or git spec: there is no registry version to compare']]);
  assert.ok((await stat(join(dir, ADDON_FILES_LOCK))).isFile());
});

test('naming an installed but unrecorded package to add again records its files, released or independent', async t => {
  const dir = await site(t), packages = await temp(t, 'urlcode-tarballs-');
  const file = await tarball(t, packages, 'petstore-docs', '1.4.0');
  await addAddons(dir, 'artifact', [file, 'notes'], { manifest });
  const recorded = await readFilesLock(dir);
  await rm(join(dir, ADDON_FILES_LOCK));
  assert.match((await listAddons(dir, 'artifact', { manifest })).problems.join('\n'), /has no entry in addon-files\.lock\.json/);
  const again = await addAddons(dir, 'artifact', ['notes', file], { manifest });
  assert.deepEqual([again.added, again.upgraded], [[], []]);
  assert.deepEqual(await readFilesLock(dir), recorded);
  assert.deepEqual((await listAddons(dir, 'artifact', { manifest })).problems, []);
});

/** The files a refused add must leave exactly as they were. */
const siteFiles = async (dir: string): Promise<string[]> => Promise.all(['package.json', 'package-lock.json', ADDON_FILES_LOCK, 'host.mjs', join('app', 'urlcode.yaml')].map(file => readFile(join(dir, file), 'utf8').catch(() => '')));
/** Installs a tarball as plain npm would, outside `urlcode … add`: what an operator's own `npm install` leaves behind. */
async function npmInstall(dir: string, name: string, file: string): Promise<void> {
  const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies[name] = `file:${file}`;
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [process.env.URLCODE_NPM!, 'install', '--ignore-scripts'], { cwd: dir });
}

test('a package declares the URLCode extension contract it is built for: add, list --strict, validate and activation refuse any other by name (#844)', async t => {
  const dir = await site(t), packages = await temp(t, 'urlcode-tarballs-');
  // Compatible: the independent greeting package declares contract 2, the one this core implements.
  assert.deepEqual((await addAddons(dir, 'extension', [await tarball(t, packages, 'greeting', '2.3.4')], { manifest })).added, ['greeting']);
  const before = await siteFiles(dir);
  // Incompatible: beyond declares contract 3. Refused from its descriptor, before its entry is imported, and rolled back.
  const beyond = await tarball(t, packages, 'beyond', '3.0.0');
  await assert.rejects(addAddons(dir, 'extension', [beyond], { manifest }), /Refusing @example\/urlcode-beyond: @example\/urlcode-beyond@3\.0\.0 is built for URLCode extension contract 3, but this core implements extension contract 2; install a version of it built for contract 2, or a core that implements contract 3/);
  assert.deepEqual(await siteFiles(dir), before);
  // An artifact descriptor declares its contract too.
  const futureDocs = await tarball(t, packages, 'petstore-docs', '9.0.0', async pkgDir => { const file = join(pkgDir, 'urlcode.json'); await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')) as object, contract: 3 })); });
  await assert.rejects(addAddons(dir, 'artifact', [futureDocs], { manifest }), /Refusing @example\/urlcode-petstore-docs: @example\/urlcode-petstore-docs@9\.0\.0 is built for URLCode extension contract 3, but this core implements extension contract 2/);
  const noContract = await tarball(t, packages, 'greeting', '2.3.9', async pkgDir => { const file = join(pkgDir, 'urlcode.json'), { contract: _, ...rest } = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; await writeFile(file, JSON.stringify(rest)); });
  await assert.rejects(addAddons(dir, 'extension', [noContract], { manifest }), /carries no valid urlcode\.json extension descriptor \(.*contract must be the URLCode extension contract the package is built for, a positive integer \(this core implements 2\)\)/);
  assert.deepEqual(await siteFiles(dir), before);

  // Installed by plain npm, outside add, and declared by hand: list --strict, static validate and composeHost refuse it.
  await npmInstall(dir, '@example/urlcode-beyond', beyond);
  const yaml = join(dir, 'app', 'urlcode.yaml');
  await writeFile(yaml, (await readFile(yaml, 'utf8')).replace('extensions:\n', 'extensions:\n  beyond:\n    version: "1"\n    config: {}\n'));
  const report = await listAddons(dir, 'extension', { manifest });
  assert.deepEqual(report.problems.filter(problem => /contract/.test(problem)), ['beyond: @example/urlcode-beyond is built for URLCode extension contract 3, but this core implements extension contract 2; install a version of it built for contract 2, or a core that implements contract 3']);
  const strict = printer();
  assert.equal(await runAddonCommand('extensions', 'list', [], { site: dir, strict: true }, strict.print), 1);
  assert.match(String(strict.printed[0]), /Problem: beyond: @example\/urlcode-beyond is built for URLCode extension contract 3/);
  assert.deepEqual(await validateDeclaredExtensions(join(dir, 'app')), ['extensions.beyond: the installed package is built for URLCode extension contract 3, but this core implements extension contract 2; install a version of it built for contract 2, or a core that implements contract 3']);
  const entry = (await import(pathToFileURL(join(dir, 'node_modules', '@example', 'urlcode-beyond', 'extension.js')).href) as { default: () => ExtensionEntry }).default;
  await assert.rejects(composeHost(pathToFileURL(join(dir, 'host.mjs')), [entry()]), /Extension beyond is built for URLCode extension contract 3, but this core implements extension contract 2/);
});

test('a package that bundles its own @jimhoyd/urlcode is refused at add and reported by list --strict: one core per site (#844)', async t => {
  const dir = await site(t), packages = await temp(t, 'urlcode-tarballs-');
  const bundling = await tarball(t, packages, 'greeting', '2.4.0', async pkgDir => {
    await mkdir(join(pkgDir, 'node_modules', '@jimhoyd', 'urlcode'), { recursive: true });
    await writeFile(join(pkgDir, 'node_modules', '@jimhoyd', 'urlcode', 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode', version: '0.0.1' }));
    const file = join(pkgDir, 'package.json');
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')) as object, dependencies: { '@jimhoyd/urlcode': '0.0.1' }, bundleDependencies: ['@jimhoyd/urlcode'] }));
  });
  const before = await siteFiles(dir);
  await assert.rejects(addAddons(dir, 'extension', [bundling], { manifest }), /npm installed a nested copy of URLCode \(node_modules\/@example\/urlcode-greeting\/node_modules\/@jimhoyd\/urlcode\); core and every add-on must resolve once, at the top level of the site/);
  assert.deepEqual(await siteFiles(dir), before, 'the refused add is rolled back');
  await npmInstall(dir, '@example/urlcode-greeting', bundling);
  const strict = printer();
  assert.equal(await runAddonCommand('extensions', 'list', [], { site: dir, strict: true }, strict.print), 1);
  assert.match(String(strict.printed[0]), /Problem: nested copy node_modules\/@example\/urlcode-greeting\/node_modules\/@jimhoyd\/urlcode: core and every add-on must resolve once, at the top level/);
});
