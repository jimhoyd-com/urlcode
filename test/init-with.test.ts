import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadDocument } from '../packages/core/src/config.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import { initProjectWith, parseWithNames } from '../packages/core/src/init-with.ts';
import type { BundleTransport } from '../packages/core/src/extension-bundles.ts';
import { project } from './helpers.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
const coreVersion=(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
const run = (cwd: string, args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
const missing = async (path: string): Promise<boolean> => { try { await lstat(path); return false; } catch { return true; } };
interface FakeOptions { routes?: Record<string, unknown>; scaffold?: boolean; contract?: Record<string, string[]>; risk?: boolean }
interface FakeBundle { name: string; asset: string; entry: string; sha256: string; bytes: Buffer }
/** A fake signed bundle for `@jimhoyd/urlcode-<name>`, exporting `scaffold` and a runtime extension factory, modeling a reviewed release. */
function fakeBundle(name: string, { routes, scaffold = true, contract = {}, risk = false }: FakeOptions = {}): FakeBundle {
  const entry = `node_modules/@jimhoyd/urlcode-${name}/dist/index.js`;
  const manifest = { format: 1, coreVersion, bundles: [{ name, version: '1.0.0', entry }] };
  const fragment = JSON.stringify(routes ?? { [`/${name}/*`]: { extension: name, methods: ['GET', 'HEAD', 'POST'] } });
  const moduleSource = `const name=${JSON.stringify(name)};
export function ${name}Extension(projectSha256){return {name,version:'1',projectSha256,targets:['node'],schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},activate(){return {handle:()=>({status:200,headers:[],body:'hi'})};}};}
${scaffold ? `export async function scaffold(request){
  if(!request.names.includes(name))throw new Error('names must include '+name);
  const id=name+':risky';
  if(${risk}&&!request.acknowledgements.includes(id))throw Object.assign(new Error('this would do something risky'),{acknowledgement:id});
  return {name,...(${risk}?{acknowledged:[id]}:{}),extensions:{[name]:{version:'1',config:{label:'hello'}}},routes:${fragment},
    hostImports:[],hostBundleExports:['${name}Extension'],
    hostSetup:[\`const \${name}Sha = process.env.PROJECT_SHA256;\`],hostEntries:[\`${name}Extension(\${name}Sha)\`],hostClose:[\`// release ${name}\`],
    files:[{path:\`operator-${name}.mjs\`,content:'export default 1;\\n',mode:0o600},{path:\`data/${name}.key\`,content:new Uint8Array([1,2,3]),mode:0o600},{path:\`notes/${name}.txt\`,content:'public note'}],
    readme:\`Readme for ${name}.\`,...${JSON.stringify(contract)},nextSteps:[\`step one for ${name}\`,\`step two for ${name}\`],env:{PROJECT_SHA256:'Reviewed revision.'}};
}` : ''}
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
  return { name, asset: `${name}-1.0.0.tgz`, entry, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}
/** A `BundleTransport` serving exactly the given fake bundles under one release tag. */
function fakeBundleTransport(bundles: FakeBundle[], tag = `extension-bundles@v${coreVersion}`): { release: string; transport: BundleTransport } {
  const catalog = Buffer.from(JSON.stringify({ format: 1, tag, commit: 'a'.repeat(40), coreVersion, bundles: bundles.map(b => ({ name: b.name, version: '1.0.0', asset: b.asset, sha256: b.sha256, entry: b.entry })), revoked: [] }));
  const transport: BundleTransport = {
    release: async () => [{ name: 'extension-bundles-catalog.json', url: 'catalog' }, ...bundles.map(b => ({ name: b.asset, url: b.asset }))],
    download: async url => url === 'catalog' ? catalog : bundles.find(b => b.asset === url)!.bytes,
    attest: async () => {},
  };
  return { release: tag, transport };
}

test('init --with merges fake extension scaffolds in canonical order, keeps file modes and the result validates with the generated host', async t => {
  const root = await project(t, {});
  const { release, transport } = fakeBundleTransport([fakeBundle('demo'), fakeBundle('other')]);
  const created = await initProjectWith(join(root, 'site'), ['other', 'demo'], { cwd: root, bundleRelease: release, bundleTransport: transport });
  assert.deepEqual(created.extensions, ['demo', 'other']);
  const site = join(root, 'site'), app = join(site, 'app');
  // The CLI resolves against its cwd, which macOS reports through /private and Windows may report as a short name; compare canonical paths.
  const canonical = (path: string) => realpathSync.native(path);
  assert.equal(canonical(created.project), canonical(app)); assert.equal(canonical(created.hostFile), canonical(join(site, 'host.mjs')));
  const sha = await inspectExtensionRevision(app);
  assert.equal(created.projectSha256, sha);
  const loaded = await loadDocument(app);
  assert.deepEqual(Object.keys(loaded.routes), ['/demo/*', '/other/*']);
  assert.deepEqual(Object.keys(loaded.document.extensions ?? {}), ['demo', 'other']);
  const host = await readFile(join(site, 'host.mjs'), 'utf8');
  const order = ["const {demoExtension} = await loadExtensionBundle(extensionBundleDirectory, 'demo');", "const {otherExtension} = await loadExtensionBundle(extensionBundleDirectory, 'other');", 'const demoSha', 'const otherSha', 'demoExtension(demoSha),', 'otherExtension(otherSha),', '// release other', '// release demo'].map(needle => host.indexOf(needle));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1]!)), host);
  // Windows has no POSIX modes; the files still exist there.
  for (const [file, mode] of [['operator-demo.mjs', 0o600], ['data/other.key', 0o600], ['notes/demo.txt', 0o644], ['host.mjs', 0o600]] as const) { const info = await stat(join(site, file)); if (process.platform !== 'win32') assert.equal(info.mode & 0o777, mode, file); }
  assert.deepEqual([...await readFile(join(site, 'data/demo.key'))], [1, 2, 3]);
  const readme = await readFile(join(site, 'README.md'), 'utf8');
  for (const needle of ['## Starter', '## Your URLCode project', '## Extension: demo', 'Readme for demo.', '## Extension: other', '1. Review ', '2. Run `npm install`', '3. step one for demo', '5. step one for other', '- `PROJECT_SHA256`: Reviewed revision.', sha]) assert.ok(readme.includes(needle), needle);
  assert.ok(readme.indexOf('## Extension: demo') < readme.indexOf('## Extension: other'));
  assert.ok(await missing(join(app, 'README.md')));
  // One .mcp.json at the site root, pointing the read-only server at app/; the app copy moves up with it.
  assert.ok(await missing(join(app, '.mcp.json')));
  assert.deepEqual(JSON.parse(await readFile(join(site, '.mcp.json'), 'utf8')), { mcpServers: { urlcode: { command: 'npx', args: ['--no', '--package', '@jimhoyd/urlcode', 'urlcode', 'mcp', '--project', 'app'] } } });
  assert.ok((await readFile(join(app, '.gitignore'), 'utf8')).includes('.env.*'));
  // Bundle distribution pins only the runtime; extensions are locked in urlcode.extension-bundles.lock.json, not npm dependencies.
  assert.deepEqual(JSON.parse(await readFile(join(site, 'package.json'), 'utf8')).dependencies, { '@jimhoyd/urlcode': coreVersion });
  assert.ok(await missing(join(site, 'package-lock.json')));
  assert.ok(!(await missing(join(site, 'urlcode.extension-bundles.lock.json'))));
  // Nothing generated is ever overwritten: the destination is reserved once.
  await assert.rejects(initProjectWith(join(root, 'site'), ['demo'], { cwd: root, bundleRelease: release, bundleTransport: transport }));
  assert.equal(await readFile(join(site, 'host.mjs'), 'utf8'), host);
});
test('init --with refuses duplicate extension routes, missing packages and packages without scaffold before writing anything', async t => {
  const root = await project(t, {});
  // Argument validation happens before any bundle is installed, so these refuse without a fixture and without touching the network.
  const cases: [string, RegExp][] = [
    ['demo,demo', /Duplicate --with names/], ['Demo', /--with name/], ['', /--with name/],
    // Names are checked against the bundles this core release builds before any release fetch (#579).
    ['auth,auht', /Unknown extension bundle auht; did you mean auth\? Known bundles: ui, ui-presentation, auth, admin, store, forms/], ['zzz', /Unknown extension bundle zzz\. Known bundles:/],
  ];
  for (const [names, message] of cases) {
    const result = run(root, ['init', 'site', '--with', names]);
    assert.equal(result.status, 1, names); assert.match(result.stderr, message);
    assert.ok(await missing(join(root, 'site')), `${names} left files behind`);
  }
  assert.match(run(root, ['validate', '--with', 'demo']).stderr, /--with is only supported by init/);
  // These need an actual (fake) bundle install to reach the refusal, so they run through the JS API with an injected transport.
  const { release, transport } = fakeBundleTransport([fakeBundle('demo'), fakeBundle('twin', { routes: { '/demo/*': { extension: 'twin' } } }), fakeBundle('plain', { scaffold: false })]);
  await assert.rejects(initProjectWith(join(root, 'site'), ['demo', 'twin'], { cwd: root, bundleRelease: release, bundleTransport: transport }), /Route \/demo\/\* is added by both demo and twin/);
  assert.ok(await missing(join(root, 'site')));
  await assert.rejects(initProjectWith(join(root, 'site'), ['demo', 'missing'], { cwd: root, bundleRelease: release, bundleTransport: transport }), /Extension bundle missing is not in the signed catalog/);
  assert.ok(await missing(join(root, 'site')));
  await assert.rejects(initProjectWith(join(root, 'site'), ['plain'], { cwd: root, bundleRelease: release, bundleTransport: transport }), /@jimhoyd\/urlcode-plain does not export scaffold/);
  assert.ok(await missing(join(root, 'site')));
  assert.deepEqual(parseWithNames(' auth , admin'), ['auth', 'admin']);
});

test('init --with resolves the core-matching bundle release when --bundle-release is omitted, and refuses when it does not exist', async t => {
  const root = await project(t, {});
  const bundle = fakeBundle('demo'), { transport } = fakeBundleTransport([bundle]);
  // With no --bundle-release, initProjectWith selects the immutable catalog for this core version.
  let requested: string | undefined;
  const capturing: BundleTransport = { release: async tag => { requested = tag; return transport.release(tag); }, download: transport.download, attest: transport.attest };
  const created = await initProjectWith(join(root, 'site'), ['demo'], { cwd: root, bundleTransport: capturing });
  assert.equal(requested, `extension-bundles@v${coreVersion}`);
  assert.deepEqual(created.extensions, ['demo']);
  const missingTransport: BundleTransport = { release: async () => { throw new Error('Could not fetch extension bundle release'); }, download: async () => { throw new Error('unused'); }, attest: async () => {} };
  await assert.rejects(initProjectWith(join(root, 'other'), ['demo'], { cwd: root, bundleTransport: missingTransport }), /Could not fetch extension bundle release/);
});

test('init --with carries generic --ack acknowledgements: refusal prints the exact command, unconsumed values are rejected, nothing is written on refusal', async t => {
  const root = await project(t, {});
  const { release, transport } = fakeBundleTransport([fakeBundle('risky', { risk: true }), fakeBundle('calm')]);
  const opts = { cwd: root, bundleRelease: release, bundleTransport: transport, manifest: false };
  // Windows wraps the destination in single quotes (quote() treats backslash as unsafe), so a trailing quote may sit before the flag.
  await assert.rejects(initProjectWith(join(root, 'site'), ['calm', 'risky'], opts), /this would do something risky\. If you accept that risk, re-run with the acknowledgement: urlcode init .*site'? --with calm,risky --bundle-release extension-bundles@v[^ ]+ --no-manifest --ack risky:risky/);
  assert.ok(await missing(join(root, 'site')));
  // An acknowledgement for another extension does not satisfy it, and the refusal keeps what was already passed.
  await assert.rejects(initProjectWith(join(root, 'site'), ['calm', 'risky'], { ...opts, acknowledgements: ['calm:other'] }), /--bundle-release extension-bundles@v[^ ]+ --no-manifest --ack calm:other --ack risky:risky/);
  const ok = await initProjectWith(join(root, 'site'), ['risky'], { ...opts, acknowledgements: ['risky:risky', 'risky:risky'] });
  assert.deepEqual(ok.extensions, ['risky']);
  const unused = ['calm:risky', 'risky:other', 'ghost:thing'];
  for (const [index, id] of unused.entries()) {
    const destination = join(root, `u${index}`);
    await assert.rejects(initProjectWith(destination, ['calm', 'risky'], { ...opts, acknowledgements: ['risky:risky', id] }), new RegExp(`--ack ${id.replace(':', '\\:')} has no effect`));
    assert.ok(await missing(destination), id);
  }
  await assert.rejects(initProjectWith(join(root, 'bad'), ['calm'], { ...opts, acknowledgements: ['nocolon'] }), /Use --ack <extension>:<id>/);
  assert.match(run(root, ['init', 'bad', '--ack', 'calm:x']).stderr, /--ack is only supported by init with --with/);
  assert.match(run(root, ['validate', '--ack', 'calm:x']).stderr, /--ack is only supported by init with --with/);
});

const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
const siteFiles = async (root: string, name: string): Promise<{ yaml: string; routes: string; host: string; sha: string }> => {
  const site = join(root, name), app = join(site, 'app');
  return { yaml: await readFile(join(app, 'urlcode.yaml'), 'utf8'), routes: await readFile(join(app, 'routes/extensions.yaml'), 'utf8'), host: (await readFile(join(site, 'host.mjs'), 'utf8')).replace(/^\/\/ Generated by.*\n/, ''), sha: await inspectExtensionRevision(app) };
};
test('init --with treats the set as unordered: every permutation emits the same order, host and revision', async t => {
  const root = await project(t, {});
  const { release, transport } = fakeBundleTransport([
    fakeBundle('ui', { contract: { provides: ['ui.kit'] } }),
    fakeBundle('auth', { contract: { requires: ['ui.kit'], provides: ['auth.service'] } }),
    fakeBundle('admin', { contract: { requires: ['ui.kit', 'auth.service'] } }),
  ]);
  let index = 0, baseline: Record<string, string> | undefined;
  for (const order of permutations(['admin', 'auth', 'ui'])) {
    const name = `site${index++}`, created = await initProjectWith(join(root, name), order, { cwd: root, manifest: false, bundleRelease: release, bundleTransport: transport });
    assert.deepEqual(created.extensions, ['ui', 'auth', 'admin']);
    const files = await siteFiles(root, name);
    assert.equal(files.sha, created.projectSha256);
    assert.deepEqual(Object.keys((await loadDocument(join(root, name, 'app'))).document.extensions ?? {}), ['ui', 'auth', 'admin']);
    const host = files.host, at = ['uiExtension(', 'authExtension(', 'adminExtension('].map(needle => host.indexOf(needle));
    assert.ok(at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!)), host);
    baseline ??= files as unknown as Record<string, string>; assert.deepEqual(files, baseline, order.join(','));
  }
  assert.equal(index, 6);
});
test('init --with refuses a missing requirement, a conflict or a cycle before writing, naming the extensions', async t => {
  const root = await project(t, {});
  const { release, transport } = fakeBundleTransport([
    fakeBundle('ui', { contract: { provides: ['ui.kit'] } }),
    fakeBundle('needy', { contract: { requires: ['ui.kit', 'auth'] } }),
    fakeBundle('clash', { contract: { conflicts: ['ui'] } }),
    fakeBundle('loopa', { contract: { requires: ['loopb'] } }), fakeBundle('loopb', { contract: { after: ['loopa'] } }),
  ]);
  const opts = { cwd: root, manifest: false, bundleRelease: release, bundleTransport: transport };
  for (const [names, expected] of [[['needy'], /needy requires ui\.kit/], [['needy', 'ui'], /needy requires auth/], [['ui', 'clash'], /clash conflicts with ui/], [['loopb', 'loopa', 'ui'], /cycle among loopa \(needs loopb\); loopb \(needs loopa\)/]] as const) {
    const destination = join(root, 'refused');
    await assert.rejects(initProjectWith(destination, names, opts), expected);
    assert.ok(await missing(destination), names.join(','));
  }
  assert.doesNotMatch(await initProjectWith(join(root, 'ok'), ['ui'], opts).then(() => '', error => String(error)), /./);
});

/** A fake `gh` on PATH that accepts any `attestation verify` invocation (used to satisfy the local transport's `--bundle` call without a real signed release). */
async function fakeGh(bin: string): Promise<() => void> {
  await writeFile(join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const path = process.env.PATH; process.env.PATH = `${bin}:${path ?? ''}`;
  return () => { process.env.PATH = path; };
}
/** A local release directory (catalog + tarballs + `sha256-<digest>.jsonl` attestation bundles) for the given fake bundles under one release tag, in the shape `--bundle-release-path` expects. */
async function localBundleRelease(dir: string, bundles: FakeBundle[], tag = `extension-bundles@v${coreVersion}`): Promise<string> {
  const catalog = Buffer.from(JSON.stringify({ format: 1, tag, commit: 'a'.repeat(40), coreVersion, bundles: bundles.map(b => ({ name: b.name, version: '1.0.0', asset: b.asset, sha256: b.sha256, entry: b.entry })), revoked: [] }));
  await writeFile(join(dir, 'extension-bundles-catalog.json'), catalog);
  await writeFile(join(dir, `sha256-${createHash('sha256').update(catalog).digest('hex')}.jsonl`), '{"fake":"catalog"}\n');
  for (const bundle of bundles) {
    await writeFile(join(dir, bundle.asset), bundle.bytes);
    await writeFile(join(dir, `sha256-${bundle.sha256}.jsonl`), '{"fake":"asset"}\n');
  }
  return tag;
}

test('init --with --bundle-release-path installs an explicitly selected local signed release with no bundleTransport injected, and fails closed on a tampered asset (#533)', async t => {
  const root = await project(t, {});
  const releaseDir = await mkdtemp(join(tmpdir(), 'urlcode-local-release-'));
  const bin = await mkdtemp(join(tmpdir(), 'urlcode-fake-gh-'));
  t.after(async () => { await Promise.all([rm(releaseDir, { recursive: true, force: true }), rm(bin, { recursive: true, force: true })]); });
  const restore = await fakeGh(bin); t.after(restore);
  const bundle = fakeBundle('demo');
  const release=await localBundleRelease(releaseDir, [bundle]);
  const originalFetch = globalThis.fetch; globalThis.fetch = (async () => { throw new Error('network must not be reached'); }) as typeof fetch; t.after(() => { globalThis.fetch = originalFetch; });
  // No bundleTransport option here: initProjectWith builds the local transport itself from bundleReleasePath.
  const created = await initProjectWith(join(root, 'site'), ['demo'], { cwd: root, manifest: false, bundleRelease: release, bundleReleasePath: releaseDir });
  assert.deepEqual(created.extensions, ['demo']);
  // Tamper the release directory's tarball after a successful install: a second install into a fresh destination
  // must refuse rather than accept altered bytes. The tampered content's digest no longer matches the attestation
  // bundle produced for the original asset, so this is refused as a missing offline attestation bundle -- an even
  // stricter fail-closed than a signature mismatch on the original bytes would have been.
  await writeFile(join(releaseDir, bundle.asset), Buffer.from('not a real bundle'));
  await assert.rejects(initProjectWith(join(root, 'site2'), ['demo'], { cwd: root, manifest: false, bundleRelease: release, bundleReleasePath: releaseDir }), /missing the offline attestation bundle|does not match its signed SHA-256|Could not download|Invalid/);
  assert.ok(await missing(join(root, 'site2')));
});

test('init --with --bundle-release-path and an injected bundleTransport are mutually exclusive, and CLI validation restricts the flag to extension-bundles/init --with (#533)', async t => {
  const root = await project(t, {});
  const { release, transport } = fakeBundleTransport([fakeBundle('demo')]);
  await assert.rejects(initProjectWith(join(root, 'site'), ['demo'], { cwd: root, bundleRelease: release, bundleTransport: transport, bundleReleasePath: '/tmp/unused' }), /mutually exclusive/);
  await assert.rejects(initProjectWith(join(root, 'offline'), ['demo'], { cwd: root, bundleReleasePath: '/tmp/release' }), /--bundle-release-path needs --bundle-release/);
  assert.match(run(root, ['validate', '--bundle-release-path', '/tmp/x']).stderr, /--bundle-release-path is only supported by extension-bundles or init --with/);
  assert.match(run(root, ['init', 'bad', '--bundle-release-path', '/tmp/x']).stderr, /--bundle-release-path needs init --with/);
});
