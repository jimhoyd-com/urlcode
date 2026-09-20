// Candidate archives are the only build authority. Publishers never rebuild.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReleasePackage } from './release.ts';

export interface CandidateRun { id: number; head_sha: string; head_branch: string; event: string; conclusion: string | null }
export function candidateRun(runs: CandidateRun[], sha: string): CandidateRun {
  const run = runs.find(run => run.head_sha === sha && ['main', `codex/release-validation/${sha}`].includes(run.head_branch) && run.event === 'workflow_dispatch');
  assert(run?.conclusion === 'success', `Exact commit ${sha} needs a successful latest candidate.yml run on main or its exact-SHA validation branch; dispatch it and wait before creating release tags`);
  return run;
}
export function requireOriginal(attempt: number, retained: boolean, durable: boolean): void {
  assert(Number.isSafeInteger(attempt) && attempt >= 1, 'Invalid GITHUB_RUN_ATTEMPT');
  assert(attempt === 1 || retained || durable, 'Original release artifacts are missing or expired. Refusing to rebuild or select a new candidate on retry. Restore the original complete signed bundle from the published GitHub release, or prepare a new version; never move the tag.');
}
export async function validateCandidate(directory: string, sha: string, packages: ReleasePackage[], expectedRun?: number): Promise<string[]> {
  assert.match(sha, /^[a-f0-9]{40}$/, 'Invalid candidate source SHA');
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sourceCommit, sha, 'Candidate source SHA mismatch');
  assert.equal(manifest.channel, 'candidate', 'Expected signed candidate bundle');
  if (expectedRun !== undefined) assert.equal(manifest.candidateRun, String(expectedRun), 'Candidate run differs from immutable tag pin');
  assert(manifest.artifacts && typeof manifest.artifacts === 'object' && !Array.isArray(manifest.artifacts), 'Missing candidate digests');
  const names = Object.keys(manifest.artifacts);
  const expected = [...packages.map(pkg => pkg.tarball), 'sbom.cdx.json', 'train.json', 'urlcode.rb'].sort();
  assert.deepEqual(names.sort(), expected, 'Candidate must contain exactly the four archives and supporting assets');
  const files = (await readdir(directory)).sort();
  assert.deepEqual(files, [...expected, 'manifest.json', 'SHA256SUMS'].sort(), 'Unexpected or missing candidate files');
  for (const name of files) assert((await lstat(join(directory, name))).isFile(), `Candidate asset must be a regular file: ${name}`);
  for (const name of names) {
    assert.match(manifest.artifacts[name], /^[a-f0-9]{64}$/, `Invalid digest: ${name}`);
    assert.equal(createHash('sha256').update(await readFile(join(directory, name))).digest('hex'), manifest.artifacts[name], `Candidate hash mismatch: ${name}`);
  }
  const sums = names.sort((a, b) => a.localeCompare(b)).map(name => `${manifest.artifacts[name]}  ${name}`).join('\n') + '\n';
  assert.equal(await readFile(join(directory, 'SHA256SUMS'), 'utf8'), sums, 'Candidate checksums disagree');
  const train = JSON.parse(await readFile(join(directory, 'train.json'), 'utf8'));
  assert.equal(train.sourceCommit, sha, 'Train source SHA mismatch');
  assert(Array.isArray(train.packages) && train.packages.length === packages.length, 'Train must cover all four packages');
  for (const pkg of packages) {
    const entries = train.packages.filter((entry: { name: string }) => entry.name === pkg.name);
    assert.equal(entries.length, 1, `Train must contain ${pkg.name} exactly once`);
    const entry = entries[0];
    assert.equal(entry.version, pkg.version, `Train version mismatch: ${pkg.name}`);
    assert.equal(entry.filename, pkg.tarball, `Train archive mismatch: ${pkg.name}`);
    assert.equal(entry.integrity, `sha512-${createHash('sha512').update(await readFile(join(directory, pkg.tarball))).digest('base64')}`, `Train integrity mismatch: ${pkg.name}`);
  }
  return files;
}
const execute = (args: string[]) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const api = <T>(path: string): T => JSON.parse(execute(['api', path])) as T;
export interface CandidatePin { id: number; manifestSha256: string }
export interface AnnotatedCandidateTag { tag: string; message: string; object: { type: string; sha: string } }
export function candidateTag(tag: AnnotatedCandidateTag, pkg: ReleasePackage, sha: string): CandidatePin {
  assert.equal(tag.tag, pkg.tag, 'Annotated tag name mismatch');
  assert.equal(tag.object.type, 'commit', 'Release tag must directly identify a commit');
  assert.equal(tag.object.sha, sha, 'Annotated release tag source mismatch');
  const pin = JSON.parse(tag.message);
  assert.equal(pin.sourceCommit, sha, 'Candidate pin source mismatch');
  assert(Number.isSafeInteger(pin.candidateRun) && pin.candidateRun > 0, 'Invalid pinned candidate run');
  assert.match(pin.candidateManifestSha256, /^[a-f0-9]{64}$/, 'Invalid pinned candidate manifest digest');
  return { id: pin.candidateRun, manifestSha256: pin.candidateManifestSha256 };
}
export function pinnedCandidateRun(pkg: ReleasePackage, sha: string, repo: string): CandidatePin {
  const ref = api<{ object: { type: string; sha: string } }>(`repos/${repo}/git/ref/tags/${encodeURIComponent(pkg.tag)}`);
  assert.equal(ref.object.type, 'tag', 'Release requires an annotated immutable candidate pin; existing lightweight tags cannot be changed—prepare a new version');
  return candidateTag(api<AnnotatedCandidateTag>(`repos/${repo}/git/tags/${ref.object.sha}`), pkg, sha);
}
function exactCandidate(repo: string, sha: string, runId?: number): number {
  const selected = runId ?? candidateRun(api<{ workflow_runs: CandidateRun[] }>(`repos/${repo}/actions/workflows/candidate.yml/runs?head_sha=${sha}&per_page=100`).workflow_runs, sha).id;
  assert(Number.isSafeInteger(selected) && selected > 0, 'Invalid candidate run');
  const candidate = api<CandidateRun & { path: string }>(`repos/${repo}/actions/runs/${selected}`);
  assert.equal(candidate.path, '.github/workflows/candidate.yml', 'Pinned run is not the candidate workflow');
  assert.equal(candidateRun([candidate], sha).id, selected, 'Pinned candidate run identity differs');
  return selected;
}
async function verifyBundle(directory: string, sha: string, repo: string, packages: ReleasePackage[], runId: number, expectedManifestSha256?: string): Promise<string> {
  const manifestSha256 = createHash('sha256').update(await readFile(join(directory, 'manifest.json'))).digest('hex');
  if (expectedManifestSha256 !== undefined) {
    assert.match(expectedManifestSha256, /^[a-f0-9]{64}$/, 'Invalid pinned candidate manifest digest');
    assert.equal(manifestSha256, expectedManifestSha256, 'Candidate manifest differs from immutable tag pin; a rerun cannot replace approved bytes');
  }
  const files = await validateCandidate(directory, sha, packages, runId);
  for (const file of files) execute(['attestation', 'verify', join(directory, file), '--repo', repo,
    '--signer-workflow', `${repo}/.github/workflows/candidate.yml`, '--source-digest', sha,
    '--deny-self-hosted-runners']);
  return manifestSha256;
}
function downloadCandidate(repo: string, sha: string, runId: number, directory: string, recoveryTag?: string): void {
  const artifacts = api<{ artifacts: { name: string; expired: boolean }[] }>(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`).artifacts;
  if (artifacts.some(artifact => artifact.name === `candidate-${sha}` && !artifact.expired)) {
    execute(['run', 'download', String(runId), '--repo', repo, '--name', `candidate-${sha}`, '--dir', directory]);
  } else {
    assert(recoveryTag, 'Pinned candidate artifacts are missing or expired; no release tags will be created. Recover a complete signed bundle from an existing release or prepare a new version.');
    execute(['release', 'download', recoveryTag, '--repo', repo, '--dir', directory]);
  }
}
export async function verifyCandidateRun(repo: string, sha: string, packages: ReleasePackage[], runId?: number, recoveryTag?: string, expectedManifestSha256?: string): Promise<CandidatePin> {
  const selected = exactCandidate(repo, sha, runId);
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-promote-'));
  try {
    downloadCandidate(repo, sha, selected, directory, recoveryTag);
    const manifestSha256 = await verifyBundle(directory, sha, repo, packages, selected, expectedManifestSha256);
    return { id: selected, manifestSha256 };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function restoreReleaseArtifacts(pkg: ReleasePackage, sha: string, repo: string, packages: ReleasePackage[]): Promise<{ restored: boolean; name: string }> {
  const runId = process.env.GITHUB_RUN_ID ?? '';
  assert.match(runId, /^\d+$/);
  assert.match(sha, /^[a-f0-9]{40}$/);
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const pinned = pinnedCandidateRun(pkg, sha, repo);
  const name = `release-${pkg.tarball}-${sha}`;
  const artifacts = api<{ artifacts: { name: string; expired: boolean }[] }>(`repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`).artifacts;
  const retained = artifacts.some(artifact => artifact.name === name && !artifact.expired);
  let durable = false;
  if (!retained && attempt > 1) {
    const releases = JSON.parse(execute(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat() as { tag_name: string }[];
    durable = releases.some(release => release.tag_name === pkg.tag);
  }
  requireOriginal(attempt, retained, durable);
  await mkdir('candidate'); // A stale local directory must never mix into a release.
  if (retained) execute(['run', 'download', runId, '--repo', repo, '--name', name, '--dir', 'candidate']);
  else if (durable) execute(['release', 'download', pkg.tag, '--repo', repo, '--dir', 'candidate']);
  else {
    exactCandidate(repo, sha, pinned.id);
    // A first attempt of a later package can recover the already-promoted
    // train from an earlier package's durable assets if Actions retention ended.
    const releases = JSON.parse(execute(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat() as { tag_name: string }[];
    let recovery: string | undefined;
    for (const prior of packages) {
      if (!releases.some(release => release.tag_name === prior.tag)) continue;
      const ref = api<{ object: { type: string; sha: string } }>(`repos/${repo}/git/ref/tags/${encodeURIComponent(prior.tag)}`);
      if (ref.object.type !== 'tag') continue; // Historical versions are not this train.
      const tag = api<AnnotatedCandidateTag>(`repos/${repo}/git/tags/${ref.object.sha}`);
      if (tag.object.sha !== sha) continue;
      const priorPin = candidateTag(tag, prior, sha);
      if (priorPin.id === pinned.id && priorPin.manifestSha256 === pinned.manifestSha256) { recovery = prior.tag; break; }
    }
    downloadCandidate(repo, sha, pinned.id, 'candidate', recovery);
  }
  await verifyBundle('candidate', sha, repo, packages, pinned.id, pinned.manifestSha256);
  console.log(`Verified original candidate bytes for ${sha}${durable ? ' recovered from GitHub release assets' : ''}`);
  return { restored: retained || durable, name };
}
