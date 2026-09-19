// Explicit opt-in coordinator. Never called by verification or ordinary merges.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { inventory, registry, validateMain } from './release.ts';
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const repo = process.env.GITHUB_REPOSITORY ?? 'jimhoyd-com/urlcode';
assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
const packages = await inventory();
const plan = [];
for (const pkg of packages) {
  const refs = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${pkg.tag}`, `refs/tags/${pkg.tag}^{}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const tagSha = (refs.find(line => line.endsWith('^{}')) ?? refs[0])?.split(/\s/)[0];
  if (!(await registry(pkg.name)).versions[pkg.version] || tagSha === sha) plan.push(pkg);
}
console.log(JSON.stringify({ sha, packages: plan }, null, 2));
if (process.argv.includes('--execute')) {
  assert.equal(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'Release from a clean checkout');
  await validateMain(sha, repo);
  for (const pkg of plan) {
    const refs = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${pkg.tag}`, `refs/tags/${pkg.tag}^{}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    if (refs.length) {
      const actual = (refs.find(line => line.endsWith('^{}')) ?? refs[0]!).split(/\s/)[0];
      assert.equal(actual, sha, `Tag ${pkg.tag} already names another commit`);
    } else {
      execFileSync('gh', ['api', '--method', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/tags/${pkg.tag}`, '-f', `sha=${sha}`], { stdio: 'inherit' });
    }
    const suffix = pkg.directory === '.' ? '' : `-${pkg.directory.split('/')[1]}`;
    const workflow = `release${suffix}.yml`;
    let run: { id: number; conclusion: string | null } | undefined;
    // Wait for the tag-triggered workflow to appear; bounded, not an infinite poll.
    for (let attempt = 0; attempt < 24; attempt++) {
      const data = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&per_page=100`], { encoding: 'utf8' })) as { workflow_runs: { id: number; head_branch: string; conclusion: string | null }[] };
      run = data.workflow_runs.find(run => run.head_branch === pkg.tag);
      if (run) break;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    assert(run, `No run found for ${pkg.tag}. Check workflow permissions; do not move the tag.`);
    if (run.conclusion && run.conclusion !== 'success') throw new Error(`Release run ${run.id} failed. Re-run that run after diagnosing it; never move the tag.`);
    const watched = spawnSync('gh', ['run', 'watch', String(run.id), '--repo', repo, '--exit-status'], { stdio: 'inherit' });
    assert.equal(watched.status, 0, `Release ${pkg.tag} failed; stopping before downstream packages`);
    assert((await registry(pkg.name)).versions[pkg.version], `Workflow did not publish ${pkg.name}; check PUBLISH_NPM before releasing dependents`);
  }
}
