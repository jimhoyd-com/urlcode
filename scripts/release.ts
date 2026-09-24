import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { restoreReleaseArtifacts } from './release-artifacts.ts';
import { assertPeerFloorCoversApi } from './peer-api.ts';
import { directoriesForScope, releaseNotesPath, type ReleaseScope } from './release-prepare.ts';
import { releaseIdentity } from './release-identity.ts';

// Only core is an npm release target. The extension workspaces remain public
// source inputs for signed executable bundles, but must never re-enter this
// inventory: it is the single source of truth for tags and npm publication.
export const directories = ['.'] as const;
export interface ReleasePackage { name: string; version: string; directory: string; tag: string; channel: string; prerelease: boolean; tarball: string; peers: Record<string, string> }
interface ReleaseTrainPackage {
  name: string;
  version: string;
  filename: string;
  integrity: string;
  channel: string;
  peerDependencies: Record<string, string>;
}
interface ReleaseTrain {
  sourceCommit: string;
  packages: ReleaseTrainPackage[];
  validation: string;
}
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
export function assertReleasePolicy(packages: ReleasePackage[], pre: unknown): void {
  const prereleases = packages.filter(pkg => pkg.prerelease);
  if (pre === null) {
    assert.equal(prereleases.length, 0, 'Prerelease packages require explicit Changesets alpha mode');
    return;
  }
  assert(pre && typeof pre === 'object' && 'mode' in pre && pre.mode === 'pre' && 'tag' in pre && pre.tag === 'alpha', 'Unsupported Changesets prerelease policy');
  assert(prereleases.length > 0 && prereleases.every(pkg => pkg.channel === 'alpha'), 'Alpha mode must match alpha manifests; remove pre.json when preparing stable versions');
}
export function assertIntegrity(bytes: Buffer, integrity: string): void {
  const expected = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(integrity, expected, 'Published version has different bytes; create a new version, never move its tag');
}
function gh<T>(path: string): T {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as T;
}
// A commit's check-runs or workflow-runs can exceed a single page (this
// repo's CI matrix alone produces 100+ per commit): an unpaginated call can
// silently miss an entry, such as a required CodeQL check, depending on API
// ordering. `--paginate --slurp` merges every page's array field into one.
function ghAll<T>(path: string, field: string): T[] {
  const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as Record<string, T[]>[];
  return pages.flatMap(page => page[field] ?? []);
}
export async function registry(name: string): Promise<{ 'dist-tags': Record<string, string>; versions: Record<string, { dist: { integrity?: string }; peerDependencies?: Record<string, string> }> }> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) });
  // These are existing public packages. A 404, timeout or permission failure is
  // an error, never evidence that publishing would be safe.
  assert(response.ok, `Registry lookup failed for ${name}: ${response.status}`);
  return await response.json();
}
export function assertMainRun(runs: { head_sha: string; conclusion: string | null; event: string; head_branch: string }[], sha: string): void {
  const run = runs.find(run => run.head_sha === sha && run.event === 'workflow_dispatch');
  assert(run && run.conclusion === 'success', `Exact commit ${sha} must have successful release verification; run gh workflow run ci.yml --ref main and wait before releasing`);
}
interface CodeQLCheck { id: number; name: string; conclusion: string | null; app: { slug: string }; check_suite?: { id: number } }
export function assertCodeQLRun(checks: CodeQLCheck[]): void {
  const relevant = checks.filter(check => check.app.slug === 'github-actions' && /^(?:CodeQL|Analyze \(javascript-typescript\))/.test(check.name));
  assert(relevant.length > 0, 'Successful CodeQL analysis is required on this commit');
  for (const check of relevant) assert(Number.isSafeInteger(check.id) && check.id > 0, 'CodeQL check identity is missing');
  relevant.sort((a, b) => b.id - a.id);
  const latest = relevant[0]!;
  assert.equal(latest.conclusion, 'success', 'Latest CodeQL analysis must succeed on this commit');
  // An aggregate check must not hide an unsuccessful analysis in its own run.
  // Old suites may have failed before a subsequent clean run and are ignored.
  if (latest.check_suite) {
    const names = new Set<string>();
    for (const check of relevant.filter(check => check.check_suite?.id === latest.check_suite!.id)) {
      if (names.has(check.name)) continue;
      names.add(check.name);
      assert.equal(check.conclusion, 'success', `Latest CodeQL suite has an unsuccessful ${check.name} check`);
    }
  }
}
export async function validateMain(sha: string, repo: string): Promise<void> {
  assert.match(sha, /^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha, 'Checkout does not match release SHA');
  assert(['identical', 'behind'].includes(gh<{ status: string }>(`repos/${repo}/compare/main...${sha}`).status), 'Release commit is not on main');
  const runs = ghAll<{ head_sha: string; conclusion: string | null; event: string; head_branch: string }>(`repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`, 'workflow_runs');
  assertMainRun(runs, sha);
  const checks = ghAll<CodeQLCheck>(`repos/${repo}/commits/${sha}/check-runs?per_page=100`, 'check_runs');
  assertCodeQLRun(checks);
 }
async function preflight(pkg: ReleasePackage, sha: string, repo: string): Promise<void> {
  await validateMain(sha, repo);
  const refs = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${pkg.tag}`, `refs/tags/${pkg.tag}^{}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert(refs.length, `Missing remote tag ${pkg.tag}`);
  const remote = (refs.find(line => line.endsWith('^{}')) ?? refs[0]!).split(/\s/)[0];
  assert.equal(remote, sha, `Remote tag ${pkg.tag} points at another commit`);
  // The declared floor must not allow a core that lacks an API this package's scaffold uses (#346).
  await assertPeerFloorCoversApi('.', pkg.directory, pkg.name, pkg.peers);
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
export function extractPreparedReleaseChanges(markdown: string): string {
  const match = /<!-- github-release-notes:start -->\s*([\s\S]*?)\s*<!-- github-release-notes:end -->/.exec(markdown);
  const changes = match?.[1]?.trim();
  assert(changes, 'Prepared release notes are missing their non-empty GitHub release section');
  return changes;
}
async function preparedReleaseChanges(pkg: ReleasePackage): Promise<string> {
  const scope = (pkg.directory === '.' ? 'core' : pkg.directory.split('/').at(-1)!) as ReleaseScope;
  const paths = [releaseNotesPath(scope, pkg.version), releaseNotesPath('all', pkg.version)];
  for (const path of paths) {
    try { return extractPreparedReleaseChanges(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  throw new Error(`Missing prepared release notes for ${pkg.name}@${pkg.version}`);
}
export function renderGithubReleaseNotes(pkg: ReleasePackage, sha: string, repo: string, train: ReleaseTrain, changes: string): string {
  assert.equal(train.sourceCommit, sha, 'Release notes train source mismatch');
  assert(train.packages.length > 0, 'Release notes require a tested package train');
  assert.equal(new Set(train.packages.map(entry => entry.name)).size, train.packages.length, 'Release notes train contains duplicate packages');
  const selected = train.packages.find(entry => entry.name === pkg.name);
  assert(selected && selected.version === pkg.version, `Release notes train does not contain ${pkg.name}@${pkg.version}`);
  const rows = train.packages.map(entry => {
    assert.equal(identity(entry.name, entry.version, '.').channel, entry.channel, `Release notes channel mismatch: ${entry.name}`);
    assert(entry.peerDependencies && typeof entry.peerDependencies === 'object' && !Array.isArray(entry.peerDependencies), `Release notes peers are missing: ${entry.name}`);
    const peers = Object.entries(entry.peerDependencies).map(([name, range]) => {
      assert.equal(typeof range, 'string', `Release notes peer range is invalid: ${entry.name} -> ${name}`);
      assert(semver.validRange(range), `Release notes peer range is invalid: ${entry.name} -> ${name}`);
      return `\`${name} ${range.replaceAll('|', '\\|')}\``;
    }).join('<br>') || '—';
    const stability = entry.channel === 'latest' ? 'stable (`latest`)' : `prerelease (\`${entry.channel}\`)`;
    return `| \`${entry.name}\` | \`${entry.version}\` | ${stability} | ${peers} |`;
  });
  const install = `npm install --save-exact ${train.packages.map(entry => `${entry.name}@${entry.version}`).join(' ')}`;
  const status = pkg.prerelease
    ? `This is a prerelease published to npm's \`${pkg.channel}\` channel.`
    : "This is a stable release published to npm's `latest` channel.";
  assert(changes.trim(), 'Release changes must not be empty');
  return `## Changes\n\n${changes.trim()}\n\n## Stability\n\n${status} Stability is package-specific; packages do not need matching version numbers.\n\n## Recommended tested stack\n\nThese exact archives were tested together: ${train.validation}. Compatibility is declared by each package's \`peerDependencies\`; the table reports both the tested versions and those declared requirements.\n\n| Package | Tested version | npm channel | Declared peer requirements |\n| --- | ---: | --- | --- |\n${rows.join('\n')}\n\n\`\`\`sh\n${install}\n\`\`\`\n\nThe signed \`train.json\` asset is the machine-readable receipt for this combination.\n\n## Verification\n\nSigned artifacts for [\`${sha}\`](https://github.com/${repo}/commit/${sha}). Verify a downloaded archive with:\n\n\`\`\`sh\ngh attestation verify <tarball> --repo ${repo}\n\`\`\`\n`;
}

export async function githubRelease(pkg: ReleasePackage, sha: string, repo: string): Promise<void> {
  // Paginate rather than treating a failed `release view` as nonexistence.
  const releases = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`], { encoding: 'utf8' })).flat() as { tag_name: string; prerelease: boolean; draft?: boolean; assets: { name: string }[] }[];
  const existing = releases.find(release => release.tag_name === pkg.tag);
  // All packages share this repository; install.sh resolves /releases/latest.
  // Only a stable core release may advance that repository-wide pointer.
  const latest = pkg.directory === '.' && !pkg.prerelease;
  if (latest) {
    for (const release of releases) {
      const previous = release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
      if (!release.draft && !release.prerelease && semver.valid(previous) && !semver.prerelease(previous)) {
        assert(semver.gte(pkg.version, previous), `Refusing GitHub latest regression: ${previous} -> ${pkg.version}`);
      }
    }
  }
  const files = (await readdir('candidate')).map(name => join('candidate', name));
  const train = JSON.parse(await readFile(join('candidate', 'train.json'), 'utf8')) as ReleaseTrain;
  const notes = renderGithubReleaseNotes(pkg, sha, repo, train, await preparedReleaseChanges(pkg));
  if (!existing) {
    run('gh', ['release', 'create', pkg.tag, ...files, '--repo', repo, '--verify-tag', '--title', `${pkg.name} ${pkg.version}`, `--prerelease=${pkg.prerelease}`, `--latest=${latest}`, '--notes', notes]);
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
  run('gh', ['release', 'edit', pkg.tag, '--repo', repo, '--notes', notes, ...(latest ? ['--latest=true'] : [])]);
}

// GitHub Releases are the published, historical release-note record (see
// docs/RELEASE-READINESS.md); `docs/RELEASE-*.md` is only a draft the
// coordinator reads until every release it covers is actually published.
// This parses the scope/version out of a drafted file's name the same way
// `releaseNotesPath` builds it, so the two stay in sync.
function parseReleaseNotesFilename(name: string): { scope: ReleaseScope; version: string } | null {
  const match = /^RELEASE-(?:(core|ui|auth|admin|store|forms)-)?(.+)\.md$/.exec(name);
  if (!match || !semver.valid(match[2]!)) return null; // excludes RELEASE-READINESS.md, RELEASE-SECURITY.md, etc.
  return { scope: (match[1] as ReleaseScope | undefined) ?? 'all', version: match[2]! };
}
async function releaseTagsCoveredByNotes(scope: ReleaseScope, version: string): Promise<string[]> {
  return Promise.all(directoriesForScope(scope).map(async directory => {
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name: string };
    return identity(pkg.name, version, directory).tag;
  }));
}
function githubReleaseExists(tag: string, repo: string): boolean {
  const result = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' });
  return result.status === 0;
}
// A drafted notes file is safe to remove only once every release it covers
// (a coordinated `all`-scope draft can cover several packages' tags) has an
// actual GitHub Release, not merely a pushed tag: `scripts/release.ts github`
// itself creates the tag's release from this same file.
export async function publishedReleaseNotesFiles(repo: string): Promise<string[]> {
  const names = (await readdir('docs')).filter(name => name.startsWith('RELEASE-') && name.endsWith('.md'));
  const published: string[] = [];
  for (const name of names) {
    const parsed = parseReleaseNotesFilename(name);
    if (!parsed) continue;
    const tags = await releaseTagsCoveredByNotes(parsed.scope, parsed.version);
    if (tags.every(tag => githubReleaseExists(tag, repo))) published.push(`docs/${name}`);
  }
  return published;
}
// Removes drafts for already-published releases and opens a pull request:
// main is protected and this bot cannot approve or merge it (see
// CONTRIBUTING.md). Best-effort and idempotent -- nothing to prune is a
// normal outcome, not a failure.
async function pruneReleaseNotes(repo: string): Promise<void> {
  const files = await publishedReleaseNotesFiles(repo);
  if (files.length === 0) { console.log('No published release-note drafts to prune.'); return; }
  console.log(`Removing published release-note drafts:\n${files.map(file => `- ${file}`).join('\n')}`);
  for (const file of files) await rm(file);
  const branch = `chore/prune-release-notes-${Date.now()}`;
  run('git', ['checkout', '-b', branch]);
  run('git', ['add', ...files]);
  run('git', [...releaseIdentity, 'commit', '-m', `chore: remove published release-note drafts\n\n${files.join('\n')}\n\nGitHub Releases are the published historical record (docs/RELEASE-READINESS.md).`]);
  run('git', ['push', 'origin', branch]);
  run('gh', ['pr', 'create', '--repo', repo, '--base', 'main', '--head', branch,
    '--title', 'chore: remove published release-note drafts',
    '--body', `Removes drafted release notes whose GitHub Release is already published:\n\n${files.map(file => `- ${file}`).join('\n')}\n\nSee https://github.com/${repo}/blob/main/docs/RELEASE-READINESS.md.`]);
}
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'status';
  if (command === 'image') { console.log(imageFromDockerfile(await readFile('packaging/container/Dockerfile', 'utf8'))); return; }
  const packages = await inventory();
  if (command === 'check') {
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    for (const pkg of packages) {
      assert.equal(lock.packages[pkg.directory === '.' ? '' : pkg.directory]?.version, pkg.version, `${pkg.name}: lockfile version differs from manifest; run npm install --package-lock-only`);
    }
    let pre: unknown = null;
    try { pre = JSON.parse(await readFile('.changeset/pre.json', 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    assertReleasePolicy(packages, pre);
    console.log('Release manifests, lockfile and channel policy agree'); return;
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
  if (command === 'prune-notes') {
    const repo = process.env.GITHUB_REPOSITORY ?? '';
    assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
    await pruneReleaseNotes(repo);
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
  const sha = process.env.GITHUB_SHA ?? '', repo = process.env.GITHUB_REPOSITORY ?? '';
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
  if (command === 'candidate-source') {
    assert.match(sha, /^[a-f0-9]{40}$/);
    assert(['refs/heads/main', `refs/heads/codex/release-validation/${sha}`].includes(process.env.GITHUB_REF ?? ''), 'Candidate must use main or its exact-SHA validation branch');
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sha, 'Candidate checkout differs from source SHA');
    assert(['identical', 'behind'].includes(gh<{ status: string }>(`repos/${repo}/compare/main...${sha}`).status), 'Candidate source is not on main');
    return;
  }
  if (command === 'preflight') { await preflight(pkg, sha, repo); return; }
  if (command === 'publish') { assert.equal(process.env.GITHUB_REF_NAME, pkg.tag); await preflight(pkg, sha, repo); await publish(pkg); return; }
  if (command === 'github') { assert.equal(process.env.GITHUB_REF_NAME, pkg.tag); await preflight(pkg, sha, repo); await githubRelease(pkg, sha, repo); return; }
  if (command === 'restore') {
    const { restored, name } = await restoreReleaseArtifacts(pkg, sha, repo, packages);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `restored=${restored}\nname=${name}\n`);
    return;
  }
  throw new Error(`Unknown release command: ${command}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
