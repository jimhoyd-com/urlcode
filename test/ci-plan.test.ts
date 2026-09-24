import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHARDS, actionRelevant, buildFidelityRelevant, checksMatrix, classify,
  containerRelevant, coreChecksRelevant, diffRange, docsOnly, gate,
  packageSmokeRelevant, shardMatrix, testMatrix, workspaceIntegrationMatrix,
  workspacePackageMatrix, workspacePackages,
} from '../scripts/ci-plan.ts';

test('docs lane is narrow and fails closed', () => {
  for (const path of ['docs/CI.md', 'AGENTS.md', 'llms-full.txt', 'packages/ui/CONTRIBUTING.md']) assert(docsOnly([path]), path);
  for (const path of ['packages/core/src/runtime.ts', 'package-lock.json', 'docs/fixture.json', 'starters/default/AGENTS.md', '.github/workflows/ci.yml', 'packages/ui/README.md', 'unknown.md']) assert(!docsOnly(['docs/CI.md', path]), path);
  assert(!docsOnly([]));
  assert(!docsOnly(['docs/old.md', 'packages/core/src/renamed.ts']));
});

test('only pull requests and pushes are classified from their own diff ranges', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  assert.equal(diffRange('pull_request', base, head), `${base}...${head}`);
  assert.equal(diffRange('push', base, head), `${base}..${head}`);
  for (const event of ['schedule', 'workflow_dispatch', 'release', '']) assert.equal(diffRange(event, base, head), null);
  for (const sha of [undefined, '', 'nope', base.slice(1), `${base}c`, base.toUpperCase(), '0'.repeat(40)]) {
    for (const event of ['pull_request', 'push']) {
      assert.equal(diffRange(event, sha, head), null);
      assert.equal(diffRange(event, base, sha), null);
    }
  }
});

test('classification fails closed for unavailable history and empty diffs', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const never = () => { throw new Error('diff must not be attempted'); };
  for (const event of ['schedule', 'workflow_dispatch', '']) assert.deepEqual(classify(event, base, head, never), { lane: 'full', paths: null });
  assert.deepEqual(classify('push', base, '0'.repeat(40), never), { lane: 'full', paths: null });
  assert.deepEqual(classify('pull_request', base, head, () => { throw new Error('missing history'); }), { lane: 'full', paths: null });
  assert.deepEqual(classify('push', base, head, () => []), { lane: 'full', paths: [] });
});

test('real git history selects prose only when every changed path is prose', async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-ci-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = async (path: string, text: string) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const commit = (message: string) => { git('add', '-A'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '-b', 'main'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'ci'); git('config', 'commit.gpgsign', 'false');
  await write('docs/CI.md', 'one\n'); await write('packages/core/src/runtime.ts', 'export const a = 1;\n');
  const start = commit('start');
  const at = (base: string, head: string) => classify('push', base, head, range => execFileSync('git', ['diff', '--no-renames', '--name-only', range, '--'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean));
  await write('docs/CI.md', 'two\n'); const prose = commit('prose');
  assert.equal(at(start, prose).lane, 'docs');
  await write('packages/core/src/runtime.ts', 'export const a = 2;\n'); const mixed = commit('runtime');
  assert.equal(at(prose, mixed).lane, 'full');
  git('mv', 'docs/CI.md', 'packages/core/src/CI.ts'); const renamed = commit('rename');
  assert.deepEqual(at(mixed, renamed).paths?.sort(), ['docs/CI.md', 'packages/core/src/CI.ts']);
});

test('required gate rejects missing, failed, canceled and unplanned jobs', () => {
  const always = ['plan', 'docs'];
  const conditional = ['static', 'verify', 'checks', 'workspace-verify', 'workspace-integration', 'audit', 'action', 'build-fidelity', 'container'];
  const full = Object.fromEntries([...always, ...conditional].map(name => [name, { result: 'success' }]));
  gate('full', full, true, true, true, true, true);
  for (const name of [...always, ...conditional]) {
    const missing = { ...full }; delete missing[name];
    assert.throws(() => gate('full', missing, true, true, true, true, true));
    assert.throws(() => gate('full', { ...full, [name]: { result: 'failure' } }, true, true, true, true, true));
  }
  const extension = Object.fromEntries([...always, ...conditional].map(name => [name, { result: ['verify', 'checks', 'workspace-integration', 'audit', 'action', 'build-fidelity', 'container'].includes(name) ? 'skipped' : 'success' }]));
  gate('full', extension);
  assert.throws(() => gate('full', extension, false, true));
  assert.throws(() => gate('full', extension, false, false, true));
  assert.throws(() => gate('', {}));
});

test('routine matrix is Linux Node 24; exact coverage is the full supported matrix', () => {
  for (const event of ['pull_request', 'push']) assert.deepEqual(testMatrix(event, null).include, [{ os: 'ubuntu-latest', node: '24' }]);
  for (const event of ['schedule', 'workflow_dispatch', 'merge_group', 'unknown']) assert.equal(testMatrix(event, null).include.length, 9);
  for (const path of ['packages/ui/src/styles.ts', 'packages/auth/test/auth.test.ts', 'packages/forms/package.json']) {
    assert(!packageSmokeRelevant([path])); assert(!actionRelevant([path])); assert(!containerRelevant([path])); assert(!coreChecksRelevant([path]));
  }
  for (const paths of [null, [], ['packages/core/src/cli.ts'], ['package-lock.json'], ['action/action.yml']]) {
    assert(packageSmokeRelevant(paths)); assert(actionRelevant(paths)); assert(containerRelevant(paths)); assert(coreChecksRelevant(paths));
  }
  assert(!buildFidelityRelevant(['packages/auth/src/auth.ts']));
  assert(buildFidelityRelevant(['test/ci-plan.test.ts']));
});

test('workspace selection includes reverse dependencies and reserves integration for release dispatch', () => {
  assert.deepEqual(workspacePackages(['packages/admin/src/admin-ui.ts']), ['admin']);
  assert.deepEqual(workspacePackages(['packages/auth/src/auth-ui.ts']), ['auth', 'admin']);
  assert.deepEqual(workspacePackages(['packages/ui/src/kit.ts']), ['ui', 'auth', 'admin', 'forms']);
  for (const paths of [null, [], ['packages/core/src/cli.ts'], ['package-lock.json']]) assert.deepEqual(workspacePackages(paths), ['ui', 'auth', 'admin', 'store', 'forms']);
  assert.equal(workspacePackageMatrix('pull_request', ['packages/ui/src/kit.ts']).include.length, 4);
  for (const event of ['pull_request', 'push', 'schedule']) assert.deepEqual(workspaceIntegrationMatrix(event).include, []);
  assert.deepEqual(workspaceIntegrationMatrix('workflow_dispatch').include, [
    { os: 'ubuntu-latest', node: '24' }, { os: 'macos-latest', node: '24' }, { os: 'windows-latest', node: '24' },
  ]);
});

test('every test leg has every shard and routine checks stay on the fast leg', () => {
  assert.equal(SHARDS, 3);
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch', 'merge_group']) {
    const legs = testMatrix(event, null).include;
    assert.equal(shardMatrix(event, null).include.length, legs.length * SHARDS);
    const checks = checksMatrix(event, null).include;
    assert.deepEqual(checks.map(({ os, node }) => ({ os, node })), legs);
    if (['pull_request', 'push'].includes(event)) assert.deepEqual(checks.filter(check => check.full).map(check => `${check.os}/${check.node}`), ['ubuntu-latest/24']);
    else assert.equal(checks.filter(check => check.full).length, 9);
  }
});
