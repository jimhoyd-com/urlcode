import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SOURCE_PACKAGES, assertSourceManifest } from '../scripts/ci-build-fidelity.ts';
import { containerSmokeScript } from '../scripts/ci-container-smoke.ts';
import { SHARDS } from '../scripts/ci-plan.ts';

interface Step { run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job {
  steps: Step[];
  needs?: string | string[];
  if?: string;
  strategy?: { matrix: unknown };
}
interface Workflow { name?: string; jobs: Record<string, Job>; on: Record<string, unknown> }

async function ci(): Promise<Workflow> {
  return parse(await readFile('.github/workflows/ci.yml', 'utf8')) as Workflow;
}
function runs(workflow: Workflow, job: string): string[] {
  return workflowJob(workflow, job).steps.map(step => step.run).filter((run): run is string => run !== undefined);
}
function workflowJob(workflow: Workflow, name: string): Job {
  const job = workflow.jobs[name];
  assert(job, `missing ${name}`);
  return job;
}

test('CI gate covers every producer and all conditional jobs depend on the plan', async () => {
  const workflow = await ci();
  assert.deepEqual([...(workflowJob(workflow, 'verify-complete').needs as string[])].sort(), Object.keys(workflow.jobs).filter(name => name !== 'verify-complete').sort());
  for (const name of ['static', 'workspace-verify']) {
    assert.deepEqual(workflowJob(workflow, name).needs, 'plan');
    assert.equal(workflowJob(workflow, name).if, "needs.plan.outputs.lane == 'full'");
  }
  for (const name of ['verify', 'checks', 'audit']) assert.equal(workflowJob(workflow, name).if, "needs.plan.outputs.lane == 'full' && needs.plan.outputs.coreChecks == 'true'");
  assert.equal(workflowJob(workflow, 'action').if, "needs.plan.outputs.lane == 'full' && needs.plan.outputs.action == 'true'");
  for (const [name, output] of [['build-fidelity', 'buildFidelity'], ['container', 'container']] as const) assert.equal(workflowJob(workflow, name).if, `needs.plan.outputs.lane == 'full' && needs.plan.outputs.${output} == 'true'`);
  assert.deepEqual(workflowJob(workflow, 'workspace-integration').needs, ['plan', 'workspace-verify']);
  assert.equal(workflowJob(workflow, 'workspace-integration').if, "needs.plan.outputs.lane == 'full' && needs.plan.outputs.workspaceIntegration == 'true'");
  assert.equal(workflowJob(workflow, 'verify-complete').if, 'always()');
  const plan = workflowJob(workflow, 'plan').steps.at(-1)!;
  assert.match(plan.env!.BASE!, /pull_request\.base\.sha \|\| github\.event\.before/);
  assert.match(plan.env!.HEAD!, /pull_request\.head\.sha \|\| github\.event\.after/);
  assert.equal(workflowJob(workflow, 'plan').steps[0]!.with!['fetch-depth'], 0);
  assert(Object.hasOwn(workflow.on, 'merge_group'));
});

test('workflow command bodies call the tested CI scripts', async () => {
  const workflow = await ci();
  assert(runs(workflow, 'build-fidelity').includes('npm run ci:build-fidelity'));
  assert(runs(workflow, 'container').includes('npm run ci:container-smoke'));
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(scripts['ci:build-fidelity'], 'node scripts/ci-build-fidelity.ts');
  assert.equal(scripts['ci:container-smoke'], 'node scripts/ci-container-smoke.ts');
  const smoke = containerSmokeScript();
  for (const expected of ['recipes add typescript', 'build-typescript', '/_urlcode/ready', 'starters/default', 'examples/assets', 'trap \'docker logs urlcode; docker rm -f urlcode\' EXIT']) assert.match(smoke, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('source-package manifest validation rejects missing or reordered archives', () => {
  const directory = '/tmp/source';
  const manifest = { packages: SOURCE_PACKAGES.map((name, index) => ({ name, filename: `${index}.tgz` })) };
  assert.doesNotThrow(() => assertSourceManifest(manifest, directory, path => /^\/tmp\/source\/\d+\.tgz$/.test(path)));
  assert.throws(() => assertSourceManifest({ packages: [...manifest.packages].reverse() }, directory, () => true), /unexpected packages/);
  assert.throws(() => assertSourceManifest(manifest, directory, () => false), /missing 0.tgz/);
});

test('workflows time out jobs, use safe installs, and retain the public compatibility shape', async () => {
  const directory = '.github/workflows';
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.yml'))) {
    const workflow = parse(await readFile(join(directory, name), 'utf8')) as Workflow;
    for (const [job, definition] of Object.entries(workflow.jobs as Record<string, { steps?: unknown; 'timeout-minutes'?: number }>)) {
      if (definition.steps !== undefined) assert.equal(typeof definition['timeout-minutes'], 'number', `${name} ${job}`);
    }
  }
  const workflow = await ci();
  for (const job of Object.keys(workflow.jobs)) {
    const installs = runs(workflow, job).filter(run => /^npm (?:ci|install)\b/.test(run));
    if (job === 'build-fidelity') assert.deepEqual(installs, ['npm ci']);
    else for (const install of installs) assert.equal(install, 'npm ci --ignore-scripts', job);
  }
  assert(runs(workflow, 'verify').some(run => run.includes(`--test-shard=\${{ matrix.shard }}/${SHARDS}`)));
  const compatibility = parse(await readFile('.github/workflows/workspace-integration.yml', 'utf8')) as Workflow;
  assert.equal(compatibility.name, 'Verify — compatibility');
  assert.deepEqual((workflowJob(compatibility, 'integration').strategy!.matrix as { include: unknown }).include, [
    { os: 'ubuntu-latest', node: '24' }, { os: 'macos-latest', node: '24' }, { os: 'windows-latest', node: '24' },
  ]);
});
