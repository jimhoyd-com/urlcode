import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
interface Input { required?: boolean }
interface Step { uses?: string }
interface Job {
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  steps?: Step[];
  'timeout-minutes'?: number;
  [key: string]: unknown;
}
interface Workflow {
  on: {
    workflow_call?: { inputs: Record<string, Input>; secrets: Record<string, Input> };
    workflow_dispatch?: { inputs: Record<string, Input> };
    push?: unknown;
    schedule?: unknown;
  };
  permissions?: Record<string, string>;
  concurrency?: Record<string, string | boolean>;
  jobs: Record<string, Job>;
}
const load = async (name: string): Promise<Workflow> => parse(await readFile(new URL(`.github/workflows/${name}`, root), 'utf8')) as Workflow;

test('shared manual release coordinator is serialized, main-only and uses a non-bypass token', async () => {
  const workflow = await load('release-dispatch.yml');
  const call = workflow.on.workflow_call; assert(call);
  assert.deepEqual(Object.keys(call.inputs).sort(), ['consume_changesets', 'version']);
  assert.equal(call.secrets.RELEASE_AUTOMATION_TOKEN?.required, true);
  const permissions = workflow.permissions; assert(permissions);
  const concurrency = workflow.concurrency; assert(concurrency);
  assert.equal(permissions.contents, 'read');
  assert.equal(concurrency.group, 'release-coordinator');
  assert.equal(concurrency['cancel-in-progress'], false);
  const job = workflow.jobs.release!;
  assert.equal(job['timeout-minutes'], 120);
  const text = JSON.stringify(job);
  assert.match(text, /refs\/heads\/main/);
  assert.match(text, /gh auth setup-git/);
  assert.match(text, /npm run release:run/);
  assert.match(text, /RELEASE_AUTOMATION_TOKEN/);
  assert.doesNotMatch(text, /--admin|pull-requests:\s*write|contents:\s*write/);
  for (const step of (job.steps ?? []).filter(step => step.uses)) {
    assert.match(step.uses!, /^[^@]+@[a-f0-9]{40}$/, `Action must be SHA pinned: ${step.uses}`);
  }
});

test('Actions exposes guarded core and extension release buttons', async () => {
  const workflow = await load('release-core-dispatch.yml');
  const dispatch = workflow.on.workflow_dispatch; assert(dispatch);
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.schedule, undefined);
  assert.equal(dispatch.inputs.version?.required, true);
  const job = workflow.jobs.release!;
  assert.equal(job.uses, './.github/workflows/release-dispatch.yml');
  assert.equal(job.secrets?.RELEASE_AUTOMATION_TOKEN, '${{ secrets.RELEASE_AUTOMATION_TOKEN }}');
  for (const retired of ['release-all-dispatch.yml', 'release-ui-dispatch.yml', 'release-auth-dispatch.yml', 'release-admin-dispatch.yml', 'release-store-dispatch.yml']) {
    await assert.rejects(load(retired));
  }

  const bundles = await load('extension-bundles.yml');
  const bundleDispatch = bundles.on.workflow_dispatch; assert(bundleDispatch);
  assert.equal(bundleDispatch.inputs.version?.required, true);
  assert(bundles.on.push);
  // A dispatch from main only creates the tag and re-dispatches on it: the attestation records the run's ref, and
  // the CLI verifies --source-ref refs/tags/<release>, so nothing may be built or signed on refs/heads/main (#579).
  const tagger = bundles.jobs.tag!;
  const taggerText = JSON.stringify(tagger);
  assert.match(String(tagger.if), /workflow_dispatch/);
  assert.match(String(tagger.if), /github\.ref_type == 'branch'/);
  assert.equal(tagger.environment, 'release');
  assert.deepEqual(tagger.permissions, { contents: 'write', actions: 'write' });
  assert.match(taggerText, /extension-bundle-release\.ts tag/);
  assert.doesNotMatch(taggerText, /actions\/attest|gh release create/);
  const publisher = bundles.jobs.publish!;
  const publisherText = JSON.stringify(publisher);
  assert.equal(publisher.if, "github.ref_type == 'tag'");
  assert.equal(publisher.environment, 'release');
  assert.match(publisherText, /cancel-in-progress/);
  assert.match(publisherText, /extension-bundle-release\.ts source/);
  assert.doesNotMatch(publisherText, /git update-ref|refs\/heads\/main/);
  assert.match(publisherText, /extension-bundle-release\.ts publish/);
  // The CLI's own verification policy gates publication and re-checks the published assets.
  const names = (publisher.steps ?? []).map(step => (step as { name?: string }).name);
  const verify = names.indexOf('Refuse to publish what the CLI would refuse to install'), publish = names.indexOf('Publish immutable release assets'), after = names.indexOf('Verify the published release with the CLI policy');
  assert.ok(names.indexOf('Attest each bundle') < verify && verify < publish && publish < after, names.join(', '));
  assert.equal(publisherText.match(/extension-bundle-release\.ts verify-(?:local|published)/g)?.length, 2);
  for (const step of (publisher.steps ?? []).filter(step => step.uses)) {
    assert.match(step.uses!, /^[^@]+@[a-f0-9]{40}$/, `Action must be SHA pinned: ${step.uses}`);
  }
});
