import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { spawnSync } from 'node:child_process';
import { comparisonVerdict, skipVerdict } from '../scripts/workerd-parity-verdict.ts';

// The shape of the workflows a release depends on: release.yml keeps the release pull request open, Publish
// (publish.yml) ships what reaches main. ci-workflow.test.ts covers ci.yml's jobs and plan.
interface Step { name?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }
interface Job { needs?: string | string[]; if?: string; uses?: string; with?: Record<string, unknown>; environment?: string; permissions?: Record<string, string>; steps?: Step[] }
interface Workflow { on: Record<string, unknown>; permissions?: Record<string, string>; concurrency?: { group?: string; 'cancel-in-progress'?: unknown }; jobs: Record<string, Job> }

const directory = '.github/workflows';
const load = async (name: string): Promise<Workflow> => parse(await readFile(join(directory, name), 'utf8')) as Workflow;
const needs = (job: Job): string[] => job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
function job(workflow: Workflow, name: string): Job {
  const found = workflow.jobs[name];
  assert(found, `missing job ${name}`);
  return found;
}

test('the repository has exactly five workflows: ci.yml, publish.yml, release.yml, the manual #708 reproducer and workerd parity', async () => {
  assert.deepEqual((await readdir(directory)).sort(), ['ci.yml', 'publish.yml', 'release.yml', 'v8-jit-repro.yml', 'workerd-parity.yml']);
});

// #868: the workerd parity run needs the network, so it stays opt-in like the #708 reproducer. It never runs on a push
// or pull request, cannot write, is called by no other workflow, pins Wrangler, and cannot pass on a SKIP.
test('workerd-parity.yml is manually dispatched only, read-only, pins Wrangler and fails instead of skipping', async () => {
  const parity = await load('workerd-parity.yml');
  assert.deepEqual(Object.keys(parity.on), ['workflow_dispatch']);
  assert.deepEqual(parity.permissions, { contents: 'read' });
  for (const name of ['ci.yml', 'publish.yml', 'release.yml']) assert.doesNotMatch(await readFile(join(directory, name), 'utf8'), /workerd-parity/);
  const inputs = (parity.on.workflow_dispatch as { inputs: Record<string, { default: string }> }).inputs;
  assert.match(inputs.wrangler!.default, /^\d+\.\d+\.\d+$/, 'an exact Wrangler version, not latest');
  const steps = job(parity, 'parity').steps ?? [];
  const run = steps.find(step => step.run === 'npm run test:workerd');
  assert(run, 'runs npm run test:workerd, which builds first');
  assert.equal(run.env?.WORKERD_PARITY_REQUIRED, '1');
  assert.equal(run.env?.WRANGLER_VERSION, '${{ inputs.wrangler }}');
  assert.doesNotMatch(await readFile(join(directory, 'workerd-parity.yml'), 'utf8'), /continue-on-error|\|\| *true|retry/i);
});

test('npm run test:workerd builds dist/ before it compares (#868: a stale build once passed every case)', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
  assert.match(scripts['test:workerd']!, /^npm run build && node --import \.\/test\/scratch-tmpdir\.ts scripts\/workerd-parity\.ts$/);
});

// A direct `node scripts/workerd-parity.ts` (no npm_execpath) compares nothing: it must say SKIP with the reason, and
// fail when WORKERD_PARITY_REQUIRED=1. A run that compared zero requests, or fewer than it declared, never passes.
test('workerd parity never passes a run that compared nothing', () => {
  assert.deepEqual(comparisonVerdict(0, 0, 0).exitCode, 1);
  assert.deepEqual(comparisonVerdict(0, 37, 0), { line: 'FAIL: compared 0 of 37 requests', exitCode: 1 });
  assert.equal(comparisonVerdict(36, 37, 0).exitCode, 1);
  assert.equal(comparisonVerdict(37, 37, 2).exitCode, 1);
  assert.deepEqual(comparisonVerdict(37, 37, 0), { line: 'all 37 responses identical (status, headers except request id, body)', exitCode: 0 });
  assert.deepEqual(skipVerdict('no network', false), { line: 'SKIP: compared 0 requests: no network', exitCode: 0 });
  assert.equal(skipVerdict('no network', true).exitCode, 1);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'npm_execpath' && key !== 'WORKERD_PARITY_REQUIRED'));
  const direct = spawnSync(process.execPath, ['scripts/workerd-parity.ts'], { encoding: 'utf8', env });
  assert.equal(direct.status, 0);
  assert.match(direct.stdout, /^SKIP: compared 0 requests: npm_execpath is unset; run `npm run test:workerd`/);
  assert.doesNotMatch(direct.stdout, /SAME|identical/);
  const requiredRun = spawnSync(process.execPath, ['scripts/workerd-parity.ts'], { encoding: 'utf8', env: { ...env, WORKERD_PARITY_REQUIRED: '1' } });
  assert.equal(requiredRun.status, 1);
  assert.match(requiredRun.stdout, /^FAIL: compared 0 requests/);
});

// #708: a diagnostic that must stay opt-in. It never runs on a push or pull request, cannot write, is called by no
// other workflow (so no required check depends on it) and never hides a failure.
test('v8-jit-repro.yml is manually dispatched only, read-only and never masks a failure', async () => {
  const repro = await load('v8-jit-repro.yml');
  assert.deepEqual(Object.keys(repro.on), ['workflow_dispatch']);
  assert.deepEqual(repro.permissions, { contents: 'read' });
  for (const name of ['ci.yml', 'publish.yml', 'release.yml']) assert.doesNotMatch(await readFile(join(directory, name), 'utf8'), /v8-jit-repro/);
  const text = await readFile(join(directory, 'v8-jit-repro.yml'), 'utf8');
  assert.doesNotMatch(text, /continue-on-error|\|\| *true|retry/i);
});

test('release.yml keeps the release pull request open with release-please; it never tags, publishes or writes main', async () => {
  const release = await load('release.yml');
  assert.deepEqual(Object.keys(release.on).sort(), ['workflow_dispatch', 'workflow_run']);
  assert.deepEqual(release.on.workflow_run, { workflows: ['Publish release'], types: ['completed'], branches: ['main'] });
  assert.deepEqual(release.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(release.jobs), ['release-pr']);
  const pr = job(release, 'release-pr');
  assert.deepEqual(pr.permissions, { contents: 'write', 'pull-requests': 'write' });
  assert.equal(pr.environment, undefined, 'the release pull request never runs in the publishing environment');
  assert.equal((pr as Job & { env?: Record<string, string> }).env?.GH_TOKEN, '${{ secrets.RELEASE_PLEASE_TOKEN || github.token }}');
  // The CLI comes from its own lockfile, installed without scripts, and only ever opens pull requests (no github-release).
  const steps = pr.steps ?? [];
  assert(steps.some(step => step.run === 'npm ci --ignore-scripts --no-audit --no-fund' && (step as Step & { 'working-directory'?: string })['working-directory'] === '.github/release-please'));
  const tooling = JSON.parse(await readFile('.github/release-please/package.json', 'utf8')) as { dependencies: Record<string, string> };
  assert.match(tooling.dependencies['release-please']!, /^\d+\.\d+\.\d+$/, 'an exact release-please version');
  const lock = JSON.parse(await readFile('.github/release-please/package-lock.json', 'utf8')) as { packages: Record<string, { integrity?: string }> };
  for (const [path, entry] of Object.entries(lock.packages)) if (path) assert.match(entry.integrity ?? '', /^sha512-/, path);
  const runs = steps.map(step => step.run ?? '').join('\n');
  assert.match(runs, /\.github\/release-please\/node_modules\/\.bin\/release-please release-pr\s+--token="\$GH_TOKEN" --repo-url="\$GITHUB_REPOSITORY" --target-branch=main\s+--config-file=release-please-config\.json --manifest-file=\.release-please-manifest\.json/);
  assert.doesNotMatch(runs, /github-release|npx/);
  assert.match(runs, /npm install --package-lock-only --ignore-scripts/);
  assert.match(runs, /release-versions\.ts sync\n\s*node scripts\/release-versions\.ts check/);
  assert.match(runs, /git push origin "HEAD:\$BRANCH"/);
  assert.doesNotMatch(runs, /push origin (?:HEAD:)?main|npm publish|release-publish|gh release create/);
});

test('ci.yml is callable with a release input and is not triggered by pushes itself', async () => {
  const ci = await load('ci.yml');
  assert(!Object.hasOwn(ci.on, 'push'), 'main is verified by publish.yml calling ci.yml');
  for (const trigger of ['pull_request', 'merge_group', 'workflow_dispatch', 'schedule']) assert(Object.hasOwn(ci.on, trigger), trigger);
  const call = ci.on.workflow_call as { inputs: Record<string, { type: string; default: unknown }> };
  assert.deepEqual(Object.keys(call.inputs), ['release']);
  assert.equal(call.inputs.release!.type, 'boolean');
  assert.equal(call.inputs.release!.default, false);
  // Superseded pull request runs may be cancelled; a run that gates a release never is.
  assert.equal(ci.concurrency?.['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('publish.yml runs on main and by dispatch, one release at a time, never cancelled', async () => {
  const release = await load('publish.yml');
  assert.deepEqual(Object.keys(release.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual((release.on.push as { branches: string[] }).branches, ['main']);
  assert.equal(release.concurrency?.group, 'release');
  assert.equal(release.concurrency?.['cancel-in-progress'], false);
  assert.deepEqual(release.permissions, { contents: 'read' });
});

test('publish.yml jobs run in order plan -> ci -> build -> publish -> verify', async () => {
  const release = await load('publish.yml');
  const order = ['plan', 'ci', 'build', 'publish', 'verify'];
  assert.deepEqual(Object.keys(release.jobs), order);
  for (const [index, name] of order.entries()) {
    if (index === 0) assert.deepEqual(needs(job(release, name)), []);
    else assert(needs(job(release, name)).includes(order[index - 1]!), `${name} must need ${order[index - 1]}`);
  }
  const ci = job(release, 'ci');
  assert.equal(ci.uses, './.github/workflows/ci.yml');
  assert.equal(ci.with?.release, "${{ needs.plan.outputs.release == 'true' }}");
  assert.equal(job(release, 'build').if, "needs.plan.outputs.release == 'true'");
});

test('publish creates the GitHub Release, then checks the add-on URLs, then publishes core to npm', async () => {
  const publish = job(await load('publish.yml'), 'publish');
  const runs = (publish.steps ?? []).map(step => step.run ?? '');
  const at = (command: string): number => {
    const index = runs.findIndex(run => run.includes(command));
    assert(index >= 0, `publish does not run ${command}`);
    return index;
  };
  const github = at('release-publish.ts github'), urls = at('release-publish.ts urls'), npm = at('release-publish.ts npm');
  assert(github < urls && urls < npm, 'GitHub Release, then urls, then npm');
  assert(at('homebrew-urlcode') > npm && at('docker push') > npm, 'Homebrew and the image follow npm');
  // Each publishing step is named with its position, so a failed step is identifiable before re-running.
  const numbered = publish.steps!.map(step => step.name ?? '').filter(name => /^\d+\. /.test(name));
  assert.deepEqual(numbered.map(name => Number(name.split('.')[0])), [1, 2, 3, 4, 5]);
  assert.match(numbered[0]!, /GitHub Release/);
});

test('each publish.yml job holds only the permissions it needs', async () => {
  const release = await load('publish.yml');
  const build = job(release, 'build'), publish = job(release, 'publish'), verify = job(release, 'verify');
  assert.equal(build.permissions?.['id-token'], 'write');
  assert.equal(build.permissions?.attestations, 'write');
  assert.equal(build.permissions?.contents, 'read');
  assert.equal(publish.environment, 'release');
  assert.equal(publish.permissions?.contents, 'write');
  assert.equal(publish.permissions?.['id-token'], 'write');
  assert.equal(publish.permissions?.packages, 'write');
  assert.equal(verify.permissions?.issues, 'write');
  assert.equal(verify.permissions?.contents, 'read');
  for (const name of ['plan']) assert.equal(job(release, name).permissions, undefined, `${name} inherits read-only contents`);
  for (const [name, definition] of Object.entries(release.jobs)) {
    if (name === 'publish') continue;
    assert.notEqual(definition.permissions?.contents, 'write', `${name} must not write contents`);
    assert.equal(definition.environment, undefined, `only publish runs in the release environment`);
  }
  assert((build.steps ?? []).some(step => step.uses?.startsWith('actions/attest@') && step.with?.['subject-path'] === 'release/*'));
});

// docs/CI.md#third-party-actions: a tag can be moved to other code, a commit cannot; the comment names the release
// the SHA was taken from, so a reviewer and Dependabot can see which version it is.
// The repository's Actions policy runs only actions GitHub created or jimhoyd-com owns, pinned to a full SHA; any
// other action ends the whole run in startup_failure before a job starts. The project Action runs inside ci.yml.
test('every action is GitHub-created or jimhoyd-com-owned, pinned to a full commit SHA with its release in a comment', async () => {
  let pinned = 0;
  const files = [...(await readdir(directory)).map(name => join(directory, name)), 'action/action.yml'];
  for (const name of files) {
    for (const line of (await readFile(name, 'utf8')).split('\n')) {
      const uses = /^\s*(?:- )?uses: (\S+)(.*)$/.exec(line);
      if (!uses || uses[1]!.startsWith('./')) continue;
      assert.match(uses[1]!, /^(?:actions|github|jimhoyd-com)\/[\w./-]+@[0-9a-f]{40}$/, `${name}: ${line} is not an allowed owner pinned by SHA`);
      assert.match(uses[2]!, /^ # v\d+\.\d+\.\d+$/, `${name}: ${line}`);
      pinned++;
    }
  }
  assert(pinned > 0);
});
