import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { reproducible } from '../scripts/ci-build-fidelity.ts';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { containerSmokeScript } from '../scripts/ci-container-smoke.ts';

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

test('every job but the plan and the docs check needs the plan and skips only on its explicit outputs', async () => {
  const workflow = await ci();
  // Lane selection itself is evaluated in ci-lanes.test.ts; this is the wiring.
  for (const [name, definition] of Object.entries(workflow.jobs)) {
    if (['plan', 'docs', 'verify-complete'].includes(name)) continue;
    assert(([] as string[]).concat(definition.needs ?? []).includes('plan'), name);
    assert.match(definition.if ?? '', /^needs\.plan\.outputs\.lane != 'docs'(?: && needs\.plan\.outputs\.\w+ != 'false')?$/, name);
  }
  // The disk-full harness (#902) runs in every code lane, extension-only diffs included.
  for (const name of ['static', 'workspace-verify', 'disk-full']) {
    assert.deepEqual(workflowJob(workflow, name).needs, 'plan');
    assert.equal(workflowJob(workflow, name).if, "needs.plan.outputs.lane != 'docs'");
  }
  assert.deepEqual(workflowJob(workflow, 'workspace-integration').needs, ['plan', 'workspace-verify']);
  assert(Object.hasOwn(workflow.on, 'merge_group'));
});

test('workflow command bodies call the tested CI scripts', async () => {
  const workflow = await ci();
  assert(runs(workflow, 'build-fidelity').includes('npm run ci:build-fidelity'));
  assert(runs(workflow, 'container').includes('npm run ci:container-smoke'));
  // The disk-full harness (#902) runs on Linux against the built runtime and every built add-on.
  assert.equal((workflowJob(workflow, 'disk-full') as Job & { 'runs-on': string })['runs-on'], 'ubuntu-latest');
  assert.deepEqual(runs(workflow, 'disk-full').slice(-4), ['npm run build', 'node scripts/workspaces.ts run build', 'sudo mkdir -p /mnt/urlcode-disk-full && sudo mount -t tmpfs -o size=16m,mode=1777 tmpfs /mnt/urlcode-disk-full', 'npm run test:disk-full']);
  // It fills that tmpfs, which it finds through the step's environment.
  assert.equal(workflowJob(workflow, 'disk-full').steps.at(-1)!.env!.URLCODE_DISK_FULL_DIR, '/mnt/urlcode-disk-full');
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(scripts['ci:build-fidelity'], 'node scripts/ci-build-fidelity.ts');
  assert.equal(scripts['ci:container-smoke'], 'node scripts/ci-container-smoke.ts');
  assert.equal(scripts['test:disk-full'], 'node --import ./test/scratch-tmpdir.ts --test test/disk-full.integration.ts');
  const smoke = containerSmokeScript();
  for (const expected of ['recipes add typescript', 'build-typescript', '/_urlcode/ready', 'starters/default', 'examples/assets', 'trap \'docker logs urlcode; docker rm -f urlcode\' EXIT']) assert.match(smoke, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('build fidelity compares every tarball and the add-on pins, not the timestamped SBOM', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-fidelity-test-'));
  await writeFile(join(directory, 'SHA256SUMS'), ['b  jimhoyd-urlcode-auth-1.0.0.tgz', 'c  sbom.cdx.json', 'a  addons.json', 'd  jimhoyd-urlcode-1.0.0.tgz', 'e  urlcode.rb'].join('\n') + '\n');
  assert.deepEqual(await reproducible(directory), ['a  addons.json', 'b  jimhoyd-urlcode-auth-1.0.0.tgz', 'd  jimhoyd-urlcode-1.0.0.tgz']);
});

test('workflows time out jobs and use safe installs', async () => {
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
  assert(runs(workflow, 'verify').some(run => run.includes('--test-shard=${{ matrix.shard }}/3')));
  assert.deepEqual(workflowJob(workflow, 'verify').strategy!.matrix, { os: '${{ fromJSON(needs.plan.outputs.testOs) }}', node: '${{ fromJSON(needs.plan.outputs.node) }}', shard: [1, 2, 3] });
  // The operator-triggered compatibility workflow (workspace-integration.yml) was retired with the signed bundle
  // releases; cross-OS add-on installs run in ci.yml's workspace-integration job.
  await assert.rejects(readFile(join(directory, 'workspace-integration.yml'), 'utf8'), /ENOENT/);
});
