import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { classify, diffRange, docsOnly, gate, platformChecks, testMatrix } from '../scripts/ci-plan.ts';
import { identity, assertChannel, assertIntegrity, imageFromDockerfile, assertMainRun } from '../scripts/release.ts';

test('docs lane is narrow and mixed, unknown, executable or empty changes run fully', () => {
  for (const path of ['docs/CI.md', 'AGENTS.md', 'llms-full.txt']) assert(docsOnly([path]));
  for (const path of ['src/runtime.ts', 'package-lock.json', 'docs/fixture.json', 'starters/default/AGENTS.md', '.github/workflows/ci.yml', 'packages/ui/README.md', 'unknown.md']) assert(!docsOnly(['docs/CI.md', path]));
  assert(!docsOnly([]));
  assert(!docsOnly(['docs/old.md', 'src/renamed.ts']));
});
test('reviewed contributor prose joins the docs lane; benchmark and package inputs do not', () => {
  for (const path of ['benchmarks/agent/README.md', 'benchmarks/results/README.md', 'packages/ui/CONTRIBUTING.md', 'packages/auth/CODE_OF_CONDUCT.md', 'packages/admin/GOVERNANCE.md']) assert(docsOnly([path]), path);
  // Benchmark prompts, tasks and answers are inputs a run reads; package
  // READMEs, security, contract, status and changelog documents ship inside a
  // published tarball or are read by an agent surface.
  for (const path of [
    'benchmarks/agent/prompts/urlcode.md', 'benchmarks/agent/tasks/json-api/acceptance/README.md',
    'benchmarks/agent/answers/redirect-service/conventional/README.md', 'benchmarks/agent/run.ts',
    'packages/ui/README.md', 'packages/auth/SECURITY.md', 'packages/ui/CONTRACT.md',
    'packages/admin/IMPLEMENTATION-STATUS.md', 'packages/ui/CHANGELOG.md', 'packages/auth/AGENTS.md',
    'packages/auth/docs/JSON-API.md', 'skills/urlcode/SKILL.md', 'recipes/redirect/README.md',
  ]) assert(!docsOnly([path]), path);
  // The change that motivated this: PR #205 touched exactly these two files.
  assert(docsOnly(['benchmarks/agent/README.md', 'docs/SPIKE-CORE-LAYERING.md']));
});
test('only pull requests and pushes are classified, and each uses its own diff range', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  // A pull request is measured from its merge base; a push tip to tip.
  assert.equal(diffRange('pull_request', base, head), `${base}...${head}`);
  assert.equal(diffRange('push', base, head), `${base}..${head}`);
  // Release coverage is never classified from paths.
  for (const event of ['schedule', 'workflow_dispatch', 'release', '']) assert.equal(diffRange(event, base, head), null);
  // Missing, malformed, truncated, uppercase and absent (branch create/delete) SHAs fail closed.
  for (const sha of [undefined, '', 'nope', base.slice(1), `${base}c`, base.toUpperCase(), '0'.repeat(40)]) {
    for (const event of ['pull_request', 'push']) {
      assert.equal(diffRange(event, sha, head), null, `${event} base ${String(sha)}`);
      assert.equal(diffRange(event, base, sha), null, `${event} head ${String(sha)}`);
    }
  }
});
test('classification fails closed for unclassifiable events and unreadable history', () => {
  const base = 'a'.repeat(40), head = 'b'.repeat(40);
  const never = () => { throw new Error('diff must not be attempted'); };
  for (const event of ['schedule', 'workflow_dispatch', '']) assert.deepEqual(classify(event, base, head, never), { lane: 'full', paths: null });
  assert.deepEqual(classify('push', base, '0'.repeat(40), never), { lane: 'full', paths: null });
  // A shallow checkout or a rewritten history cannot produce the diff.
  const unavailable = () => { throw new Error('fatal: bad object'); };
  for (const event of ['pull_request', 'push']) assert.deepEqual(classify(event, base, head, unavailable), { lane: 'full', paths: null });
  // An empty diff (an unchanged range) is not prose, so it runs fully.
  assert.deepEqual(classify('push', base, head, () => []), { lane: 'full', paths: [] });
});
test('real git history selects the lane for pull requests, main pushes, renames and deletions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-ci-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const write = async (path: string, text: string) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const commit = (message: string) => { git('add', '-A'); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  git('init', '-b', 'main'); git('config', 'user.email', 'ci@example.invalid'); git('config', 'user.name', 'ci');
  git('config', 'commit.gpgsign', 'false');
  await write('docs/CI.md', 'one\n');
  await write('benchmarks/agent/README.md', 'one\n');
  await write('src/runtime.ts', 'export const a = 1;\n');
  const start = commit('start');
  // The classifier reads the repository it runs in, as it does on the runner.
  // stderr is dropped because one case deliberately names a missing commit.
  const at = (event: string, base: string, head: string) => classify(event, base, head, range =>
    execFileSync('git', ['diff', '--no-renames', '--name-only', range, '--'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean));

  await write('docs/CI.md', 'two\n');
  await write('benchmarks/agent/README.md', 'two\n');
  const prose = commit('prose only');
  assert.equal(at('push', start, prose).lane, 'docs');
  assert.equal(at('pull_request', start, prose).lane, 'docs');

  await write('src/runtime.ts', 'export const a = 2;\n');
  await write('docs/CI.md', 'three\n');
  const mixed = commit('prose and code');
  assert.equal(at('push', prose, mixed).lane, 'full');
  // A main push spanning both commits is still mixed, not prose.
  assert.equal(at('push', start, mixed).lane, 'full');

  git('mv', 'docs/CI.md', 'src/CI.ts');
  const renamed = commit('rename prose into source');
  const rename = at('push', mixed, renamed);
  assert.equal(rename.lane, 'full');
  assert.deepEqual(rename.paths?.sort(), ['docs/CI.md', 'src/CI.ts']);

  git('rm', '-q', 'src/CI.ts');
  const deletedCode = commit('delete source');
  assert.equal(at('push', renamed, deletedCode).lane, 'full');

  await write('unknown.md', 'x\n');
  const unknown = commit('unknown path');
  assert.equal(at('push', deletedCode, unknown).lane, 'full');

  git('rm', '-q', 'benchmarks/agent/README.md');
  const deletedProse = commit('delete prose');
  assert.equal(at('push', unknown, deletedProse).lane, 'docs');

  // A commit this clone does not have selects full rather than throwing.
  assert.deepEqual(at('push', 'c'.repeat(40), deletedProse), { lane: 'full', paths: null });
});
test('required gate fails closed for failed, canceled, missing and unexpected skipped jobs', () => {
  const always = ['plan', 'docs', 'audit', 'container'];
  const conditional = ['static', 'verify', 'workspaces', 'action', 'build-fidelity'];
  for (const plan of ['docs', 'full']) {
    const results = Object.fromEntries([...always, ...conditional].map(name => [name, { result: plan === 'docs' && conditional.includes(name) ? 'skipped' : 'success' }]));
    gate(plan, results);
    for (const name of [...always, ...conditional]) {
      const missing = { ...results }; delete missing[name];
      assert.throws(() => gate(plan, missing));
      for (const result of ['failure', 'cancelled', 'skipped']) {
        if (result === results[name]!.result) continue;
        assert.throws(() => gate(plan, { ...results, [name]: { result } }));
      }
    }
  }
  assert.throws(() => gate('', {}));
});
test('workflow gate covers every producer and full jobs depend on the classifier', async () => {
  const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
  assert.deepEqual(workflow.jobs['verify-complete'].needs.sort(), Object.keys(workflow.jobs).filter(name => name !== 'verify-complete').sort());
  for (const name of ['static', 'verify', 'workspaces', 'action', 'build-fidelity']) {
    assert.deepEqual(workflow.jobs[name].needs, 'plan');
    assert.equal(workflow.jobs[name].if, "needs.plan.outputs.lane == 'full'");
  }
  assert.equal(workflow.jobs['verify-complete'].if, 'always()');
  // The classifier needs the push SHAs as well as the pull-request ones, and
  // needs history deep enough to diff them.
  const plan = workflow.jobs.plan.steps.at(-1);
  assert.match(plan.env.BASE, /pull_request\.base\.sha \|\| github\.event\.before/);
  assert.match(plan.env.HEAD, /pull_request\.head\.sha \|\| github\.event\.after/);
  assert.equal(workflow.jobs.plan.steps[0].with['fetch-depth'], 0);
  // Prose can never skip these, whatever lane is selected.
  for (const name of ['docs', 'audit', 'container']) assert.equal(workflow.jobs[name].if, undefined);
});
test('all package tag and channel identities are derived from manifests', () => {
  const core = identity('@jimhoyd/urlcode', '0.4.0-alpha.2', '.');
  assert.equal(core.tag, 'v0.4.0-alpha.2'); assert.equal(core.channel, 'alpha'); assert(core.prerelease);
  const ui = identity('@jimhoyd/urlcode-ui', '1.0.0', 'packages/ui');
  assert.equal(ui.tag, '@jimhoyd/urlcode-ui@1.0.0'); assert.equal(ui.channel, 'latest'); assert(!ui.prerelease);
  assert.equal(ui.tarball, 'jimhoyd-urlcode-ui-1.0.0.tgz');
  for (const version of ['01.0.0', '1.0.0-1', '1.0.0-alpha..1', 'nope']) assert.throws(() => identity('x', version, '.'));
});
test('release retries require identical integrity and cannot regress a channel', () => {
  const bytes = Buffer.from('original candidate');
  assertIntegrity(bytes, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  assert.throws(() => assertIntegrity(Buffer.from('replacement'), `sha512-${createHash('sha512').update(bytes).digest('base64')}`));
  assert.throws(() => assertIntegrity(bytes, ''));
  assertChannel('1.0.0-alpha.10', '1.0.0-alpha.9');
  assertChannel('1.0.0', '1.0.0');
  assert.throws(() => assertChannel('1.0.0-alpha.2', '1.0.0-alpha.10'));
});
test('candidate and release accept the actual Dockerfile but reject unpinned or malformed FROM', async () => {
  assert.match(imageFromDockerfile(await readFile('Dockerfile', 'utf8')), /@sha256:/);
  const image = `node:26-slim@sha256:${'a'.repeat(64)}`;
  assert.equal(imageFromDockerfile(`FROM ${image}\n`), image);
  assert.equal(imageFromDockerfile(`FROM ${image} AS build\n`), image);
  for (const text of ['FROM node:26', `FROM ${image} AS build extra`, `FROM ${image} AS`, `RUN ${image}`]) assert.throws(() => imageFromDockerfile(text));
});
test('release gate requires the selected SHA, refuses a failed latest run, and permits explicit full reruns', () => {
  const pass = { head_sha: 'a', head_branch: 'main', event: 'schedule', conclusion: 'success' };
  assertMainRun([pass], 'a');
  for (const runs of [[], [{ ...pass, head_sha: 'b' }], [{ ...pass, conclusion: null }], [{ ...pass, conclusion: 'cancelled' }], [{ ...pass, conclusion: 'failure' }, pass], [{ ...pass, event: 'pull_request' }], [{ ...pass, event: 'push' }]]) assert.throws(() => assertMainRun(runs, 'a'));
  assertMainRun([{ ...pass, event: 'workflow_dispatch', head_branch: 'v1.0.0' }], 'a');
});

test('routine matrices retain Node coverage without the full OS cross product', () => {
  const main = testMatrix('push', null).include;
  assert.equal(main.length, 5);
  assert.deepEqual(main.filter(leg => leg.os === 'ubuntu-latest').map(leg => leg.node), ['22', '24', '26']);
  assert(main.some(leg => leg.os === 'windows-latest' && leg.node === '24'));
  assert(main.some(leg => leg.os === 'macos-latest' && leg.node === '24'));
  for (const event of ['schedule', 'workflow_dispatch', 'unknown']) {
    const full = testMatrix(event, null).include;
    assert.equal(full.length, 9);
    assert.equal(new Set(full.map(leg => `${leg.os}/${leg.node}`)).size, 9);
  }
});
test('platform PR coverage fails closed and preserves SQLite, CLI and renamed paths', () => {
  for (const path of ['packages/ui/src/styles.ts', 'docs/CI.md', '.changeset/example.md']) {
    assert(!platformChecks([path]));
    assert.equal(testMatrix('pull_request', [path]).include.length, 3);
  }
  for (const path of ['src/cli.ts', 'src/runtime.ts', 'packages/auth/src/auth-store.ts', 'packages/admin/test/admin-http.test.ts', 'packages/ui/src/host/scaffold.ts', 'package-lock.json', '.github/workflows/ci.yml', 'unknown.ts']) {
    assert(platformChecks(['docs/CI.md', path]));
    assert.equal(testMatrix('pull_request', [path]).include.length, 5);
  }
  for (const paths of [null, []]) assert.equal(testMatrix('pull_request', paths).include.length, 5);
});
test('both suites consume the same plan and nightly/manual runs cannot cancel main verification', async () => {
  const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
  assert(workflow.on.schedule.length > 0);
  for (const name of ['verify', 'workspaces']) assert.equal(workflow.jobs[name].strategy.matrix, '${{ fromJSON(needs.plan.outputs.matrix) }}');
  assert.match(workflow.concurrency.group, /github.event_name/);
});
