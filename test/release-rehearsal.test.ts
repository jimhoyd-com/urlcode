// Release rehearsal (#365). Three attempts at 0.4.3-0.4.7 failed at steps ordinary CI never
// exercised: git refusing a foreign-owned checkout, the tag publisher's peer-floor
// preflight, and a commit with no git identity. These tests run those steps the way a release
// container or runner reaches them, offline and in a few seconds, so `npm test` finds the
// failure before a release does. What this cannot reach is listed in docs/DEVELOPMENT-PIPELINE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import semver from 'semver';
import { parse } from 'yaml';
import { directories, inventory } from '../scripts/release.ts';
import { assertPeerFloorCoversApi, coreName, peerApiViolations, raisedCorePeer, scaffoldApiUsed } from '../scripts/peer-api.ts';

const node = process.execPath;
// An empty file rather than the null device: Git for Windows cannot open `\\.\nul` as a config path.
const emptyConfig = join(mkdtempSync(join(tmpdir(), 'urlcode-empty-gitconfig-')), 'config');
writeFileSync(emptyConfig, '');
// git honours this variable to treat the repository as owned by someone else, which is what
// the candidate container sees for the source mounted at /source (#351, #284).
// A runner's checkout action (and a developer's config) may already mark the workspace a
// safe.directory globally, which would hide the failure, so no global or system config is read.
const foreignOwner = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1', GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };

test('the foreign-owner simulation is live: plain git refuses this checkout', () => {
  // If git stops honouring the variable, the next test would pass without proving anything.
  const result = spawnSync('git', ['ls-files'], { env: foreignOwner, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'git accepted the checkout despite GIT_TEST_ASSUME_DIFFERENT_OWNER');
  assert.match(result.stderr, /dubious ownership/);
});
test('the git-touching check scripts run in a checkout another user owns', () => {
  const steps: [string, string[]][] = [
    ['tracked NUL scan (npm run check)', ['--input-type=module', '-e', "const { trackedTextFilesWithNul } = await import('./scripts/nul-scan.ts'); const found = await trackedTextFilesWithNul(process.cwd()); if (found.length) throw new Error(found.join())"]],
    ['release manifests and lockfile (release:check)', ['scripts/release.ts', 'check']],
    ['release metadata (release:check)', ['scripts/release-prepare.ts', '--check']],
    ['release tags (check:code)', ['scripts/check-release-tags.ts']],
    ['workspace links (check:code)', ['scripts/check-workspace-links.ts']],
  ];
  for (const [label, args] of steps) {
    const result = spawnSync(node, args, { env: foreignOwner, encoding: 'utf8' });
    assert.equal(result.status, 0, `${label} fails when git sees a foreign owner:\n${result.stderr}`);
  }
});

// A runner or release container has no git identity. This is that environment, made hostile
// on purpose: the developer machine may inject one through the environment, and git can
// otherwise guess a name from the login and host, so guessing is switched off.
async function noIdentity(): Promise<{ env: NodeJS.ProcessEnv; home: string }> {
  const home = await mkdtemp(join(tmpdir(), 'urlcode-no-identity-'));
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(?:GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG|EMAIL$|HOME$|USERPROFILE$|XDG_CONFIG_HOME$)/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_SYSTEM: emptyConfig, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true',
  });
  return { env, home };
}
test('the release commit path needs no ambient git identity', async t => {
  const { releaseIdentity } = await import('../scripts/release-identity.ts');
  const { env, home } = await noIdentity();
  t.after(() => rm(home, { recursive: true, force: true }));
  const git = (args: string[]) => spawnSync('git', args, { cwd: home, env, encoding: 'utf8' });
  assert.equal(git(['init', '-q', '-b', 'main']).status, 0);
  await writeFile(join(home, 'file.txt'), 'one\n');
  assert.equal(git(['add', '.']).status, 0);
  // Control: without the release identity this environment cannot commit (#376).
  const plain = git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'plain']);
  assert.notEqual(plain.status, 0, 'the environment still supplies an identity; the rehearsal proves nothing');
  const released = git([...releaseIdentity, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Prepare release']);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(git(['log', '-1', '--format=%an <%ae>']).stdout.trim(), 'urlcode-release <urlcode-release@users.noreply.github.com>');
});
test('every commit a release script makes carries the release identity', async () => {
  let commits = 0;
  for (const file of (await readdir('scripts')).filter(name => /\.(?:ts|mjs)$/.test(name))) {
    const source = await readFile(join('scripts', file), 'utf8');
    const all = source.match(/['"]commit['"],\s*['"]-m['"]/g)?.length ?? 0;
    const withIdentity = source.match(/\.\.\.releaseIdentity,\s*['"]commit['"],\s*['"]-m['"]/g)?.length ?? 0;
    assert.equal(withIdentity, all, `scripts/${file} commits without ...releaseIdentity (scripts/release-identity.ts)`);
    commits += all;
  }
  assert(commits >= 2, 'expected the release PR and starter pin commits');
});

// The tag publisher's preflight calls assertPeerFloorCoversApi for the package it releases,
// with the peer ranges in that package's manifest. Between releases the extensions'
// floors are legitimately below the API they use until release-prepare raises them, so the
// rehearsal checks the state release-prepare would leave, not the raw manifests.
test('publisher peer-floor preflight passes for every package in the prepared state', async () => {
  const core = (await inventory()).find(pkg => pkg.name === coreName)!;
  const packages = await inventory();
  assert.deepEqual(packages.map(pkg => pkg.directory), [...directories]);
  for (const pkg of packages) {
    const uses = await scaffoldApiUsed('.', pkg.directory);
    // Core has no peer on itself and is held to no floor (#370, the 0.4.4 failure).
    const raised = pkg.name === coreName ? undefined : raisedCorePeer(pkg.name, uses, pkg.peers, core.version);
    const prepared = raised ? { ...pkg.peers, [coreName]: raised } : pkg.peers;
    await assertPeerFloorCoversApi('.', pkg.directory, pkg.name, prepared);
    for (const [name, range] of Object.entries(prepared)) assert(semver.minVersion(range), `${pkg.name}: invalid peer range ${name} ${range}`);
  }
});
test('the rehearsal has teeth: a floor below the API in use, or core held to a floor, fails', async () => {
  const uses = await scaffoldApiUsed('.', 'packages/store');
  assert(uses.length > 0, 'the store no longer uses newer core API; pick another package to prove the guard');
  await assert.rejects(assertPeerFloorCoversApi('.', 'packages/store', '@jimhoyd/urlcode-store', { [coreName]: '>=0.4.2 <0.5.0' }), /peer floor/);
  assert.equal(peerApiViolations(await scaffoldApiUsed('.', '.'), undefined).length > 0, true, 'core sources use API newer than 0.4.2');
  await assertPeerFloorCoversApi('.', '.', coreName, undefined);
});
test('a release commit is preflighted with its real, unadjusted peer floors', async () => {
  // main after a "Prepare release" merge is what the tag publisher checks out. The prepared
  // state above cannot be wrong there: this holds the actual manifests to the guard.
  let subject = '';
  try { subject = execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout with history */ }
  if (!/^Prepare (?:core |ui |auth |admin |store )?release /.test(subject)) return;
  for (const pkg of await inventory()) await assertPeerFloorCoversApi('.', pkg.directory, pkg.name, pkg.peers);
});

test('the rehearsal workflow is manual, read-only and pinned like the rest', async () => {
  const text = await readFile('.github/workflows/release-rehearsal.yml', 'utf8');
  const workflow = parse(text);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const job = Object.values(workflow.jobs)[0] as { permissions?: unknown; steps: { uses?: string; run?: string }[] };
  assert.equal(job.permissions, undefined);
  for (const step of job.steps) if (step.uses) assert.match(step.uses, /@[0-9a-f]{40}$/, step.uses);
  const runs = job.steps.map(step => step.run ?? '');
  assert(runs.includes('npm run rehearse:release'));
  assert(runs.includes('bash scripts/prepare-core-release.sh'));
  // It rehearses; it never signs, uploads, tags or publishes.
  assert.doesNotMatch(text, /attest|upload-artifact|id-token|--execute|npm publish|release:publish|gh release|git push/);
  // The candidate container steps it rehearses are the ones candidate.yml runs.
  assert.match(await readFile('.github/workflows/candidate.yml', 'utf8'), /bash scripts\/prepare-core-release\.sh/);
});
