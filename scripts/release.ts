import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, mkdtemp, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

export const directories = ['.', 'packages/ui', 'packages/auth', 'packages/admin'] as const;
export interface ReleasePackage { name: string; version: string; directory: string; tag: string; channel: string; prerelease: boolean; tarball: string; peers: Record<string, string> }
export function identity(name: string, version: string, directory: string): ReleasePackage {
  assert.equal(semver.valid(version), version, `Invalid release version: ${version}`);
  const pre = semver.prerelease(version);
  const channel = pre ? String(pre[0]) : 'latest';
  assert.match(channel, /^[a-z][a-z0-9-]*$/, 'Prerelease must name a channel such as alpha');
  return { name, version, directory, tag: directory === '.' ? `v${version}` : `${name}@${version}`, channel, prerelease: pre !== null, tarball: `${name.replace('@', '').replace('/', '-')}-${version}.tgz`, peers: {} };
}
export async function inventory(): Promise<ReleasePackage[]> {
  return Promise.all(directories.map(async directory => {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    assert(!pkg.private && pkg.license === 'Apache-2.0', `${directory}: not a public Apache-2.0 package`);
    return { ...identity(pkg.name, pkg.version, directory), peers: pkg.peerDependencies ?? {} };
  }));
}
export function imageFromDockerfile(text: string): string {
  const match = /^FROM (node:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64})(?: AS [a-zA-Z0-9_-]+)?\r?$/.exec(text.split('\n')[0] ?? '');
  assert(match, 'Dockerfile must start with a digest-pinned Node image, optionally with a stage alias');
  return match[1]!;
}
export function assertChannel(version: string, existing?: string): void {
  if (existing) assert(semver.gte(version, existing), `Refusing channel regression: ${existing} -> ${version}`);
}
export function assertIntegrity(bytes: Buffer, integrity: string): void {
  const expected = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(integrity, expected, 'Published version has different bytes; create a new version, never move its tag');
}
function gh<T>(path: string): T {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as T;
}
export async function registry(name: string): Promise<{ 'dist-tags': Record<string, string>; versions: Record<string, { dist: { integrity?: string }; peerDependencies?: Record<string, string> }> }> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) });
  // These are existing public packages. A 404, timeout or permission failure is
  // an error, never evidence that publishing would be safe.
  assert(response.ok, `Registry lookup failed for ${name}: ${response.status}`);
  return await response.json();
}
export function assertMainRun(runs: { head_sha: string; conclusion: string | null; event: string; head_branch: string }[], sha: string): void {
  const run = runs.find(run => run.head_sha === sha && ((run.event === 'push' && run.head_branch === 'main') || run.event === 'workflow_dispatch'));
  assert(run && run.conclusion === 'success', `Exact commit ${sha} must have successful main verification; missing, failed or pending checks cannot release`);
}
export async function validateMain(sha: string, repo: string): Promise<void> {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha, 'Checkout does not match release SHA');
  assert(['identical', 'behind'].includes(gh<{ status: string }>(`repos/${repo}/compare/main...${sha}`).status), 'Release commit is not on main');
  const runs = gh<{ workflow_runs: { head_sha: string; conclusion: string | null; event: string; head_branch: string }[] }>(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`).workflow_runs;
  assertMainRun(runs, sha);
  const checks = gh<{ check_runs: { name: string; conclusion: string | null; app: { slug: string } }[] }>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`).check_runs;
  assert(checks.some(check => check.app.slug === 'github-actions' && /^(?:CodeQL|Analyze \(javascript-typescript\))/.test(check.name) && check.conclusion === 'success'), 'Successful CodeQL analysis is required on this commit');
 }
async function preflight(pkg: ReleasePackage, sha: string, repo: string): Promise<void> {
  await validateMain(sha, repo);
  const refs = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${pkg.tag}`, `refs/tags/${pkg.tag}^{}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert(refs.length, `Missing remote tag ${pkg.tag}`);
  const remote = (refs.find(line => line.endsWith('^{}')) ?? refs[0]!).split(/\s/)[0];
  assert.equal(remote, sha, `Remote tag ${pkg.tag} points at another commit`);
  const data = await registry(pkg.name);
  assertChannel(pkg.version, data['dist-tags'][pkg.channel]);
  for (const [name, range] of Object.entries(pkg.peers)) {
    const floor = semver.minVersion(range);
    assert(floor, `Invalid peer range: ${name} ${range}`);
    const peer = await registry(name);
    assert(peer.versions[floor.version], `${name}@${floor.version}, the declared peer floor, is not published`);
  }
}
const run = (program: string, args: string[]) => {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} failed`);
};
async function publish(pkg: ReleasePackage): Promise<void> {
  const npm = process.env.npm_execpath;
  // Workflow calls through npm run after installing the pinned npm version.
  assert(npm, 'Run publication through npm run release:publish');
  assert(process.env.GITHUB_ACTIONS === 'true', 'Publication is CI-only');
  const version = execFileSync(process.execPath, [npm, '--version'], { encoding: 'utf8' }).trim();
  assert(semver.gte(version, '11.5.1') && semver.gte(process.versions.node, '22.14.0'), 'Trusted publishing requires npm >=11.5.1 and Node >=22.14.0');
  const path = `./candidate/${pkg.tarball}`, bytes = await readFile(path);
  const data = await registry(pkg.name);
  assertChannel(pkg.version, data['dist-tags'][pkg.channel]);
  const existing = data.versions[pkg.version];
  if (existing) {
    assertIntegrity(bytes, existing.dist.integrity ?? '');
    assert.equal(data['dist-tags'][pkg.channel], pkg.version,
      'Existing version has identical bytes but a different channel; review channel state explicitly');
    console.log(`${pkg.name}@${pkg.version}: already published with identical bytes`);
  } else {
    run(process.execPath, [npm, 'publish', '--access', 'public', '--ignore-scripts', '--tag', pkg.channel, path]);
  }
}
async function githubRelease(pkg: ReleasePackage, sha: string, repo: string): Promise<void> {
  // Paginate rather than treating a failed `release view` as nonexistence.
  const releases = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`], { encoding: 'utf8' })).flat() as { tag_name: string; prerelease: boolean; assets: { name: string }[] }[];
  const existing = releases.find(release => release.tag_name === pkg.tag);
  const files = (await readdir('candidate')).map(name => join('candidate', name));
  if (!existing) {
    run('gh', ['release', 'create', pkg.tag, ...files, '--repo', repo, '--verify-tag', '--title', `${pkg.name} ${pkg.version}`, `--prerelease=${pkg.prerelease}`, '--latest=false', '--notes', `Signed artifacts for ${sha}. Verify with gh attestation verify <tarball> --repo ${repo}.`]);
    return;
  }
  assert.equal(existing.prerelease, pkg.prerelease, 'Existing GitHub release has a different channel classification');
  const scratch = await mkdtemp(join(tmpdir(), 'urlcode-release-'));
  try {
    for (const file of files) {
      const name = file.slice('candidate/'.length);
      if (existing.assets.some(asset => asset.name === name)) {
        run('gh', ['release', 'download', pkg.tag, '--repo', repo, '--pattern', name, '--dir', scratch]);
        assert((await readFile(file)).equals(await readFile(join(scratch, name))), `Existing GitHub asset ${name} differs; refusing overwrite`);
      } else run('gh', ['release', 'upload', pkg.tag, file, '--repo', repo]);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  if (command === 'image') { console.log(imageFromDockerfile(await readFile('Dockerfile', 'utf8'))); return; }
  const packages = await inventory();
  if (command === 'check') {
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    for (const pkg of packages) {
      assert.equal(lock.packages[pkg.directory === '.' ? '' : pkg.directory]?.version, pkg.version, `${pkg.name}: lockfile version differs from manifest; run npm install --package-lock-only`);
    }
    const pre = JSON.parse(await readFile('.changeset/pre.json', 'utf8'));
    assert(pre.mode === 'pre' && pre.tag === 'alpha', 'Leaving alpha requires an explicit release-policy change');
    console.log('Release manifests, lockfile and alpha policy agree'); return;
  }
  if (command === 'plan' || command === 'status') {
    const refs = execFileSync('git', ['ls-remote', '--tags', 'origin'], { encoding: 'utf8' }).trim().split('\n');
    const rows = [];
    for (const pkg of packages) {
      const data = await registry(pkg.name);
      const tagLines = refs.filter(line => line.endsWith(`refs/tags/${pkg.tag}`) || line.endsWith(`refs/tags/${pkg.tag}^{}`));
      const tagSha = (tagLines.find(line => line.endsWith('^{}')) ?? tagLines[0])?.split(/\s/)[0] ?? null;
      const peers = [];
      for (const [name, range] of Object.entries(pkg.peers)) {
        const peer = await registry(name), floor = semver.minVersion(range)?.version;
        peers.push({ name, range, floor, floorPublished: !!(floor && peer.versions[floor]), latestCompatible: semver.satisfies(peer['dist-tags'].latest ?? '', range), alphaCompatible: semver.satisfies(peer['dist-tags'].alpha ?? '', range) });
      }
      rows.push({ ...pkg, published: !!data.versions[pkg.version], channels: data['dist-tags'], tagSha, peers, releaseNeeded: !data.versions[pkg.version] });
    }
    console.log(JSON.stringify({ sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), packages: rows }, null, 2));
    return;
  }
  const pkg = packages.find(pkg => pkg.directory === (process.env.PACKAGE_DIR ?? '.'));
  assert(pkg, 'Unknown package directory');
  if (command === 'identity') {
    assert.equal(process.env.GITHUB_REF_NAME, pkg.tag, 'Tag does not match package.json');
    const output = `value=${pkg.version}\ndist=${pkg.channel}\nprerelease=${pkg.prerelease}\ntarball=${pkg.tarball}\n`;
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output);
    console.log(output); return;
  }
  if (command === 'peers') {
    const npm = process.env.npm_execpath;
    assert(npm, 'Run peer installation through npm run release:peers');
    const specs = Object.entries(pkg.peers).map(([name, range]) => {
      const floor = semver.minVersion(range); assert(floor, `Invalid peer range ${range}`);
      return `${name}@${floor.version}`;
    });
    assert(specs.length > 0, 'No declared peers');
    // Outside the workspace: npm --prefix can silently reuse sibling links.
    const floor = await mkdtemp(join(tmpdir(), 'urlcode-peer-floor-'));
    try {
      await cp(resolve(pkg.directory), floor, { recursive: true,
        filter: source => !['node_modules', 'dist'].includes(source.split(sep).at(-1)!) });
      const execute = (args: string[]) => {
        const result = spawnSync(process.execPath, args, { cwd: floor, stdio: 'inherit' });
        assert.equal(result.status, 0, `Isolated peer command failed: ${args.join(' ')}`);
      };
      execute([npm, 'install', '--no-save', '--ignore-scripts', ...specs]);
      const nested = realpathSync(join(floor, 'node_modules')) + sep;
      for (const [name, range] of Object.entries(pkg.peers)) {
        // Read the file directly: published packages need not export package.json.
        const path = realpathSync(join(floor, 'node_modules', name, 'package.json'));
        assert(path.startsWith(nested), `${name} resolved outside the isolated copy`);
        assert.equal(JSON.parse(await readFile(path, 'utf8')).version, semver.minVersion(range)?.version);
      }
      execute(['scripts/check-sqlite.mjs']);
      execute([npm, 'run', 'build']);
      const tests = (await readdir(join(floor, 'test'))).filter(name => name.endsWith('.test.ts')).map(name => join('test', name));
      assert(tests.length > 0, 'No isolated peer regression tests found');
      execute(['--test', '--test-timeout=120000', ...tests]);
    } finally { await rm(floor, { recursive: true, force: true }); }
    return;
  }
  const sha = process.env.GITHUB_SHA ?? '', repo = process.env.GITHUB_REPOSITORY ?? '';
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
  if (command === 'preflight') { await preflight(pkg, sha, repo); return; }
  if (command === 'publish') { assert.equal(process.env.GITHUB_REF_NAME, pkg.tag); await preflight(pkg, sha, repo); await publish(pkg); return; }
  if (command === 'github') { assert.equal(process.env.GITHUB_REF_NAME, pkg.tag); await preflight(pkg, sha, repo); await githubRelease(pkg, sha, repo); return; }
  if (command === 'restore') {
    assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/);
    const name = `release-${pkg.tarball}-${sha}`;
    const artifacts = gh<{ artifacts: { name: string; expired: boolean }[] }>(`repos/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts?per_page=100`).artifacts;
    const found = artifacts.find(artifact => artifact.name === name && !artifact.expired);
    if (found) { await mkdir('candidate'); run('gh', ['run', 'download', process.env.GITHUB_RUN_ID!, '--repo', repo, '--name', name, '--dir', 'candidate']); }
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `restored=${!!found}\nname=${name}\n`);
    return;
  }
  throw new Error(`Unknown release command: ${command}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
