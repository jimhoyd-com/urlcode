import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

// The shape of the two workflows the release depends on. ci-workflow.test.ts covers ci.yml's jobs and plan.
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

test('the repository has exactly two workflows: ci.yml and release.yml', async () => {
  assert.deepEqual((await readdir(directory)).sort(), ['ci.yml', 'release.yml']);
});

test('ci.yml is callable with a release input and is not triggered by pushes itself', async () => {
  const ci = await load('ci.yml');
  assert(!Object.hasOwn(ci.on, 'push'), 'main is verified by release.yml calling ci.yml');
  for (const trigger of ['pull_request', 'merge_group', 'workflow_dispatch', 'schedule']) assert(Object.hasOwn(ci.on, trigger), trigger);
  const call = ci.on.workflow_call as { inputs: Record<string, { type: string; default: unknown }> };
  assert.deepEqual(Object.keys(call.inputs), ['release']);
  assert.equal(call.inputs.release!.type, 'boolean');
  assert.equal(call.inputs.release!.default, false);
  // Superseded pull request runs may be cancelled; a run that gates a release never is.
  assert.equal(ci.concurrency?.['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
});

test('release.yml runs on main and by dispatch, one release at a time, never cancelled', async () => {
  const release = await load('release.yml');
  assert.deepEqual(Object.keys(release.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual((release.on.push as { branches: string[] }).branches, ['main']);
  assert.equal(release.concurrency?.group, 'release');
  assert.equal(release.concurrency?.['cancel-in-progress'], false);
  assert.deepEqual(release.permissions, { contents: 'read' });
});

test('release.yml jobs run in order plan -> ci -> build -> publish -> verify -> template', async () => {
  const release = await load('release.yml');
  const order = ['plan', 'ci', 'build', 'publish', 'verify', 'template'];
  assert.deepEqual(Object.keys(release.jobs), order);
  for (const [index, name] of order.entries()) {
    if (index === 0) assert.deepEqual(needs(job(release, name)), []);
    else assert(needs(job(release, name)).includes(order[index - 1]!), `${name} must need ${order[index - 1]}`);
  }
  const ci = job(release, 'ci');
  assert.equal(ci.uses, './.github/workflows/ci.yml');
  assert.equal(ci.with?.release, "${{ needs.plan.outputs.release == 'true' }}");
  assert.equal(job(release, 'build').if, "needs.plan.outputs.release == 'true'");
  assert.equal(job(release, 'template').if, "needs.plan.outputs.stable == 'true'");
});

test('publish creates the GitHub Release, then checks the add-on URLs, then publishes core to npm', async () => {
  const publish = job(await load('release.yml'), 'publish');
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

test('each release job holds only the permissions it needs', async () => {
  const release = await load('release.yml');
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
  for (const name of ['plan', 'template']) assert.equal(job(release, name).permissions, undefined, `${name} inherits read-only contents`);
  for (const [name, definition] of Object.entries(release.jobs)) {
    if (name === 'publish') continue;
    assert.notEqual(definition.permissions?.contents, 'write', `${name} must not write contents`);
    assert.equal(definition.environment, undefined, `only publish runs in the release environment`);
  }
  assert((build.steps ?? []).some(step => step.uses?.startsWith('actions/attest@') && step.with?.['subject-path'] === 'release/*'));
});

test('every third-party action is pinned to a full commit SHA', async () => {
  for (const name of await readdir(directory)) {
    const workflow = await load(name);
    for (const [jobName, definition] of Object.entries(workflow.jobs)) {
      for (const step of definition.steps ?? []) {
        if (!step.uses || step.uses.startsWith('./')) continue;
        assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${name} ${jobName}: ${step.uses}`);
      }
    }
  }
});
