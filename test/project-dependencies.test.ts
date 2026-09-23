import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { collectDependencySet, installSteps, parsePin, renderPackageManifest, satisfiesRange } from '../packages/core/src/project-dependencies.ts';
import { initProjectWith } from '../packages/core/src/init-with.ts';
import type { BundleTransport } from '../packages/core/src/extension-bundles.ts';
import { project } from './helpers.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
const run = (cwd: string, args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60000 });
const parse = (out: string): Record<string, unknown> => JSON.parse(out.trim().split('\n').pop()!) as Record<string, unknown>;
const missing = async (path: string): Promise<boolean> => { try { await lstat(path); return false; } catch { return true; } };
const core = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** A fake signed bundle for `@jimhoyd/urlcode-<name>`, pinned to an arbitrary coreVersion (for compatibility tests). */
function fakeBundle(name: string, coreVersion: string): { name: string; asset: string; entry: string; sha256: string; bytes: Buffer } {
  const entry = `node_modules/@jimhoyd/urlcode-${name}/dist/index.js`;
  const manifest = { format: 1, coreVersion, bundles: [{ name, version: '2.0.1', entry }] };
  const moduleSource = `const name=${JSON.stringify(name)};
export function ${name}Extension(){return {name,version:'1',targets:['node'],schema:{type:'object'},activate(){return {handle:()=>({status:200,headers:[],body:'ok'})}}};}
export async function scaffold(){return {name,extensions:{[name]:{version:'1',config:{}}},routes:{[\`/\${name}/*\`]:{extension:name,methods:['GET','HEAD']}},
  hostImports:[],hostBundleExports:['${name}Extension'],hostSetup:[],hostEntries:[\`${name}Extension()\`],files:[],readme:'Readme.',nextSteps:['do the thing']};}
`;
  const files: { path: string; body: string }[] = [
    { path: 'bundle.json', body: JSON.stringify(manifest) },
    { path: `node_modules/@jimhoyd/urlcode-${name}/package.json`, body: JSON.stringify({ type: 'module' }) },
    { path: entry, body: moduleSource },
  ];
  const parts: Buffer[] = [];
  for (const file of files) {
    const body = Buffer.from(file.body), header = Buffer.alloc(512);
    header.write(file.path); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    header[156] = 48; header.fill(32, 148, 156);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const bytes = gzipSync(Buffer.concat(parts));
  return { name, asset: `${name}-2.0.1.tgz`, entry, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}
function fakeBundleTransport(bundles: ReturnType<typeof fakeBundle>[], tag: string, coreVersion: string): BundleTransport {
  const catalog = Buffer.from(JSON.stringify({ format: 1, tag, commit: 'a'.repeat(40), coreVersion, bundles: bundles.map(b => ({ name: b.name, version: '2.0.1', asset: b.asset, sha256: b.sha256, entry: b.entry })), revoked: [] }));
  return {
    release: async () => [{ name: 'extension-bundles-catalog.json', url: 'catalog' }, ...bundles.map(b => ({ name: b.asset, url: b.asset }))],
    download: async url => url === 'catalog' ? catalog : bundles.find(b => b.asset === url)!.bytes,
    attest: async () => {},
  };
}

interface PackageOptions { version?: string; peers?: Record<string, string>; optionalPeers?: string[]; node?: string; scaffold?: boolean }
/** A fake installed `@jimhoyd/urlcode-<name>`: manifest metadata plus the `scaffold` export `init --with` calls. */
async function fakePackage(root: string, name: string, { version = '1.2.3', peers, optionalPeers, node, scaffold = true }: PackageOptions = {}): Promise<void> {
  const dir = join(root, 'node_modules', '@jimhoyd', `urlcode-${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `@jimhoyd/urlcode-${name}`, version, type: 'module', exports: './index.mjs',
    ...(peers ? { peerDependencies: peers } : {}),
    ...(optionalPeers ? { peerDependenciesMeta: Object.fromEntries(optionalPeers.map(peer => [peer, { optional: true }])) } : {}),
    ...(node ? { engines: { node } } : {}),
  }));
  await writeFile(join(dir, 'index.mjs'), scaffold ? `const name=${JSON.stringify(name)};
export async function scaffold(){return {name,extensions:{[name]:{version:'1',config:{}}},routes:{[\`/\${name}/*\`]:{extension:name,methods:['GET','HEAD']}},
  hostImports:[],hostSetup:[],hostEntries:[\`${name}Extension()\`],files:[],readme:'Readme.',nextSteps:['do the thing']};}\n` : '');
}
/** A plain (non-extension) installed package, used for a peer that is not an extension of its own. */
async function fakeLibrary(root: string, name: string, version: string, peers?: Record<string, string>): Promise<void> {
  const dir = join(root, 'node_modules', ...name.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, ...(peers ? { peerDependencies: peers } : {}) }));
}

// A version may carry prerelease/build punctuation, so escape every RegExp
// metacharacter rather than only dots (CodeQL js/incomplete-sanitization).
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('range satisfaction follows npm prerelease rules and refuses syntax it does not implement', () => {
  // The shipped peer ranges: a prerelease runtime must satisfy the range that names its own prerelease floor.
  assert.ok(satisfiesRange('0.4.0-alpha.2', '>=0.4.0-alpha.2 <0.5.0'));
  assert.ok(satisfiesRange('0.4.0', '>=0.4.0-alpha.2 <0.5.0'));
  assert.ok(!satisfiesRange('0.4.0-alpha.1', '>=0.4.0-alpha.2 <0.5.0'));
  // A prerelease of the excluded upper bound must not slip through.
  assert.ok(!satisfiesRange('0.5.0-alpha.1', '>=0.4.0-alpha.2 <0.5.0'));
  assert.ok(!satisfiesRange('0.5.0', '>=0.4.0-alpha.2 <0.5.0'));
  assert.ok(satisfiesRange('1.2.3', '*') && satisfiesRange('1.2.3', '1.2.3') && !satisfiesRange('1.2.4', '1.2.3'));
  assert.ok(satisfiesRange('1.3.0', '^1.2.0') && !satisfiesRange('2.0.0', '^1.2.0'));
  assert.ok(satisfiesRange('0.1.9', '^0.1.0') && !satisfiesRange('0.2.0', '^0.1.0'));
  assert.ok(satisfiesRange('1.2.9', '~1.2.0') && !satisfiesRange('1.3.0', '~1.2.0'));
  assert.ok(satisfiesRange('2.0.0', '^1.0.0 || ^2.0.0'));
  for (const range of ['1.2', 'latest', '>=1.x', 'workspace:*']) assert.throws(() => satisfiesRange('1.2.3', range), /Unsupported version range/, range);
  assert.deepEqual(parsePin('@jimhoyd/urlcode-auth=file:/tmp/auth.tgz'), ['@jimhoyd/urlcode-auth', 'file:/tmp/auth.tgz']);
  assert.throws(() => parsePin('@jimhoyd/urlcode-auth'), /--pin <package>=<specifier>/);
});

test('the dependency set pins core, the named extensions and their declared peers exactly', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'demo', { version: '2.0.1', peers: { '@jimhoyd/urlcode': `>=${core.version} <9.0.0`, 'shared-lib': '^1.0.0', 'absent-optional': '^3.0.0' }, optionalPeers: ['absent-optional'], node: '>=22.18.0' });
  await fakeLibrary(root, 'shared-lib', '1.4.0');
  const set = await collectDependencySet(['demo'], ['@jimhoyd/urlcode-demo'], { cwd: root });
  assert.deepEqual(set.dependencies, { '@jimhoyd/urlcode': core.version, '@jimhoyd/urlcode-demo': '2.0.1', 'shared-lib': '1.4.0' });
  assert.deepEqual(set.pins.map(pin => pin.role), ['runtime', 'extension', 'peer']);
  assert.equal(set.local, false);
  // engines floors are merged by taking the highest recognized `>=x.y.z`.
  assert.equal(set.node, '>=22.18.0');
  const manifest = JSON.parse(renderPackageManifest('/sites/My Site', set)) as Record<string, unknown>;
  assert.equal(manifest.name, 'my-site'); assert.equal(manifest.private, true); assert.equal(manifest.type, 'module');
  assert.deepEqual(manifest.engines, { node: '>=22.18.0' });
  assert.deepEqual(manifest.dependencies, set.dependencies);
  assert.match(installSteps('/sites/my-site', set).join('\n'), /npm install.*never runs a package manager for you/s);
});

test('an incompatible or incompletely installed set refuses instead of recording pins', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'demo', { version: '2.0.1', peers: { '@jimhoyd/urlcode': '>=9.0.0 <10.0.0' } });
  await assert.rejects(collectDependencySet(['demo'], ['@jimhoyd/urlcode-demo'], { cwd: root }),
    new RegExp(`Incompatible versions: @jimhoyd/urlcode-demo 2\\.0\\.1 requires @jimhoyd/urlcode >=9\\.0\\.0 <10\\.0\\.0, but ${escapeRegExp(core.version)} is installed`));
  const other = await project(t, {});
  await fakePackage(other, 'demo', { peers: { 'shared-lib': '^1.0.0' } });
  await assert.rejects(collectDependencySet(['demo'], ['@jimhoyd/urlcode-demo'], { cwd: other }),
    /Cannot record exact pins: shared-lib \(required by @jimhoyd\/urlcode-demo \^1\.0\.0\) is not installed/);
  await assert.rejects(collectDependencySet([], [], { cwd: other, overrides: new Map([['nothing-here', 'file:/tmp/x.tgz']]) }),
    /--pin nothing-here names a package that is not part of this project's dependency set/);
});

test('local checkouts and tarballs are pinned by specifier, explicitly and from the hidden lockfile', async t => {
  const root = await project(t, {});
  await fakePackage(root, 'demo', { version: '2.0.1' });
  await fakeLibrary(root, 'shared-lib', '1.4.0');
  await fakePackage(root, 'linked', { version: '3.0.0', peers: { 'shared-lib': '^1.0.0' } });
  // npm records a linked workspace or local directory install here; its version is not installable from a registry.
  await writeFile(join(root, 'node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    'node_modules/@jimhoyd/urlcode-linked': { resolved: '../checkouts/linked', link: true },
    'node_modules/shared-lib': { version: '1.4.0', resolved: 'file:../tarballs/shared-lib-1.4.0.tgz' },
    'node_modules/@jimhoyd/urlcode-demo/node_modules/nested': { resolved: 'file:../nested.tgz' },
  } }));
  const set = await collectDependencySet(['demo', 'linked'], ['@jimhoyd/urlcode-demo', '@jimhoyd/urlcode-linked'],
    { cwd: root, overrides: new Map([['@jimhoyd/urlcode-demo', 'file:/absolute/urlcode-demo-2.0.1.tgz']]) });
  assert.equal(set.dependencies['@jimhoyd/urlcode-demo'], 'file:/absolute/urlcode-demo-2.0.1.tgz');
  assert.equal(set.dependencies['@jimhoyd/urlcode-linked'], `file:${join(root, '..', 'checkouts', 'linked')}`);
  assert.equal(set.dependencies['shared-lib'], `file:${join(root, '..', 'tarballs', 'shared-lib-1.4.0.tgz')}`);
  // The recorded version is still the resolved one; only the specifier changes.
  assert.equal(set.pins.find(pin => pin.name === '@jimhoyd/urlcode-demo')?.version, '2.0.1');
  assert.ok(set.local);
  assert.match(installSteps(root, set).join('\n'), /--offline/);
});

test('init writes a coordinated manifest for --with, on request for a route-only project, and never by surprise', async t => {
  const root = await project(t, {});
  const tag = `extension-bundles@v${core.version}`, transport = fakeBundleTransport([fakeBundle('demo', core.version)], tag, core.version);
  const created = await initProjectWith(join(root, 'site'), ['demo'], { cwd: root, bundleRelease: tag, bundleTransport: transport });
  assert.deepEqual(created.dependencies, [{ name: '@jimhoyd/urlcode', version: core.version, specifier: core.version, local: false, role: 'runtime' }]);
  const manifest = JSON.parse(await readFile(join(root, 'site', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.deepEqual(manifest.dependencies, { '@jimhoyd/urlcode': core.version });
  const readme = await readFile(join(root, 'site', 'README.md'), 'utf8');
  for (const needle of ['## Dependencies', 'urlcode.extension-bundles.lock.json', 'There is no upgrade command.', '1. Review']) assert.ok(readme.includes(needle), needle);
  // The install step is printed first and never run: no lockfile and no node_modules appear in the generated site.
  assert.match(String(created.nextSteps[1]), /Run `npm install`/);
  assert.ok(await missing(join(root, 'site', 'package-lock.json')) && await missing(join(root, 'site', 'node_modules')));

  // Route-only initialization keeps managing the runtime elsewhere: no manifest unless it is asked for.
  assert.equal(run(root, ['init', 'plain']).status, 0);
  assert.ok(await missing(join(root, 'plain', 'package.json')));
  const pinned = run(root, ['init', 'pinned', '--manifest']);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'pinned', 'package.json'), 'utf8')).dependencies, { '@jimhoyd/urlcode': core.version });
  assert.equal(parse(pinned.stdout).event, 'created');
  // --with without a manifest stays available for a site whose dependencies are managed elsewhere.
  const bare = await initProjectWith(join(root, 'bare'), ['demo'], { cwd: root, bundleRelease: tag, bundleTransport: transport, manifest: false });
  assert.deepEqual(bare.dependencies, []);
  assert.ok(await missing(join(root, 'bare', 'package.json')));
  assert.ok(!(await readFile(join(root, 'bare', 'README.md'), 'utf8')).includes('## Dependencies'));
  // Flag misuse refuses before anything is created.
  assert.match(run(root, ['init', 'x', '--manifest', '--no-manifest']).stderr, /Use either --manifest or --no-manifest/);
  assert.match(run(root, ['init', 'x', '--with', 'demo', '--no-manifest', '--pin', '@jimhoyd/urlcode=file:/tmp/core.tgz']).stderr, /--pin needs a manifest/);
  assert.match(run(root, ['validate', '--manifest']).stderr, /only supported by init/);
  assert.ok(await missing(join(root, 'x')));
});

test('init --with refuses to install a bundle whose catalog targets a different core version, leaving nothing behind', async t => {
  const root = await project(t, {});
  const tag = `extension-bundles@v${core.version}`, transport = fakeBundleTransport([fakeBundle('demo', '9.0.0')], tag, '9.0.0');
  await assert.rejects(initProjectWith(join(root, 'site'), ['demo'], { cwd: root, bundleRelease: tag, bundleTransport: transport }), /Extension bundle demo requires core 9\.0\.0; this runtime is/);
  assert.ok(await missing(join(root, 'site')));
});
