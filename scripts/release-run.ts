// Explicit maintainer opt-in: no publication or remote mutation without --execute.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { inventory, registry, validateMain, assertChannel } from './release.ts';
import type { ReleasePackage } from './release.ts';
import { waitForInstallability, verifyPublishedTrain } from './release-installability.ts';
import { updateTemplate, assertTemplateCurrent } from './release-template.ts';
import { pinnedCandidateRun, verifyCandidateRun } from './release-artifacts.ts';
import type { CandidatePin } from './release-artifacts.ts';
import { directoriesForScope, receiptPath } from './release-prepare.ts';
import type { ReleaseScope } from './release-prepare.ts';

export interface WorkflowRun { id: number; head_sha: string; head_branch: string; event: string; status: string; conclusion: string | null }
export interface Check { name?: string; context?: string; status?: string; conclusion?: string | null; state?: string }
export function checkState(checks: Check[], requireCore: boolean): 'pending' | 'passed' | 'failed' {
  if (checks.some(check => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(check.conclusion ?? check.state ?? ''))) return 'failed';
  if (!checks.length || checks.some(check => (check.status && check.status !== 'COMPLETED') || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion ?? check.state ?? ''))) return 'pending';
  if (requireCore) {
    for (const name of ['verify-complete', 'container']) if (!checks.some(check => check.name === name && check.conclusion === 'SUCCESS')) return 'pending';
    if (!checks.some(check => /^(CodeQL|Analyze \(javascript-typescript\))/.test(check.name ?? check.context ?? '') && (check.conclusion ?? check.state) === 'SUCCESS')) return 'pending';
  }
  return 'passed';
}
export function selectedRun(runs: WorkflowRun[], sha: string, kind: 'ci' | 'candidate'): WorkflowRun | undefined {
  return runs.find(run => run.head_sha === sha && (kind === 'ci'
    ? (run.event === 'workflow_dispatch' || (run.event === 'schedule' && run.head_branch === 'main'))
    : run.event === 'workflow_dispatch' && ['main', `codex/release-validation/${sha}`].includes(run.head_branch)));
}
export function packageState(published: boolean, tagSha: string | undefined, sha: string): 'pending' | 'resume' | 'unchanged' {
  if (tagSha && tagSha !== sha) {
    assert(published, 'Unpublished version is already tagged at another commit; use that commit or prepare a new version');
    return 'unchanged';
  }
  assert(!published || tagSha, 'Published version has no release tag; inspect and repair release state explicitly');
  return tagSha === sha ? 'resume' : 'pending';
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const command = (program: string, args: string[], cwd = process.cwd()) => execFileSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const gh = <T>(args: string[], cwd?: string): T => JSON.parse(command('gh', args, cwd)) as T;
const api = <T>(path: string) => gh<T>(['api', path]);
const run = (program: string, args: string[], cwd = process.cwd()) => execFileSync(program, args, { cwd, stdio: 'inherit' });
function npm(args: string[], cwd = process.cwd()): void {
  assert(process.env.npm_execpath, 'Run through npm run release:run');
  run(process.execPath, [process.env.npm_execpath, ...args], cwd);
}
function emit(phase: string, detail: unknown): void { console.log(JSON.stringify({ phase, detail })); }
function clean(cwd = process.cwd()): void { assert.equal(command('git', ['status', '--porcelain'], cwd), '', 'Release requires a clean checkout; preserve or commit your work first'); }
function runs(repo: string, workflow: string, sha: string): WorkflowRun[] {
  return api<{ workflow_runs: WorkflowRun[] }>(`repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&per_page=100`).workflow_runs;
}
async function watch(repo: string, id: number): Promise<void> {
  emit('waiting', `https://github.com/${repo}/actions/runs/${id}`);
  run('gh', ['run', 'watch', String(id), '--repo', repo, '--exit-status']);
}
export async function waitAndMerge(repo: string, number: number, expectedHead: string, requireCore: boolean, beforeMerge?: () => boolean): Promise<string | undefined> {
  for (let attempt = 0; attempt < 240; attempt++) {
    const pr = gh<{ state: string; headRefOid: string; mergeCommit: { oid: string } | null; statusCheckRollup: Check[]; mergeable: string }>(['pr', 'view', String(number), '--repo', repo, '--json', 'state,headRefOid,mergeCommit,statusCheckRollup,mergeable']);
    assert.equal(pr.headRefOid, expectedHead, 'PR head changed while waiting; inspect and resume deliberately');
    if (pr.state === 'MERGED') { assert(pr.mergeCommit); return pr.mergeCommit.oid; }
    assert.equal(pr.state, 'OPEN', 'Release PR was closed without merging');
    const state = checkState(pr.statusCheckRollup, requireCore);
    assert(state !== 'failed', `PR #${number} checks failed; repair through the PR and rerun this command`);
    assert(pr.mergeable !== 'CONFLICTING', `PR #${number} conflicts with main; resolve through the PR`);
    if (state === 'passed' && pr.mergeable === 'MERGEABLE') {
      // Server-side required checks/reviews still apply. Never approve or --admin.
      if (beforeMerge && !beforeMerge()) { emit('already-aligned', { repo, pr: number }); return; }
      run('gh', ['pr', 'merge', String(number), '--repo', repo, '--squash', '--match-head-commit', expectedHead]);
    } else emit('checks', { repo, pr: number, state });
    await sleep(15000);
  }
  throw new Error('PR check wait exceeded one hour; rerun to resume');
}
async function gates(repo: string, sha: string, packages: ReleasePackage[], pinned?: CandidatePin & { tag: string }): Promise<CandidatePin> {
  const compare = api<{ status: string }>(`repos/${repo}/compare/main...${sha}`);
  assert(['identical', 'behind'].includes(compare.status), 'Release SHA must already belong to main');
  const branch = `codex/release-validation/${sha}`;
  const refs = api<{ ref: string; object: { sha: string } }[]>(`repos/${repo}/git/matching-refs/heads/${branch}`);
  const ref = refs.find(ref => ref.ref === `refs/heads/${branch}`);
  if (ref) assert.equal(ref.object.sha, sha, 'Validation branch moved; refusing to overwrite it');
  // Only create the audit ref if one of the two gates needs dispatch.
  let refReady = !!ref;
  const ids: number[] = [];
  for (const [workflow, kind] of [['ci.yml', 'ci'], ['candidate.yml', 'candidate']] as const) {
    if (kind === 'candidate' && pinned) continue;
    let current = selectedRun(runs(repo, workflow, sha), sha, kind);
    if (current?.status === 'completed' && current.conclusion !== 'success') {
      throw new Error(`${workflow} run ${current.id} failed or was cancelled; diagnose and rerun that exact run before resuming`);
    }
    if (!current) {
      if (!refReady) { run('gh', ['api', '--method', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]); refReady = true; }
      run('gh', ['workflow', 'run', workflow, '--repo', repo, '--ref', branch]);
      for (let i = 0; i < 24 && !current; i++) { await sleep(5000); current = selectedRun(runs(repo, workflow, sha), sha, kind); }
      assert(current, `${workflow} dispatch did not appear; resume after checking GitHub Actions`);
    }
    emit('gate', { workflow, sha, run: current.id, status: current.status });
    ids.push(current.id);
  }
  for (const id of ids) await watch(repo, id);
  await validateMain(sha, repo);
  // Download and verify before creating any immutable version refs. A green run
  // alone is insufficient when its artifacts have expired or disappeared.
  return await verifyCandidateRun(repo, sha, packages, pinned?.id, pinned?.tag, pinned?.manifestSha256);
}
interface Options { execute: boolean; version?: string; notes?: string; consume: boolean; template: boolean; scope: ReleaseScope }
export function options(args: string[]): Options {
  const result: Options = { execute: false, consume: false, template: true, scope: 'all' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute') result.execute = true;
    else if (arg === '--consume-changesets') result.consume = true;
    else if (arg === '--skip-template') result.template = false;
    else if (arg === '--version' || arg === '--notes' || arg === '--package') {
      const value = args[++i]; assert(value && !value.startsWith('--'), `${arg} needs a value`);
      if (arg === '--version') { assert(semver.valid(value) === value && /^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(value), 'Use an explicit stable or alpha version'); result.version = value; }
      else if (arg === '--notes') result.notes = resolve(value);
      else { assert(['all', 'core', 'ui', 'auth', 'admin'].includes(value), 'Unknown release package'); result.scope = value as ReleaseScope; }
    } else throw new Error(`Unknown release option: ${arg}`);
  }
  assert(result.version || (!result.consume && !result.notes), '--notes/--consume-changesets require --version');
  return result;
}
async function prepare(repo: string, opts: Options): Promise<void> {
  assert(opts.version);
  const branch = `codex/release-${opts.scope === 'all' ? '' : `${opts.scope}-`}${opts.version}`;
  const selectedDirectories = new Set(directoriesForScope(opts.scope));
  const prs = gh<{ number: number; state: string; headRefOid: string; body: string }[]>(['pr', 'list', '--repo', repo, '--head', branch, '--base', 'main', '--state', 'all', '--json', 'number,state,headRefOid,body']);
  assert(prs.length <= 1, 'Multiple release PRs use this branch; resolve ambiguity first');
  let pr = prs[0];
  if (!pr) {
    // Reject an already-used target before spending a PR/CI cycle on it.
    for (const pkg of (await inventory()).filter(pkg => selectedDirectories.has(pkg.directory))) {
      const data = await registry(pkg.name);
      assert(!data.versions[opts.version], `${pkg.name}@${opts.version} is already published; select a new coordinated version`);
      assertChannel(opts.version, data['dist-tags'][semver.prerelease(opts.version) ? 'alpha' : 'latest']);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-release-'));
  emit('checkout', directory);
  run('git', ['clone', '--quiet', '--branch', 'main', `https://github.com/${repo}.git`, directory]);
  const validateVersions = async () => {
    for (const path of selectedDirectories) {
      assert.equal(JSON.parse(await readFile(join(directory, path, 'package.json'), 'utf8')).version, opts.version, 'Release PR versions differ from requested target');
    }
    assert((await readFile(join(directory, receiptPath(opts.scope, opts.version!)), 'utf8')).includes(opts.version!), 'Missing release receipt');
    npm(['ci', '--ignore-scripts'], directory);
    npm(['run', 'release:check'], directory);
  };
  if (!pr) {
    const remote = command('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], directory);
    if (remote) {
      // Resume a push whose subsequent PR creation failed; never overwrite it.
      run('git', ['fetch', 'origin', branch], directory);
      run('git', ['switch', '--detach', 'FETCH_HEAD'], directory);
      await validateVersions();
    } else {
      run('git', ['switch', '-c', branch], directory);
      npm(['ci', '--ignore-scripts'], directory);
      const args = ['scripts/release-prepare.ts', '--version', opts.version, '--package', opts.scope, '--execute'];
      if (opts.consume) args.push('--consume-changesets');
      if (opts.notes) args.push('--notes', opts.notes);
      run(process.execPath, args, directory);
      npm(['run', 'release:check'], directory);
      run('git', ['add', '--all'], directory);
      run('git', [
        '-c', 'user.name=urlcode-release',
        '-c', 'user.email=urlcode-release@users.noreply.github.com',
        'commit', '-m', `Prepare release ${opts.version}`,
      ], directory);
      run('git', ['push', '--set-upstream', 'origin', branch], directory);
    }
    const body = join(directory, '.git', 'release-pr.md');
    await writeFile(body, `## Problem and change\n\nPrepare ${opts.scope === 'all' ? 'core, UI, auth and admin' : opts.scope} as ${opts.version}. Generated by release:run; no packages published by this PR.\n\n## Verification\n\nLocal release consistency check passed. Required CI must pass before merge; exact-commit full validation and signed candidate follow before tags.\n\n## Compatibility and security\n\nReview peer floors, changelogs and release notes. The selected version determines the npm channel: stable uses latest; alpha uses alpha. Immutable tags, OIDC identities and required checks are preserved.\n`);
    run('gh', ['pr', 'create', '--repo', repo, '--base', 'main', '--head', branch, '--title', `Prepare ${opts.scope} release ${opts.version}`, '--body-file', body], directory);
    pr = gh(['pr', 'view', branch, '--repo', repo, '--json', 'number,state,headRefOid,body']);
  }
  assert(pr && pr.state !== 'CLOSED', 'Release PR was closed; inspect before resuming');
  run('git', ['fetch', 'origin', `refs/pull/${pr.number}/head`], directory);
  assert.equal(command('git', ['rev-parse', 'FETCH_HEAD'], directory), pr.headRefOid, 'PR changed during inspection; resume deliberately');
  run('git', ['switch', '--detach', pr.headRefOid], directory);
  await validateVersions();
  const sha = await waitAndMerge(repo, pr.number, pr.headRefOid, true);
  assert(sha);
  run('git', ['fetch', 'origin', 'main'], directory);
  run('git', ['switch', '--detach', sha], directory);
  await validateVersions();
  // Re-exec from the actual merge commit. New runs rediscover the PR and gates.
  npm(['run', 'release:run', '--', '--execute', '--package', opts.scope, ...(opts.template ? [] : ['--skip-template'])], directory);
}
async function publish(repo: string, packages: ReleasePackage[], sha: string, opts: Options): Promise<void> {
  const selectedDirectories = new Set(directoriesForScope(opts.scope));
  const planned = [];
  for (const pkg of packages.filter(pkg => selectedDirectories.has(pkg.directory))) {
    const refs = command('git', ['ls-remote', '--tags', 'origin', `refs/tags/${pkg.tag}`, `refs/tags/${pkg.tag}^{}`]).split('\n').filter(Boolean);
    const tagSha = (refs.find(line => line.endsWith('^{}')) ?? refs[0])?.split(/\s/)[0];
    const published = !!(await registry(pkg.name)).versions[pkg.version];
    const state = packageState(published, tagSha, sha);
    planned.push({ pkg, tagSha, state });
    emit('package', { name: pkg.name, version: pkg.version, state, tagSha });
  }
  if (!opts.execute) return;
  clean();
  const active = planned.filter(item => item.state !== 'unchanged');
  let pinned: (CandidatePin & { tag: string }) | undefined;
  for (const item of active.filter(item => item.tagSha)) {
    const pin = pinnedCandidateRun(item.pkg, sha, repo);
    if (pinned) assert.deepEqual(pin, { id: pinned.id, manifestSha256: pinned.manifestSha256 }, 'Release tags select different candidate bytes; stop and investigate');
    else pinned = { ...pin, tag: item.pkg.tag };
  }
  const candidate = active.length ? await gates(repo, sha, packages, pinned) : undefined;
  for (const { pkg, tagSha } of active) {
    if (!tagSha) {
      assert(candidate);
      const tag = gh<{ sha: string }>(['api', '--method', 'POST', `repos/${repo}/git/tags`, '-f', `tag=${pkg.tag}`, '-f', `message=${JSON.stringify({ sourceCommit: sha, candidateRun: candidate.id, candidateManifestSha256: candidate.manifestSha256 })}`, '-f', `object=${sha}`, '-f', 'type=commit']);
      run('gh', ['api', '--method', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${pkg.tag}`, '-f', `sha=${tag.sha}`]);
    }
    const suffix = pkg.directory === '.' ? '' : `-${pkg.directory.split('/')[1]}`;
    const workflow = `release${suffix}.yml`;
    let current: WorkflowRun | undefined;
    for (let i = 0; i < 24; i++) {
      current = runs(repo, workflow, sha).find(run => run.event === 'push' && run.head_branch === pkg.tag);
      if (current) break;
      await sleep(5000);
    }
    assert(current, `No tag workflow for ${pkg.tag}; inspect permissions, never move the tag`);
    if (current.status === 'completed' && current.conclusion !== 'success') {
      // Updated publishers restore verified originals or fail closed. Never loop retries.
      emit('resume', { package: pkg.name, run: current.id });
      run('gh', ['run', 'rerun', String(current.id), '--repo', repo]);
    }
    await watch(repo, current.id);
    await waitForInstallability(pkg);
    emit('published', { name: pkg.name, version: pkg.version });
  }
  await verifyPublishedTrain(packages);
  emit('verified', packages.map(pkg => `${pkg.name}@${pkg.version}`));
  if (opts.template && selectedDirectories.has('.')) {
    const core = packages.find(pkg => pkg.directory === '.'); assert(core);
    const pr = await updateTemplate(core.version, { execute: true });
    if (pr) await waitAndMerge('jimhoyd-com/urlcode-template', pr.number, pr.head, false, () => assertTemplateCurrent(core.version));
  }
  emit('complete', { sha, packages: planned.map(item => `${item.pkg.name}@${item.pkg.version}`) });
}
async function main(): Promise<void> {
  const opts = options(process.argv.slice(2));
  const repo = process.env.GITHUB_REPOSITORY ?? 'jimhoyd-com/urlcode';
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
  if (opts.version) {
    if (!opts.execute) {
      const args = ['scripts/release-prepare.ts', '--version', opts.version];
      args.push('--package', opts.scope);
      if (opts.consume) args.push('--consume-changesets');
      if (opts.notes) args.push('--notes', opts.notes);
      run(process.execPath, args);
      emit('proposal', 'With --execute: release PR → required checks/merge → exact-SHA gates → sequential publication → consumer verification → starter PR/checks/merge');
      return;
    }
    clean(); await prepare(repo, opts); return;
  }
  await publish(repo, await inventory(), command('git', ['rev-parse', 'HEAD']), opts);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
