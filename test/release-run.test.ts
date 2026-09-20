import test from 'node:test';
import assert from 'node:assert/strict';
import { checkState, selectedRun, packageState, options } from '../scripts/release-run.ts';
import type { WorkflowRun } from '../scripts/release-run.ts';
import { candidateTag } from '../scripts/release-artifacts.ts';
import { identity } from '../scripts/release.ts';

const passed = ['verify-complete', 'container', 'CodeQL'].map(name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));
test('release PR gate waits for required evidence and stops on failed checks', () => {
  assert.equal(checkState([], true), 'pending');
  assert.equal(checkState(passed, true), 'passed');
  for (const omitted of passed) assert.equal(checkState(passed.filter(check => check !== omitted), true), 'pending');
  assert.equal(checkState([...passed, { name: 'extra', status: 'IN_PROGRESS', conclusion: null }], true), 'pending');
  assert.equal(checkState([...passed, { name: 'extra', status: 'COMPLETED', conclusion: null }], true), 'pending');
  assert.equal(checkState([...passed, { name: 'extra', status: 'COMPLETED', conclusion: 'UNKNOWN' }], true), 'pending');
  for (const conclusion of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']) {
    assert.equal(checkState([...passed, { name: 'extra', status: 'COMPLETED', conclusion }], true), 'failed');
  }
  assert.equal(checkState([{ context: 'template-ci', state: 'SUCCESS' }], false), 'passed');
  assert.equal(checkState([{ context: 'template-ci', state: 'ERROR' }], false), 'failed');
});
test('exact SHA gates ignore routine CI and unrelated candidate refs without hiding latest failures', () => {
  const run: WorkflowRun = { id: 7, head_sha: 'a', head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  assert.equal(selectedRun([run], 'a', 'ci'), run);
  assert.equal(selectedRun([run], 'a', 'candidate'), run);
  for (const kind of ['ci', 'candidate'] as const) {
    assert.equal(selectedRun([{ ...run, head_sha: 'b' }], 'a', kind), undefined);
    assert.equal(selectedRun([{ ...run, event: 'push' }], 'a', kind), undefined);
    const failed = { ...run, id: 8, conclusion: 'failure' };
    assert.equal(selectedRun([failed, run], 'a', kind), failed);
  }
  assert.equal(selectedRun([{ ...run, event: 'schedule' }], 'a', 'ci')?.id, 7);
  assert.equal(selectedRun([{ ...run, event: 'schedule', head_branch: 'feature' }], 'a', 'ci'), undefined);
  assert.equal(selectedRun([{ ...run, head_branch: 'feature' }], 'a', 'candidate'), undefined);
  assert.equal(selectedRun([{ ...run, head_branch: 'codex/release-validation/a' }], 'a', 'candidate')?.id, 7);
  assert.equal(selectedRun([{ ...run, head_branch: 'codex/release-validation/b' }], 'a', 'candidate'), undefined);
});
test('publication state resumes same-commit tags and rejects unrepairable drift', () => {
  assert.equal(packageState(false, undefined, 'a'), 'pending');
  assert.equal(packageState(false, 'a', 'a'), 'resume');
  assert.equal(packageState(true, 'a', 'a'), 'resume');
  assert.equal(packageState(true, 'b', 'a'), 'unchanged');
  assert.throws(() => packageState(false, 'b', 'a'), /another commit/);
  assert.throws(() => packageState(true, undefined, 'a'), /no release tag/);
});
test('release CLI defaults to read-only and rejects ambiguous or unscoped preparation', () => {
  assert.deepEqual(options([]), { execute: false, consume: false, template: true });
  assert.equal(options(['--version', '0.4.0-alpha.4']).execute, false);
  assert.equal(options(['--version', '0.4.1']).version, '0.4.1');
  assert.deepEqual(options(['--execute', '--skip-template']), { execute: true, consume: false, template: false });
  for (const args of [['--version'], ['--version', '1.0.0+build'], ['--version', '1.0.0-beta.1'], ['--version', '--execute'], ['--notes', 'notes.md'], ['--consume-changesets'], ['--bypass']]) assert.throws(() => options(args));
});
test('immutable annotated release tags pin exact source and candidate identity', () => {
  const pkg = identity('@jimhoyd/urlcode', '0.4.0-alpha.4', '.');
  const sha = 'a'.repeat(40);
  const digest = 'b'.repeat(64);
  const tag = { tag: pkg.tag, object: { type: 'commit', sha }, message: JSON.stringify({ sourceCommit: sha, candidateRun: 42, candidateManifestSha256: digest }) };
  assert.deepEqual(candidateTag(tag, pkg, sha), { id: 42, manifestSha256: digest });
  for (const altered of [
    { ...tag, tag: 'v0.4.0-alpha.5' },
    { ...tag, object: { type: 'tag', sha } },
    { ...tag, object: { type: 'commit', sha: 'b'.repeat(40) } },
    { ...tag, message: 'not json' },
    ...[undefined, null, '', 'short', 'A'.repeat(64), 42].map(candidateManifestSha256 => ({ ...tag, message: JSON.stringify({ sourceCommit: sha, candidateRun: 42, candidateManifestSha256 }) })),
    ...[0, -1, 1.2, '42', null].map(candidateRun => ({ ...tag, message: JSON.stringify({ sourceCommit: sha, candidateRun }) })),
    { ...tag, message: JSON.stringify({ sourceCommit: 'b'.repeat(40), candidateRun: 42 }) },
  ]) assert.throws(() => candidateTag(altered, pkg, sha));
});
