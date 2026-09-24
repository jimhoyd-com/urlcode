import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { SHARDS, checksMatrix, classify, diffRange, docsOnly, gate, platformChecks, shardMatrix, testMatrix, workspaceIntegrationMatrix, workspacePackageMatrix, workspacePackages } from '../scripts/ci-plan.ts';
import { identity, assertReleasePolicy, assertChannel, assertIntegrity, imageFromDockerfile, assertMainRun, assertCodeQLRun } from '../scripts/release.ts';

test('docs lane is narrow and mixed, unknown, executable or empty changes run fully', () => {
  for (const path of ['docs/CI.md', 'AGENTS.md', 'llms-full.txt']) assert(docsOnly([path]));
  for (const path of ['packages/core/src/runtime.ts', 'package-lock.json', 'docs/fixture.json', 'starters/default/AGENTS.md', '.github/workflows/ci.yml', 'packages/ui/README.md', 'unknown.md']) assert(!docsOnly(['docs/CI.md', path]));
  assert(!docsOnly([]));
  assert(!docsOnly(['docs/old.md', 'packages/core/src/renamed.ts']));
});
test('reviewed contributor prose joins the docs lane; package inputs do not', () => {
  for (const path of ['packages/ui/CONTRIBUTING.md', 'packages/auth/CODE_OF_CONDUCT.md', 'packages/admin/GOVERNANCE.md']) assert(docsOnly([path]), path);
  // Package READMEs, security, contract, status and changelog documents ship
  // inside a published tarball or are read by an agent surface.
  for (const path of [
    'packages/ui/README.md', 'packages/auth/SECURITY.md', 'packages/ui/CONTRACT.md',
    'packages/admin/IMPLEMENTATION-STATUS.md', 'packages/ui/CHANGELOG.md', 'packages/auth/AGENTS.md',
    'packages/auth/docs/JSON-API.md', 'skills/urlcode/SKILL.md', 'recipes/redirect/README.md',
  ]) assert(!docsOnly([path]), path);
  assert(docsOnly(['docs/README.md', 'packages/ui/CONTRIBUTING.md']));
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
  await write('packages/ui/CONTRIBUTING.md', 'one\n');
  await write('packages/core/src/runtime.ts', 'export const a = 1;\n');
  const start = commit('start');
  // The classifier reads the repository it runs in, as it does on the runner.
  // stderr is dropped because one case deliberately names a missing commit.
  const at = (event: string, base: string, head: string) => classify(event, base, head, range =>
    execFileSync('git', ['diff', '--no-renames', '--name-only', range, '--'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean));

  await write('docs/CI.md', 'two\n');
  await write('packages/ui/CONTRIBUTING.md', 'two\n');
  const prose = commit('prose only');
  assert.equal(at('push', start, prose).lane, 'docs');
  assert.equal(at('pull_request', start, prose).lane, 'docs');

  await write('packages/core/src/runtime.ts', 'export const a = 2;\n');
  await write('docs/CI.md', 'three\n');
  const mixed = commit('prose and code');
  assert.equal(at('push', prose, mixed).lane, 'full');
  // A main push spanning both commits is still mixed, not prose.
  assert.equal(at('push', start, mixed).lane, 'full');

  git('mv', 'docs/CI.md', 'packages/core/src/CI.ts');
  const renamed = commit('rename prose into source');
  const rename = at('push', mixed, renamed);
  assert.equal(rename.lane, 'full');
  assert.deepEqual(rename.paths?.sort(), ['docs/CI.md', 'packages/core/src/CI.ts']);

  git('rm', '-q', 'packages/core/src/CI.ts');
  const deletedCode = commit('delete source');
  assert.equal(at('push', renamed, deletedCode).lane, 'full');

  await write('unknown.md', 'x\n');
  const unknown = commit('unknown path');
  assert.equal(at('push', deletedCode, unknown).lane, 'full');

  git('rm', '-q', 'packages/ui/CONTRIBUTING.md');
  const deletedProse = commit('delete prose');
  assert.equal(at('push', unknown, deletedProse).lane, 'docs');

  // A commit this clone does not have selects full rather than throwing.
  assert.deepEqual(at('push', 'c'.repeat(40), deletedProse), { lane: 'full', paths: null });
});
test('required gate fails closed for failed, canceled, missing and unexpected skipped jobs', () => {
  const always = ['plan', 'docs'];
  const conditional = ['static', 'verify', 'checks', 'workspace-verify', 'workspace-integration', 'audit', 'action', 'build-fidelity', 'container'];
  for (const plan of ['docs', 'full']) {
    const results = Object.fromEntries([...always, ...conditional].map(name => [name, { result: plan === 'docs' && conditional.includes(name) ? 'skipped' : 'success' }]));
    gate(plan, results, plan === 'full');
    for (const name of [...always, ...conditional]) {
      const missing = { ...results }; delete missing[name];
      assert.throws(() => gate(plan, missing, plan === 'full'));
      for (const result of ['failure', 'cancelled', 'skipped']) {
        if (result === results[name]!.result) continue;
        assert.throws(() => gate(plan, { ...results, [name]: { result } }, plan === 'full'));
      }
    }
  }
  const routine = Object.fromEntries([...always, ...conditional].map(name => [name, { result: name === 'workspace-integration' ? 'skipped' : 'success' }]));
  gate('full', routine);
  assert.throws(() => gate('full', routine, true));
  assert.throws(() => gate('', {}));
});
test('workflow gate covers every producer and full jobs depend on the classifier', async () => {
  const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
  assert.deepEqual(workflow.jobs['verify-complete'].needs.sort(), Object.keys(workflow.jobs).filter(name => name !== 'verify-complete').sort());
  for (const name of ['static', 'verify', 'checks', 'workspace-verify', 'action', 'build-fidelity', 'container']) {
    assert.deepEqual(workflow.jobs[name].needs, 'plan');
    assert.equal(workflow.jobs[name].if, "needs.plan.outputs.lane == 'full'");
  }
  // Depends on `workspace-verify` as well as `plan`, since it needs every
  // workspace package already built.
  assert.deepEqual(workflow.jobs['workspace-integration'].needs, ['plan', 'workspace-verify']);
  assert.equal(workflow.jobs['workspace-integration'].if, "needs.plan.outputs.lane == 'full' && needs.plan.outputs.workspaceIntegration == 'true'");
  assert.equal(workflow.jobs['verify-complete'].if, 'always()');
  // The classifier needs the push SHAs as well as the pull-request ones, and
  // needs history deep enough to diff them.
  const plan = workflow.jobs.plan.steps.at(-1);
  assert.match(plan.env.BASE, /pull_request\.base\.sha \|\| github\.event\.before/);
  assert.match(plan.env.HEAD, /pull_request\.head\.sha \|\| github\.event\.after/);
  assert.equal(workflow.jobs.plan.steps[0].with['fetch-depth'], 0);
  // Documentation checks always run. Dependency advisories cannot change with
  // prose alone and run on every full or exact-release verification instead.
  assert.equal(workflow.jobs.docs.if, undefined);
  assert.equal(workflow.jobs.audit.needs, 'plan');
  assert.equal(workflow.jobs.audit.if, "needs.plan.outputs.lane == 'full'");
  // `container` is a required check by name: gating it on the plan must not rename or drop it.
  assert.equal(workflow.jobs.container.name, undefined);
});
test('every workflow job that runs steps has a timeout, and extension publishers serialize per tag', async () => {
  const directory = '.github/workflows';
  for (const name of (await readdir(directory)).filter(file => file.endsWith('.yml'))) {
    const workflow = parse(await readFile(join(directory, name), 'utf8'));
    // A job that only calls a reusable workflow (`uses:`) cannot set its own timeout.
    for (const [job, definition] of Object.entries(workflow.jobs as Record<string, { steps?: unknown; 'timeout-minutes'?: number }>)) {
      if (definition.steps !== undefined) assert.equal(typeof definition['timeout-minutes'], 'number', `${name} ${job}`);
    }
  }
  for (const name of ['extension-artifacts.yml', 'extension-bundles.yml']) {
    const { concurrency } = parse(await readFile(join(directory, name), 'utf8')).jobs.publish;
    assert.equal(concurrency['cancel-in-progress'], false, name);
  }
});
test('CI installs without lifecycle scripts and builds once, except build-fidelity', async () => {
  const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
  const runs = (job: string): string[] => workflow.jobs[job].steps.map((step: { run?: string }) => step.run).filter(Boolean);
  for (const job of Object.keys(workflow.jobs)) {
    const installs = runs(job).filter(run => /^npm (?:ci|install)\b/.test(run));
    if (job === 'build-fidelity') assert.deepEqual(installs, ['npm ci'], job);
    else for (const install of installs) assert.equal(install, 'npm ci --ignore-scripts', job);
    assert(runs(job).filter(run => run === 'npm run build').length <= 1, job);
  }
  // The example-project checks are an npm script contributors can run locally.
  assert(runs('checks').includes('npm run test:examples:built'));
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(scripts['test:examples'], 'npm run build && npm run test:examples:built');
});

// Expand a package script into the underlying commands it actually runs, so a
// composition can be compared against the flat script it replaced.
function expand(scripts: Record<string, string>, name: string): string[] {
  return (scripts[name] ?? assert.fail(`missing script ${name}`)).split('&&').map(part => part.trim())
    .flatMap(part => part.startsWith('npm run ') ? expand(scripts, part.slice('npm run '.length).trim()) : [part]);
}
test('CI runs each documentation check once while local `check` stays complete', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  const docs = expand(scripts, 'check:docs');
  const code = expand(scripts, 'check:code');
  // A developer running `npm run check` still gets every check, once each.
  assert.deepEqual(expand(scripts, 'check').sort(), [...docs, ...code].sort());
  assert.equal(new Set([...docs, ...code]).size, docs.length + code.length);
  assert.equal(docs.length, 9);

  const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
  const runs = (job: string): string[] => workflow.jobs[job].steps.map((step: { run?: string }) => step.run).filter(Boolean);
  // Docs lane: `static` is skipped, so the always-run `docs` job is the only
  // thing standing between prose and the documentation checks.
  assert(runs('docs').includes('npm run check:docs'));
  assert.equal(workflow.jobs.docs.if, undefined);
  // Full lane: `docs` still runs, and `static` adds exactly the remainder
  // rather than repeating the seven prose checks on the same commit.
  assert(runs('static').includes('npm run check:code'));
  for (const job of Object.keys(workflow.jobs)) assert(!runs(job).includes('npm run check'), job);
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
  assert.match(imageFromDockerfile(await readFile('packaging/container/Dockerfile', 'utf8')), /@sha256:/);
  const image = `node:26-slim@sha256:${'a'.repeat(64)}`;
  assert.equal(imageFromDockerfile(`FROM ${image}\n`), image);
  assert.equal(imageFromDockerfile(`FROM ${image} AS build\n`), image);
  for (const text of ['FROM node:26', `FROM ${image} AS build extra`, `FROM ${image} AS`, `RUN ${image}`]) assert.throws(() => imageFromDockerfile(text));
});
test('release gate requires a successful explicit release verification', () => {
  const pass = { head_sha: 'a', head_branch: 'main', event: 'schedule', conclusion: 'success' };
  assert.throws(() => assertMainRun([pass], 'a'));
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
  for (const path of ['packages/core/src/cli.ts', 'packages/core/src/runtime.ts', 'packages/auth/src/auth-store.ts', 'packages/admin/test/admin-http.test.ts', 'packages/ui/src/host/scaffold.ts', 'package-lock.json', '.github/workflows/ci.yml', 'unknown.ts']) {
    assert(platformChecks(['docs/CI.md', path]));
    assert.equal(testMatrix('pull_request', [path]).include.length, 5);
  }
  for (const paths of [null, []]) assert.equal(testMatrix('pull_request', paths).include.length, 5);
});
test('workspace checks use a dependency-aware plan and reserve Windows integration for release verification', async () => {
  const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
  assert(workflow.on.schedule.length > 0);
  assert.equal(workflow.jobs['workspace-verify'].strategy.matrix, '${{ fromJSON(needs.plan.outputs.workspacePackages) }}');
  assert.equal(workflow.jobs['workspace-integration'].strategy.matrix, '${{ fromJSON(needs.plan.outputs.workspaceIntegrationMatrix) }}');
  assert.equal(workflow.jobs.verify.strategy.matrix, '${{ fromJSON(needs.plan.outputs.shards) }}');
  assert.equal(workflow.jobs.checks.strategy.matrix, '${{ fromJSON(needs.plan.outputs.checks) }}');
  assert(workflow.jobs.verify.steps.some((step: { run?: string }) => step.run?.includes(`--test-shard=\${{ matrix.shard }}/${SHARDS}`)));
  assert.match(workflow.concurrency.group, /github.event_name/);

  assert.deepEqual(workspacePackages(['packages/admin/src/admin-ui.ts']), ['admin']);
  assert.deepEqual(workspacePackages(['packages/auth/src/auth-ui.ts']), ['auth', 'admin']);
  assert.deepEqual(workspacePackages(['packages/ui/src/kit.ts']), ['ui', 'auth', 'admin', 'forms']);
  assert.deepEqual(workspacePackages(['packages/store/src/store.ts']), ['store']);
  assert.deepEqual(workspacePackages(['packages/forms/src/forms.ts']), ['forms']);
  for (const paths of [null, [], ['packages/core/src/cli.ts'], ['package-lock.json'], ['.github/workflows/ci.yml']]) assert.deepEqual(workspacePackages(paths), ['ui', 'auth', 'admin', 'store', 'forms']);
  assert.equal(workspacePackageMatrix('pull_request', ['packages/admin/src/admin-ui.ts']).include.length, 5);
  // Known UI presentation changes use the three Linux Node legs; all four
  // affected extensions are still verified.
  assert.equal(workspacePackageMatrix('pull_request', ['packages/ui/src/kit.ts']).include.length, 12);

  for (const event of ['pull_request', 'push', 'schedule']) {
    assert.deepEqual(workspaceIntegrationMatrix(event).include, []);
  }
  const release = workspaceIntegrationMatrix('workflow_dispatch').include;
  assert.deepEqual(release, [
    { os: 'ubuntu-latest', node: '24' },
    { os: 'macos-latest', node: '24' },
    { os: 'windows-latest', node: '24' },
  ]);
  assert(release.some(leg => leg.os === 'windows-latest' && leg.node === '24'));
});

test('candidate selection refuses newer failed or pending runs and wrong sources', async () => {
  const { candidateRun, requireOriginal } = await import('../scripts/release-artifacts.ts');
  const run = { id: 1, head_sha: 'a', head_branch: 'main', event: 'workflow_dispatch', conclusion: 'success' };
  assert.equal(candidateRun([run], 'a').id, 1);
  assert.equal(candidateRun([{ ...run, head_branch: 'codex/release-validation/a' }], 'a').id, 1);
  for (const runs of [[], [{ ...run, head_sha: 'b' }], [{ ...run, head_branch: 'feature' }], [{ ...run, conclusion: null }, run], [{ ...run, conclusion: 'failure' }, run]]) assert.throws(() => candidateRun(runs, 'a'));
  requireOriginal(1, false, false);
  requireOriginal(2, true, false);
  requireOriginal(2, false, true);
  assert.throws(() => requireOriginal(2, false, false), /Refusing to rebuild/);
  assert.throws(() => requireOriginal(NaN, false, false));
});

test('candidate validation rejects missing, malformed, wrong-SHA and modified bundles', async t => {
  const { validateCandidate } = await import('../scripts/release-artifacts.ts');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-artifact-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packages = ['.', 'packages/ui', 'packages/auth', 'packages/admin', 'packages/store'].map((directory, index) => identity(`@test/package${index}`, '1.0.0-alpha.1', directory));
  const sha = 'a'.repeat(40), bytes = Buffer.from('measured archive');
  const assets: Record<string, Buffer> = Object.fromEntries(packages.map(pkg => [pkg.tarball, bytes]));
  assets['sbom.cdx.json'] = Buffer.from('{}'); assets['supply-chain-triage.json'] = Buffer.from('{}'); assets['urlcode.rb'] = Buffer.from('formula');
  assets['train.json'] = Buffer.from(JSON.stringify({ sourceCommit: sha, packages: packages.map(pkg => ({ name: pkg.name, version: pkg.version, filename: pkg.tarball, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, channel: pkg.channel, peerDependencies: pkg.peers })) }));
  const digests = Object.fromEntries(Object.entries(assets).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')]));
  for (const [name, bytes] of Object.entries(assets)) await writeFile(join(directory, name), bytes);
  const manifest = JSON.stringify({ sourceCommit: sha, channel: 'candidate', candidateRun: '42', artifacts: digests });
  await writeFile(join(directory, 'manifest.json'), manifest);
  await writeFile(join(directory, 'SHA256SUMS'), Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${hash}  ${name}`).join('\n') + '\n');
  await validateCandidate(directory, sha, packages, 42);
  await assert.rejects(validateCandidate(directory, sha, packages, 43), /immutable tag pin/);
  await assert.rejects(validateCandidate(directory, 'b'.repeat(40), packages), /source SHA/);
  await writeFile(join(directory, 'manifest.json'), '{}');
  await assert.rejects(validateCandidate(directory, sha, packages));
  await writeFile(join(directory, 'manifest.json'), manifest);
  await writeFile(join(directory, packages[0]!.tarball), 'changed');
  await assert.rejects(validateCandidate(directory, sha, packages), /hash mismatch/);
  await rm(join(directory, packages[0]!.tarball));
  await assert.rejects(validateCandidate(directory, sha, packages), /missing candidate files/);
});


test('CodeQL gate requires newest analysis and cannot mask failures with old or aggregate successes', () => {
  const pass = { id: 1, name: 'CodeQL', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 10 } };
  assertCodeQLRun([pass]);
  for (const conclusion of ['failure', 'cancelled', null]) {
    assert.throws(() => assertCodeQLRun([pass, { ...pass, id: 2, conclusion, check_suite: { id: 11 } }]), /Latest CodeQL/);
  }
  assert.throws(() => assertCodeQLRun([]));
  assert.throws(() => assertCodeQLRun([{ ...pass, app: { slug: 'untrusted-app' } }]));
  assert.throws(() => assertCodeQLRun([{ ...pass, name: 'unit tests' }]));
  const failedAnalysis = { ...pass, id: 2, name: 'Analyze (javascript-typescript)', conclusion: 'failure' };
  assert.throws(() => assertCodeQLRun([failedAnalysis, { ...pass, id: 3 }]), /unsuccessful Analyze/);
  assertCodeQLRun([failedAnalysis, { ...pass, id: 3, check_suite: { id: 11 } }]);
  assertCodeQLRun([{ ...failedAnalysis, id: 4, conclusion: 'success' }, failedAnalysis, { ...pass, id: 3 }]);
});


test('stable policy exits prerelease mode and rejects mismatched channel state', () => {
  const stable = [identity('@jimhoyd/urlcode', '0.4.1', '.')];
  const alpha = [identity('@jimhoyd/urlcode', '0.4.0-alpha.3', '.')];
  assertReleasePolicy(stable, null);
  assertReleasePolicy(alpha, { mode: 'pre', tag: 'alpha' });
  assertReleasePolicy([...stable, ...alpha], { mode: 'pre', tag: 'alpha' });
  assert.throws(() => assertReleasePolicy(alpha, null), /require explicit/);
  assert.throws(() => assertReleasePolicy(stable, { mode: 'pre', tag: 'alpha' }), /must match/);
  assert.throws(() => assertReleasePolicy(stable, { mode: 'exit', tag: 'alpha' }), /Unsupported/);
});

test('every leg has every shard, and the reduced PR set is only Ubuntu 24 running examples', () => {
  assert.equal(SHARDS, 3);
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
    const legs = testMatrix(event, null).include, shards = shardMatrix(event, null).include;
    assert.equal(shards.length, legs.length * SHARDS);
    for (const leg of legs) assert.deepEqual(shards.filter(s => s.os === leg.os && s.node === leg.node).map(s => s.shard), [1, 2, 3]);
    const checks = checksMatrix(event, null).include;
    assert.deepEqual(checks.map(({ os, node }) => ({ os, node })), legs);
    const full = checks.filter(c => c.full).map(c => `${c.os}/${c.node}`);
    if (['pull_request', 'push'].includes(event)) assert.deepEqual(full, ['ubuntu-latest/24']);
    else assert.equal(full.length, 9);
  }
});
