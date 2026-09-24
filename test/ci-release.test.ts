import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertChannel, assertCodeQLRun, assertIntegrity, assertMainRun, assertReleasePolicy, identity, imageFromDockerfile } from '../scripts/release.ts';

test('all package tag and channel identities are derived from manifests', () => {
  const core = identity('@jimhoyd/urlcode', '0.4.0-alpha.2', '.');
  assert.equal(core.tag, 'v0.4.0-alpha.2'); assert.equal(core.channel, 'alpha'); assert(core.prerelease);
  const ui = identity('@jimhoyd/urlcode-ui', '1.0.0', 'packages/ui');
  assert.equal(ui.tag, '@jimhoyd/urlcode-ui@1.0.0'); assert.equal(ui.channel, 'latest'); assert.equal(ui.tarball, 'jimhoyd-urlcode-ui-1.0.0.tgz');
  for (const version of ['01.0.0', '1.0.0-1', '1.0.0-alpha..1', 'nope']) assert.throws(() => identity('x', version, '.'));
});

test('release retries require identical integrity and cannot regress a channel', () => {
  const bytes = Buffer.from('original candidate');
  assertIntegrity(bytes, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  assert.throws(() => assertIntegrity(Buffer.from('replacement'), `sha512-${createHash('sha512').update(bytes).digest('base64')}`));
  assert.throws(() => assertIntegrity(bytes, ''));
  assertChannel('1.0.0-alpha.10', '1.0.0-alpha.9');
  assert.throws(() => assertChannel('1.0.0-alpha.2', '1.0.0-alpha.10'));
});

test('candidate and release accept the Dockerfile image only when pinned', async () => {
  assert.match(imageFromDockerfile(await readFile('packaging/container/Dockerfile', 'utf8')), /@sha256:/);
  const image = `node:26-slim@sha256:${'a'.repeat(64)}`;
  assert.equal(imageFromDockerfile(`FROM ${image} AS build\n`), image);
  for (const text of ['FROM node:26', `FROM ${image} AS build extra`, `FROM ${image} AS`, `RUN ${image}`]) assert.throws(() => imageFromDockerfile(text));
});

test('release gate requires successful explicit verification of the exact commit', () => {
  const pass = { head_sha: 'a', head_branch: 'main', event: 'schedule', conclusion: 'success' };
  assert.throws(() => assertMainRun([pass], 'a'));
  for (const runs of [[], [{ ...pass, head_sha: 'b' }], [{ ...pass, conclusion: null }], [{ ...pass, event: 'pull_request' }]]) assert.throws(() => assertMainRun(runs, 'a'));
  assertMainRun([{ ...pass, event: 'workflow_dispatch', head_branch: 'v1.0.0' }], 'a');
});

test('candidate selection refuses newer failed or pending runs and wrong sources', async () => {
  const { candidateRun, requireOriginal } = await import('../scripts/release-artifacts.ts');
  const run = { id: 1, head_sha: 'a', head_branch: 'main', event: 'workflow_dispatch', conclusion: 'success' };
  assert.equal(candidateRun([run], 'a').id, 1);
  assert.equal(candidateRun([{ ...run, head_branch: 'codex/release-validation/a' }], 'a').id, 1);
  for (const runs of [[], [{ ...run, head_sha: 'b' }], [{ ...run, head_branch: 'feature' }], [{ ...run, conclusion: null }, run], [{ ...run, conclusion: 'failure' }, run]]) assert.throws(() => candidateRun(runs, 'a'));
  requireOriginal(1, false, false);
  assert.throws(() => requireOriginal(2, false, false), /Refusing to rebuild/);
});

test('candidate validation rejects wrong-SHA and modified bundles', async t => {
  const { validateCandidate } = await import('../scripts/release-artifacts.ts');
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-artifact-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packages = ['.', 'packages/ui'].map((path, index) => identity(`@test/package${index}`, '1.0.0-alpha.1', path));
  const sha = 'a'.repeat(40), bytes = Buffer.from('measured archive');
  const assets: Record<string, Buffer> = Object.fromEntries(packages.map(pkg => [pkg.tarball, bytes]));
  assets['sbom.cdx.json'] = Buffer.from('{}'); assets['supply-chain-triage.json'] = Buffer.from('{}'); assets['urlcode.rb'] = Buffer.from('formula');
  assets['train.json'] = Buffer.from(JSON.stringify({ sourceCommit: sha, packages: packages.map(pkg => ({ name: pkg.name, version: pkg.version, filename: pkg.tarball, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, channel: pkg.channel, peerDependencies: pkg.peers })) }));
  const digests = Object.fromEntries(Object.entries(assets).map(([name, value]) => [name, createHash('sha256').update(value).digest('hex')]));
  for (const [name, value] of Object.entries(assets)) await writeFile(join(directory, name), value);
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ sourceCommit: sha, channel: 'candidate', candidateRun: '42', artifacts: digests }));
  await writeFile(join(directory, 'SHA256SUMS'), Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n');
  await validateCandidate(directory, sha, packages, 42);
  await assert.rejects(validateCandidate(directory, 'b'.repeat(40), packages), /source SHA/);
  await writeFile(join(directory, packages[0]!.tarball), 'changed');
  await assert.rejects(validateCandidate(directory, sha, packages), /hash mismatch/);
});

test('CodeQL gate requires latest trusted analysis and stable policy matches package versions', () => {
  const pass = { id: 1, name: 'CodeQL', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 10 } };
  assertCodeQLRun([pass]);
  assert.throws(() => assertCodeQLRun([pass, { ...pass, id: 2, conclusion: 'failure', check_suite: { id: 11 } }]), /Latest CodeQL/);
  const stable = [identity('@jimhoyd/urlcode', '0.4.1', '.')];
  const alpha = [identity('@jimhoyd/urlcode', '0.4.0-alpha.3', '.')];
  assertReleasePolicy(stable, null); assertReleasePolicy(alpha, { mode: 'pre', tag: 'alpha' });
  assert.throws(() => assertReleasePolicy(alpha, null), /require explicit/);
});
