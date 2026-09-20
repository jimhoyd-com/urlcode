import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { docsOnly, gate } from '../scripts/ci-plan.ts';
import { identity, assertChannel, assertIntegrity, imageFromDockerfile, assertMainRun } from '../scripts/release.ts';

test('docs lane is narrow and mixed, unknown, executable or empty changes run fully', () => {
  for (const path of ['docs/CI.md', 'AGENTS.md', 'llms-full.txt']) assert(docsOnly([path]));
  for (const path of ['src/runtime.ts', 'package-lock.json', 'docs/fixture.json', 'starters/default/AGENTS.md', '.github/workflows/ci.yml', 'packages/ui/README.md', 'unknown.md']) assert(!docsOnly(['docs/CI.md', path]));
  assert(!docsOnly([]));
  assert(!docsOnly(['docs/old.md', 'src/renamed.ts']));
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
  const pass = { head_sha: 'a', head_branch: 'main', event: 'push', conclusion: 'success' };
  assertMainRun([pass], 'a');
  for (const runs of [[], [{ ...pass, head_sha: 'b' }], [{ ...pass, conclusion: null }], [{ ...pass, conclusion: 'cancelled' }], [{ ...pass, conclusion: 'failure' }, pass], [{ ...pass, event: 'pull_request' }]]) assert.throws(() => assertMainRun(runs, 'a'));
  assertMainRun([{ ...pass, event: 'workflow_dispatch', head_branch: 'v1.0.0' }], 'a');
});
