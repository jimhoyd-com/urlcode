import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleTag, createOrResumeBundleTag, selectBundleSource, verifyBundleArchives, verifyBundleInventory } from '../scripts/extension-bundle-release.ts';

test('bundle tag dispatch only accepts a bounded version and creates or resumes the immutable tag', async () => {
  assert.equal(bundleTag('0.5.2'), 'extension-bundles@v0.5.2');
  for (const version of ['', 'v0.5.2', '0.5.2/escape', '0.5.2+build', 'a'.repeat(102)]) assert.throws(() => bundleTag(version));
  const base = { version: '0.5.2', refType: 'branch', ref: 'refs/heads/main', sha: 'a'.repeat(40), repository: 'owner/repo' };
  const calls: string[][] = [];
  const created = await createOrResumeBundleTag(base, async (program, args) => { calls.push([program, ...args]); if (args[0] === 'api' && args.includes('--jq')) throw new Error('not found'); return ''; });
  assert.deepEqual(created, { tag: 'extension-bundles@v0.5.2', commit: base.sha, resumed: false });
  assert(calls.some(call => call.includes('ref=refs/tags/extension-bundles@v0.5.2')));
  const resumed = await createOrResumeBundleTag(base, async (_program, args) => {
    if (args[0] === 'api' && args.includes('--jq')) return 'b'.repeat(40);
    if (args[0] === 'release') throw new Error('not published');
    throw new Error(`unexpected ${args.join(' ')}`);
  });
  assert.deepEqual(resumed, { tag: 'extension-bundles@v0.5.2', commit: 'b'.repeat(40), resumed: true });
  await assert.rejects(() => createOrResumeBundleTag(base, async (_program, args) => args[0] === 'api' ? 'b'.repeat(40) : ''), /already exists/);
  await assert.rejects(() => createOrResumeBundleTag({ ...base, ref: 'refs/heads/topic' }), /refs\/heads\/main/);
});

test('tagged bundle source is pinned to its tag and exact commit', () => {
  const input = { refType: 'tag', refName: 'extension-bundles@v0.5.2', eventName: 'workflow_dispatch', version: '0.5.2', sha: 'a'.repeat(40) };
  assert.deepEqual(selectBundleSource(input), { tag: input.refName, commit: input.sha });
  assert.throws(() => selectBundleSource({ ...input, refType: 'branch' }), /tag ref/);
  assert.throws(() => selectBundleSource({ ...input, refName: 'v0.5.2' }), /Not an extension/);
  assert.throws(() => selectBundleSource({ ...input, version: '0.5.3' }), /does not match/);
  assert.throws(() => selectBundleSource({ ...input, sha: 'short' }), /40-character/);
});

test('generated bundle inventory and archive members are verified before attestation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-bundle-inventory-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const asset = 'ui-0.5.2.tgz', bytes = Buffer.from('archive'), tag = 'extension-bundles@v0.5.2', commit = 'a'.repeat(40);
  await writeFile(join(directory, asset), bytes);
  await writeFile(join(directory, 'extension-bundles-catalog.json'), JSON.stringify({ format: 1, tag, commit, bundles: [{ name: 'ui', asset, sha256: createHash('sha256').update(bytes).digest('hex') }], revoked: [] }));
  await verifyBundleInventory(directory, tag, commit);
  await assert.rejects(() => verifyBundleInventory(directory, tag, 'b'.repeat(40)), /does not pin/);
  await verifyBundleArchives(directory, async (_program, args) => args[0] === '-tzf' ? 'bundle.json\nnode_modules/@jimhoyd/urlcode-ui/dist/index.js\n' : '-rw-r--r-- bundle.json\n-rw-r--r-- node_modules/@jimhoyd/urlcode-ui/dist/index.js\n');
  await assert.rejects(() => verifyBundleArchives(directory, async (_program, args) => args[0] === '-tzf' ? 'outside.js\n' : '-rw-r--r-- outside.js\n'), /missing bundle/);
  await assert.rejects(() => verifyBundleArchives(directory, async (_program, args) => args[0] === '-tzf' ? 'bundle.json\nnode_modules/x\n' : 'lrwxrwxrwx bundle.json\n'), /non-regular/);
});
