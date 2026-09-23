import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
// initProjectWith is --with's own CLI-internal implementation, not part of core's public exports (only
// ./extensions and ./extension-bundles are); import its source directly, matching how the CLI itself does.
import { initProjectWith } from '../../core/src/init-with.ts';
import type { BundleTransport } from '../../core/src/extension-bundles.ts';

// The scaffold unit tests call scaffold() directly, so they pass against any core. This drives the
// installed core's own `init --with store` (bundle distribution, the only mode --with supports), the
// way a user does, against a locally packed bundle built from this checkout's own compiled store --
// not a live GitHub release -- so it proves the contract without network. `release:peers` runs it
// against the published core at the declared peer floor, so a floor that lacks --ack (#346) fails
// here instead of after a release. Unlike ui/auth/admin, store has no dependencies of its own (its
// dist imports nothing from @jimhoyd/urlcode), so the packed bundle here is just its own dist tree --
// no npm pack/install staging needed, keeping this fixture cheap to build on every test run.
const storeDirectory = fileURLToPath(new URL('..', import.meta.url));
const coreDirectory = fileURLToPath(new URL('../../..', import.meta.url));
const coreVersion = (JSON.parse(await readFile(join(coreDirectory, 'package.json'), 'utf8')) as { version: string }).version;

async function walk(root: string, prefix = ''): Promise<{ path: string; bytes: Buffer }[]> {
  const found: { path: string; bytes: Buffer }[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...await walk(root, path));
    else if (entry.isFile()) found.push({ path, bytes: await readFile(join(root, path)) });
  }
  return found;
}
function tarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, 'utf8') <= 100) return { name: path, prefix: '' };
  const pieces = path.split('/'); let name = pieces.pop()!;
  while (pieces.length && Buffer.byteLength(name, 'utf8') <= 100) { const prefix = pieces.join('/'); if (Buffer.byteLength(prefix, 'utf8') <= 155) return { name, prefix }; name = `${pieces.pop()}/${name}`; }
  throw new Error(`Cannot represent path in USTAR: ${path}`);
}
function tar(files: { path: string; bytes: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    const path = tarPath(file.path), header = Buffer.alloc(512);
    header.write(path.name, 0, 100, 'utf8'); header.write(path.prefix, 345, 155, 'utf8');
    header.write((0o644).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii'); header.write('0000000\0', 116, 8, 'ascii');
    header.write(file.bytes.byteLength.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    parts.push(header, file.bytes, Buffer.alloc((512 - file.bytes.byteLength % 512) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
const bundleEntry = 'node_modules/@jimhoyd/urlcode-store/dist/index.js';
const packedBundle = await (async () => {
  const tree = [
    { path: 'node_modules/@jimhoyd/urlcode-store/package.json', bytes: await readFile(join(storeDirectory, 'package.json')) },
    ...(await walk(join(storeDirectory, 'dist'))).map(file => ({ path: `node_modules/@jimhoyd/urlcode-store/dist/${file.path}`, bytes: file.bytes })),
  ];
  assert.ok(tree.some(file => file.path === bundleEntry), 'packed store is missing its entry module');
  const bundleJson = Buffer.from(JSON.stringify({ format: 1, coreVersion, bundles: [{ name: 'store', version: '0.5.0', entry: bundleEntry }] }));
  const bytes = gzipSync(tar([{ path: 'bundle.json', bytes: bundleJson }, ...tree]));
  return { asset: 'store-0.5.0.tgz', entry: bundleEntry, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
})();
const bundleReleaseTag = `extension-bundles@v${coreVersion}`;
const bundleTransport: BundleTransport = {
  release: async () => [{ name: 'extension-bundles-catalog.json', url: 'catalog' }, { name: packedBundle.asset, url: packedBundle.asset }],
  download: async url => url === 'catalog' ? Buffer.from(JSON.stringify({ format: 1, tag: bundleReleaseTag, commit: 'a'.repeat(40), coreVersion, bundles: [{ name: 'store', version: '0.5.0', asset: packedBundle.asset, sha256: packedBundle.sha256, entry: packedBundle.entry }], revoked: [] })) : packedBundle.bytes,
  attest: async () => {},
};

async function root(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-store-core-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const init = (t: test.TestContext, dest: string, acknowledgements: string[] = []) =>
  root(t).then(directory => initProjectWith(join(directory, dest), ['store'], { cwd: directory, manifest: false, bundleRelease: bundleReleaseTag, bundleTransport, acknowledgements }));

test('the installed core scaffolds a public store when acknowledged, so the peer floor includes --ack', async t => {
  const created = await init(t, 'site', ['store:public-write']);
  assert.deepEqual(created.extensions, ['store']);
});

test('without auth or the acknowledgement, the refusal prints the command the installed core accepts', async t => {
  await assert.rejects(init(t, 'site'), /--ack store:public-write/);
});
