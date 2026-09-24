// The publishing steps of .github/workflows/release.yml, each idempotent, so "Re-run failed jobs" completes a
// partly finished release without changing anything already published. Order matters and is enforced by the
// workflow: the GitHub Release (every tarball) first, then the public add-on URLs are checked against core's pins,
// and only then does core reach npm, so a published core never points at an add-on that cannot be downloaded.
//
//   node scripts/release-publish.ts plan              version, channel and whether anything is left to publish
//   node scripts/release-publish.ts github <sha>      create or complete the v<version> GitHub Release
//   node scripts/release-publish.ts urls              download every pinned add-on and compare its sha512
//   node scripts/release-publish.ts npm               publish core's tarball with npm trusted publishing
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { npmCommand } from './npm-command.ts';
import { repositoryRoot } from './workspaces.ts';

const repo = process.env.GITHUB_REPOSITORY ?? 'jimhoyd-com/urlcode', core = '@jimhoyd/urlcode';
const out = resolve(process.env.URLCODE_RELEASE_DIR ?? join(repositoryRoot, 'release'));
export interface Runner { gh(args: string[]): string; npm(args: string[]): string; fetch(url: string): Promise<Buffer> }
const system: Runner = {
  gh: args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  npm: args => { const command = npmCommand(args); return execFileSync(command.command, command.args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); },
  fetch: async url => { const response = await fetch(url, { redirect: 'follow' }); assert(response.ok, `${url} answered ${response.status}`); return Buffer.from(await response.arrayBuffer()); },
};
const quiet = (run: () => string): string | undefined => { try { return run(); } catch { return undefined; } };

export async function releaseVersion(): Promise<{ version: string; tag: string; channel: 'latest' | 'alpha'; stable: boolean }> {
  const { version } = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { version: string };
  const stable = semver.prerelease(version) === null;
  return { version, tag: `v${version}`, channel: stable ? 'latest' : 'alpha', stable };
}

/** Anything left to publish? False only when the GitHub Release exists and npm already has this version. */
export async function plan(runner: Runner = system): Promise<{ version: string; tag: string; channel: string; stable: boolean; release: boolean }> {
  const identity = await releaseVersion();
  const onGithub = quiet(() => runner.gh(['release', 'view', identity.tag, '--repo', repo, '--json', 'isDraft', '--jq', '.isDraft'])) === 'false\n';
  const onNpm = quiet(() => runner.npm(['view', `${core}@${identity.version}`, 'version', '--registry=https://registry.npmjs.org']))?.trim() === identity.version;
  return { ...identity, release: !(onGithub && onNpm) };
}

export async function github(sha: string, runner: Runner = system): Promise<void> {
  assert.match(sha, /^[a-f0-9]{40}$/, 'Pass the exact commit to release');
  const { version, tag, stable } = await releaseVersion();
  const files = (await readdir(out)).sort().map(name => join(out, name));
  assert(files.length > 0, `${out} is empty; run release:pack first`);
  const releases = JSON.parse(runner.gh(['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`])).flat() as { tag_name: string; draft: boolean; prerelease: boolean; assets: { name: string }[] }[];
  if (stable) for (const release of releases) {
    const previous = release.tag_name.replace(/^v/, '');
    if (!release.draft && !release.prerelease && semver.valid(previous) && !semver.prerelease(previous)) assert(semver.gte(version, previous), `Refusing to move the latest release back from ${previous} to ${version}`);
  }
  const existing = releases.find(release => release.tag_name === tag);
  if (!existing) {
    runner.gh(['release', 'create', tag, ...files, '--repo', repo, '--target', sha, '--title', `URLCode ${version}`, '--generate-notes', `--prerelease=${!stable}`, `--latest=${stable}`]);
    return;
  }
  assert.equal(existing.prerelease, !stable, `${tag} exists with a different channel`);
  const scratch = await mkdtemp(join(tmpdir(), 'urlcode-release-'));
  try {
    for (const file of files) {
      const name = file.slice(out.length + 1);
      if (existing.assets.some(asset => asset.name === name)) {
        runner.gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', scratch]);
        assert((await readFile(file)).equals(await readFile(join(scratch, name))), `${tag} already has a different ${name}; a published asset is never replaced — release a new version`);
      } else runner.gh(['release', 'upload', tag, file, '--repo', repo]);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Every add-on core pins must be downloadable from its public URL with exactly the pinned bytes. */
export async function urls(runner: Runner = system): Promise<string[]> {
  const pins = JSON.parse(await readFile(join(out, 'addons.json'), 'utf8')) as { addons: Record<string, { url: string; integrity: string }> };
  const checked: string[] = [];
  for (const [name, pin] of Object.entries(pins.addons)) {
    const bytes = await runner.fetch(pin.url);
    assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, pin.integrity, `${name}: ${pin.url} does not match core's pin`);
    checked.push(name);
  }
  return checked;
}

export async function publish(runner: Runner = system): Promise<'published' | 'already published'> {
  const { version, channel } = await releaseVersion();
  const tarball = (await readdir(out)).find(name => name === `jimhoyd-urlcode-${version}.tgz`);
  assert(tarball, `release/jimhoyd-urlcode-${version}.tgz is missing`);
  const bytes = await readFile(join(out, tarball));
  const published = quiet(() => runner.npm(['view', `${core}@${version}`, 'dist.shasum', '--registry=https://registry.npmjs.org']))?.trim();
  if (published) {
    assert.equal(published, createHash('sha1').update(bytes).digest('hex'), `${core}@${version} is already on npm with different bytes`);
    return 'already published';
  }
  runner.npm(['publish', join(out, tarball), '--access', 'public', '--tag', channel, '--ignore-scripts', '--registry=https://registry.npmjs.org']);
  return 'published';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, arg] = process.argv.slice(2);
  if (command === 'plan') {
    const result = await plan();
    process.stdout.write(JSON.stringify(result) + '\n');
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(result).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  } else if (command === 'github') { await github(arg ?? ''); process.stdout.write('GitHub Release complete\n'); }
  else if (command === 'urls') process.stdout.write(`Public add-on URLs match their pins: ${(await urls()).join(', ')}\n`);
  else if (command === 'npm') process.stdout.write(`npm: ${await publish()}\n`);
  else { process.stderr.write('Use: node scripts/release-publish.ts plan | github <sha> | urls | npm\n'); process.exit(2); }
}
