import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHARDS, actionRelevant, buildFidelityRelevant, checksMatrix, classify,
  containerRelevant, coreChecksRelevant, diffRange, docsOnly, gate, highImpact,
  packageSmokeRelevant, planEvent, platformLegs, shardMatrix, testMatrix, workspaceIntegrationMatrix,
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
  const conditional = ['static', 'verify', 'checks', 'workspace-verify', 'workspace-integration', 'audit', 'action', 'build-fidelity', 'container', 'package-floor-smoke'];
  const full = Object.fromEntries([...always, ...conditional].map(name => [name, { result: 'success' }]));
  gate('full', full, true, true, true, true, true, true);
  for (const name of [...always, ...conditional]) {
    const missing = { ...full }; delete missing[name];
    assert.throws(() => gate('full', missing, true, true, true, true, true, true));
    assert.throws(() => gate('full', { ...full, [name]: { result: 'failure' } }, true, true, true, true, true, true));
  }
  const extension = Object.fromEntries([...always, ...conditional].map(name => [name, { result: ['verify', 'checks', 'workspace-integration', 'audit', 'action', 'build-fidelity', 'container', 'package-floor-smoke'].includes(name) ? 'skipped' : 'success' }]));
  gate('full', extension);
  assert.throws(() => gate('full', extension, false, true));
  assert.throws(() => gate('full', extension, false, false, true));
  assert.throws(() => gate('', {}));
});

test('routine matrix is Linux Node 24; exact coverage is the full supported matrix', () => {
  for (const event of ['pull_request', 'push']) assert.deepEqual(testMatrix(event, null).include, [{ os: 'ubuntu-latest', node: '24' }]);
  for (const event of ['schedule', 'workflow_dispatch', 'merge_group', 'unknown']) assert.equal(testMatrix(event, null).include.length, 9);
  for (const path of ['packages/ui/src/styles.ts', 'packages/auth/test/auth.test.ts', 'packages/forms/package.json', 'packages/form-records/src/form-records.ts']) {
    assert(!packageSmokeRelevant([path])); assert(!actionRelevant([path])); assert(!containerRelevant([path])); assert(!coreChecksRelevant([path]));
  }
  for (const paths of [null, [], ['packages/core/src/cli.ts'], ['package-lock.json'], ['action/action.yml']]) {
    assert(packageSmokeRelevant(paths)); assert(actionRelevant(paths)); assert(containerRelevant(paths)); assert(coreChecksRelevant(paths));
  }
  assert(!buildFidelityRelevant(['packages/auth/src/auth.ts']));
  assert(buildFidelityRelevant(['test/ci-plan.test.ts']));
});

test('a release run is planned as exact-commit coverage whatever event triggered it', () => {
  assert.equal(planEvent({ CI_RELEASE: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_ACTIONS: 'true' }), 'workflow_dispatch');
  assert.equal(planEvent({ CI_RELEASE: 'false', GITHUB_EVENT_NAME: 'push', GITHUB_ACTIONS: 'true' }), 'push');
  assert.equal(planEvent({ CI_RELEASE: '', GITHUB_EVENT_NAME: 'pull_request', GITHUB_ACTIONS: 'true' }), 'pull_request');
  assert.equal(planEvent({ GITHUB_ACTIONS: 'true' }), '');
  assert.equal(planEvent({}), 'pull_request');
  const release = planEvent({ CI_RELEASE: 'true', GITHUB_EVENT_NAME: 'push' });
  assert.deepEqual(classify(release, 'a'.repeat(40), 'b'.repeat(40), () => ['docs/CI.md']), { lane: 'full', paths: null });
  assert.equal(testMatrix(release, null).include.length, 9);
  assert.equal(workspaceIntegrationMatrix(release, null).include.length, 3);
  assert.deepEqual(platformLegs(release, null), []);
});

test('workspace selection includes reverse dependencies and reserves integration for release dispatch', () => {
  assert.deepEqual(workspacePackages(['packages/admin/src/admin-ui.ts']), ['admin']);
  assert.deepEqual(workspacePackages(['packages/auth/src/auth-ui.ts']), ['auth', 'admin']);
  assert.deepEqual(workspacePackages(['packages/ui/src/kit.ts']), ['ui', 'auth', 'admin', 'store', 'forms', 'form-records']);
  assert.deepEqual(workspacePackages(['packages/store/src/screens.ts']), ['store', 'form-records']);
  assert.deepEqual(workspacePackages(['packages/forms/src/forms.ts']), ['forms', 'form-records']);
  assert.deepEqual(workspacePackages(['packages/form-records/src/form-records.ts']), ['form-records']);
  assert.deepEqual(workspacePackages(['packages/mcp/src/mcp.ts']), ['mcp']);
  for (const paths of [null, [], ['packages/core/src/cli.ts'], ['package-lock.json']]) assert.deepEqual(workspacePackages(paths), ['ui', 'auth', 'admin', 'store', 'forms', 'form-records', 'mcp']);
  assert.equal(workspacePackageMatrix('pull_request', ['packages/ui/src/kit.ts']).include.length, 6);
  assert.equal(workspacePackageMatrix('pull_request', ['packages/form-records/README.md']).include[0]!.deps, 'ui forms store');
  assert.equal(workspacePackageMatrix('pull_request', ['packages/store/src/screens.ts']).include[0]!.deps, 'ui');
  for (const event of ['pull_request', 'push', 'schedule']) assert.deepEqual(workspaceIntegrationMatrix(event, ['packages/core/src/runtime.ts']).include, []);
  for (const event of ['push', 'schedule', 'merge_group']) assert.deepEqual(workspaceIntegrationMatrix(event, null).include, []);
  assert.deepEqual(workspaceIntegrationMatrix('workflow_dispatch', ['docs/CI.md']).include, [
    { os: 'ubuntu-latest', node: '24' }, { os: 'macos-latest', node: '24' }, { os: 'windows-latest', node: '24' },
  ]);
});

test('every test leg has every shard and routine checks stay on the fast leg', () => {
  assert.equal(SHARDS, 3);
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch', 'merge_group']) {
    const legs = testMatrix(event, null).include;
    // An unclassifiable pull request fails closed and adds its high-impact platform leg to the shards only.
    assert.equal(shardMatrix(event, null).include.length, (legs.length + platformLegs(event, null).length) * SHARDS);
    const checks = checksMatrix(event, null).include;
    assert.deepEqual(checks.map(({ os, node }) => ({ os, node })), legs);
    if (['pull_request', 'push'].includes(event)) assert.deepEqual(checks.filter(check => check.full).map(check => `${check.os}/${check.node}`), ['ubuntu-latest/24']);
    else assert.equal(checks.filter(check => check.full).length, 9);
  }
});

// #744: one representative path per high-impact area.
const HIGH_IMPACT_PATHS = {
  installer: ['packages/core/src/addon-install.ts', 'packages/core/src/extensions-cli.ts', 'packages/core/src/upgrade.ts', 'packages/core/src/scaffold.ts', 'packages/core/src/init-with.ts', 'scripts/create-extension.ts', 'starters/default/app/urlcode.yaml'],
  manifests: ['package.json', 'package-lock.json', 'packages/core/package.json', 'packages/auth/package.json', 'packages/store/urlcode.json', 'examples/hello/package.json', 'scripts/workspaces.ts', 'scripts/build-addon-manifest.ts'],
  release: ['scripts/npm-command.ts', 'scripts/release-bump.ts', 'scripts/release-pack.ts', 'scripts/release-publish.ts', 'scripts/pack-addons.ts', 'scripts/package-smoke.ts', 'scripts/package-audit.ts', '.github/workflows/publish.yml'],
  integration: ['test/addons.integration.ts', 'scripts/test-addons.ts', 'packages/auth/test/cleanup.ts', 'packages/admin/test/cleanup.ts'],
  shared: ['.github/workflows/ci.yml', '.github/dependabot.yml', 'tsconfig.json', 'eslint.config.js', '.node-version', '.gitattributes', 'install.sh', 'Makefile'],
};
const ORDINARY = ['packages/core/src/runtime.ts', 'packages/core/src/server.ts', 'test/runtime.test.ts', 'examples/hello/urlcode.yaml', 'packages/auth/src/auth.ts', 'packages/ui/src/kit.ts', 'schemas/urlcode.schema.json', 'packages/auth/README.md', 'scripts/ci-build-fidelity.ts'];

test('each high-impact area adds a Windows test leg and the packed integration to a pull request', () => {
  for (const [area, paths] of Object.entries(HIGH_IMPACT_PATHS)) {
    for (const path of paths) {
      const changed = ['packages/core/src/runtime.ts', 'docs/CI.md', path];
      assert(highImpact([path]), `${area}: ${path}`);
      assert.deepEqual(platformLegs('pull_request', changed), [{ os: 'windows-latest', node: '24' }], path);
      assert.deepEqual(workspaceIntegrationMatrix('pull_request', changed).include, [{ os: 'ubuntu-latest', node: '24' }], path);
      const shards = shardMatrix('pull_request', changed).include;
      assert.deepEqual(shards.map(({ os, node, shard }) => `${os}/${node}/${shard}`), [
        'ubuntu-latest/24/1', 'ubuntu-latest/24/2', 'ubuntu-latest/24/3', 'windows-latest/24/1', 'windows-latest/24/2', 'windows-latest/24/3',
      ], path);
      // The rest of the routine lane is unchanged: checks and core-affecting workspace suites stay on Linux.
      assert.deepEqual(checksMatrix('pull_request', changed).include.map(({ os }) => os), ['ubuntu-latest'], path);
      assert(workspacePackageMatrix('pull_request', changed).include.every(({ os }) => os === 'ubuntu-latest'), path);
    }
  }
});

test('an extension-only high-impact change puts its Windows leg on the selected package suites', () => {
  for (const path of ['packages/auth/package.json', 'packages/auth/test/cleanup.ts', 'packages/store/urlcode.json']) {
    assert(!coreChecksRelevant([path]));
    const matrix = workspacePackageMatrix('pull_request', [path]).include;
    const packages = workspacePackages([path]);
    assert.deepEqual(matrix.map(({ os, package: pkg }) => `${os}/${pkg}`), [...packages.map(pkg => `ubuntu-latest/${pkg}`), ...packages.map(pkg => `windows-latest/${pkg}`)], path);
    assert.deepEqual(workspaceIntegrationMatrix('pull_request', [path]).include, [{ os: 'ubuntu-latest', node: '24' }]);
  }
  // An ordinary extension-only change keeps its Linux-only suites and no integration.
  assert(workspacePackageMatrix('pull_request', ['packages/auth/src/auth.ts']).include.every(({ os }) => os === 'ubuntu-latest'));
  assert.deepEqual(workspaceIntegrationMatrix('pull_request', ['packages/auth/src/auth.ts']).include, []);
});

test('docs-only and ordinary source pull requests keep the compact lane', () => {
  for (const paths of [['docs/CI.md'], ['README.md', 'docs/INSTALL.md', 'llms.txt', 'packages/ui/CONTRIBUTING.md'], ORDINARY, ...ORDINARY.map(path => [path])]) {
    assert(!highImpact(paths), paths.join());
    assert.deepEqual(platformLegs('pull_request', paths), []);
    assert.deepEqual(workspaceIntegrationMatrix('pull_request', paths).include, []);
    assert(shardMatrix('pull_request', paths).include.every(({ os }) => os === 'ubuntu-latest'));
    assert(workspacePackageMatrix('pull_request', paths).include.every(({ os }) => os === 'ubuntu-latest'));
  }
});

test('unknown and shared pull request inputs fail closed to the broader selection', () => {
  for (const paths of [null, [], ['.github/workflows/ci.yml'], ['tsconfig.base.json'], ['.npmrc'], ['unknown-root-file']]) {
    assert(highImpact(paths), JSON.stringify(paths));
    assert.deepEqual(platformLegs('pull_request', paths), [{ os: 'windows-latest', node: '24' }]);
    assert.deepEqual(workspaceIntegrationMatrix('pull_request', paths).include, [{ os: 'ubuntu-latest', node: '24' }]);
    assert.equal(shardMatrix('pull_request', paths).include.length, 2 * SHARDS);
  }
  // Unreadable history is planned with null paths, and so is broad.
  const plan = classify('pull_request', 'a'.repeat(40), 'b'.repeat(40), () => { throw new Error('shallow'); });
  assert.deepEqual(platformLegs('pull_request', plan.paths), [{ os: 'windows-latest', node: '24' }]);
});

test('main pushes and exact-commit coverage are unchanged by high-impact selection', () => {
  const path = ['package-lock.json'];
  assert.deepEqual(platformLegs('push', path), []);
  assert.deepEqual(shardMatrix('push', path).include.map(({ os }) => os), Array(SHARDS).fill('ubuntu-latest'));
  assert.deepEqual(workspaceIntegrationMatrix('push', path).include, []);
  for (const event of ['schedule', 'workflow_dispatch', 'merge_group']) {
    assert.deepEqual(platformLegs(event, null), []);
    assert.equal(shardMatrix(event, null).include.length, 9 * SHARDS);
    assert.equal(workspacePackageMatrix(event, null).include.length, 9 * 7);
  }
  assert.equal(workspaceIntegrationMatrix('workflow_dispatch', null).include.length, 3);
  assert.deepEqual(workspaceIntegrationMatrix('merge_group', null).include, []);
  assert.deepEqual(workspaceIntegrationMatrix('schedule', null).include, []);
});

test('the gate requires the packed integration exactly when the plan selected it', () => {
  const names = ['plan', 'docs', 'static', 'verify', 'checks', 'workspace-verify', 'workspace-integration', 'audit', 'action', 'build-fidelity', 'container', 'package-floor-smoke'];
  const all = Object.fromEntries(names.map(name => [name, { result: 'success' }]));
  gate('full', all, true, true, true, true, true, true);
  assert.throws(() => gate('full', { ...all, 'workspace-integration': { result: 'skipped' } }, true, true, true, true, true, true), /workspace-integration/);
  gate('full', { ...all, 'workspace-integration': { result: 'skipped' } }, false, true, true, true, true, true);
  assert.throws(() => gate('full', all, false, true, true, true, true, true), /workspace-integration/);
});
