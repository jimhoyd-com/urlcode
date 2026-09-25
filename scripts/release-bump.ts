// The one place a version changes. Core and every add-on share one version; a release is a pull request that
// contains only `npm run release:bump -- <version>` (the Create release workflow, .github/workflows/release.yml, prepares
// it as a branch), and merging it releases (.github/workflows/publish.yml).
//
//   node scripts/release-bump.ts <version>   rewrite every version declaration to <version>
//   node scripts/release-bump.ts --check     fail unless every declaration agrees (CI `checks` job)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { addons, repositoryRoot } from './workspaces.ts';

const versionPattern = /^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/;
const core = '@jimhoyd/urlcode';
/** Runtime declarations of the version: exactly one match each. The starter lines are what `urlcode init` stamps over for a fresh site. */
const runtimePatterns: Record<string, RegExp> = {
  'packages/core/src/cli.ts': /(?<=const VERSION = ')[^']+/g,
  'packages/core/src/mcp.ts': /(?<=serverInfo:\{name:'urlcode',version:')[^']+/g,
  'starters/default/app/urlcode.yaml': /(?<=jimhoyd-com\/urlcode\/v)[^/\s]+(?=\/schemas\/urlcode\.schema\.json)/g,
  'starters/default/.github/workflows/urlcode.yml': /(?<=jimhoyd-com\/urlcode\/action@v)[^\s#]+/g,
};
const jsonVersions: Record<string, (value: { version?: string; metadata?: { version?: string } }) => { get(): string | undefined; set(version: string): void }> = {
  'packaging/claude-plugin/.claude-plugin/plugin.json': value => ({ get: () => value.version, set: version => { value.version = version; } }),
  '.claude-plugin/marketplace.json': value => ({ get: () => value.metadata?.version, set: version => { value.metadata!.version = version; } }),
};
const markerStart = '<!-- urlcode-current-version:start -->', markerEnd = '<!-- urlcode-current-version:end -->';
const markerBlock = /<!-- urlcode-current-version:start -->([\s\S]*?)<!-- urlcode-current-version:end -->/g;

interface Manifest { name: string; version: string; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; [key: string]: unknown }
interface Lock { version: string; packages: Record<string, { version?: string; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }> }
const readJson = async <T>(root: string, path: string): Promise<T> => JSON.parse(await readFile(join(root, path), 'utf8')) as T;
const render = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

function documentation(root: string): string[] {
  return execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    .filter(path => (path.endsWith('.md') || path === 'llms.txt' || path === 'llms-full.txt') && !path.endsWith('/CHANGELOG.md'));
}
/** Every version outside the marker blocks is history; every block names the current version. */
function markedVersions(text: string, path: string, version: string): number {
  assert.equal(text.split(markerStart).length, text.split(markerEnd).length, `${path}: current-version markers are unbalanced`);
  let blocks = 0;
  const outside = text.replace(markerBlock, (_whole, marked: string) => { assert(marked.includes(version), `${path}: a current-version block does not name ${version}`); blocks++; return ''; });
  assert(!outside.includes(version), `${path}: ${version} appears outside a current-version block`);
  return blocks;
}

/** Packages and the peers each must pin exactly: core (required) and every sibling add-on it names (optional). */
async function packages(root: string): Promise<{ path: string; manifest: Manifest; lockKey: string }[]> {
  const list = [{ path: 'package.json', manifest: await readJson<Manifest>(root, 'package.json'), lockKey: '' }];
  for (const addon of await addons(root)) {
    const dir = relative(root, addon.directory).split('\\').join('/');
    list.push({ path: `${dir}/package.json`, manifest: await readJson<Manifest>(root, `${dir}/package.json`), lockKey: dir });
  }
  return list;
}
function expectedPeers(manifest: Manifest, names: Set<string>, version: string): { peers: Record<string, string>; meta: Record<string, { optional: true }> } {
  const peers: Record<string, string> = {}, meta: Record<string, { optional: true }> = {};
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name === core) peers[name] = version;
    else if (names.has(name)) { peers[name] = version; meta[name] = { optional: true }; }
    else peers[name] = range;
  }
  return { peers, meta };
}

/** `root` is the checkout to read; tests pass a copy. */
export async function check(root = repositoryRoot): Promise<string> {
  const list = await packages(root), version = list[0]!.manifest.version, lock = await readJson<Lock>(root, 'package-lock.json');
  assert.match(version, versionPattern, `package.json version ${version} is not X.Y.Z or X.Y.Z-alpha.N`);
  const names = new Set(list.slice(1).map(item => item.manifest.name));
  assert.equal(lock.version, version, 'package-lock.json version differs from package.json');
  for (const { path, manifest, lockKey } of list) {
    assert.equal(manifest.version, version, `${path} is ${manifest.version}; every add-on shares core's version ${version}`);
    assert.equal(lock.packages[lockKey]?.version, version, `package-lock.json ${lockKey || 'root'} is not ${version}; run npm install`);
    if (!lockKey) continue;
    const { peers, meta } = expectedPeers(manifest, names, version);
    if (manifest.peerDependencies) assert.equal(manifest.peerDependencies[core], version, `${path} must peer on ${core} ${version} exactly`);
    assert.deepEqual(manifest.peerDependencies ?? {}, peers, `${path}: peers on core and sibling add-ons must be exactly ${version}`);
    for (const name of Object.keys(meta)) assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${path}: sibling peer ${name} must be optional so npm never installs a second copy`);
    assert.deepEqual(lock.packages[lockKey]?.peerDependencies ?? {}, manifest.peerDependencies ?? {}, `package-lock.json ${lockKey} peers differ; run npm install`);
  }
  for (const [path, pattern] of Object.entries(runtimePatterns)) {
    const found = [...(await readFile(join(root, path), 'utf8')).matchAll(pattern)].map(match => match[0]);
    assert.deepEqual(found, [version], `${path} must declare ${version} exactly once`);
  }
  for (const [path, access] of Object.entries(jsonVersions)) assert.equal(access(await readJson(root, path)).get(), version, `${path} is not ${version}`);
  let blocks = 0;
  for (const path of documentation(root)) blocks += markedVersions(await readFile(join(root, path), 'utf8'), path, version);
  assert(blocks > 0, 'No urlcode-current-version blocks found');
  return version;
}

export async function bump(version: string, root = repositoryRoot): Promise<string[]> {
  assert.match(version, versionPattern, 'Use X.Y.Z or X.Y.Z-alpha.N');
  const previous = await check(root);
  assert.notEqual(version, previous, `Already at ${version}`);
  assert(semver.gt(version, previous), `${version} is not newer than ${previous}; a release only moves forward`);
  const list = await packages(root), lock = await readJson<Lock>(root, 'package-lock.json'), names = new Set(list.slice(1).map(item => item.manifest.name)), changed: string[] = [];
  const write = async (path: string, text: string): Promise<void> => { await writeFile(join(root, path), text); changed.push(path); };
  lock.version = version;
  for (const { path, manifest, lockKey } of list) {
    manifest.version = version;
    const locked = lock.packages[lockKey]!;
    locked.version = version;
    if (lockKey && manifest.peerDependencies) {
      const { peers, meta } = expectedPeers(manifest, names, version);
      manifest.peerDependencies = peers;
      if (Object.keys(meta).length) manifest.peerDependenciesMeta = { ...manifest.peerDependenciesMeta, ...meta };
      locked.peerDependencies = { ...peers };
      if (manifest.peerDependenciesMeta) locked.peerDependenciesMeta = { ...manifest.peerDependenciesMeta };
    }
    await write(path, render(manifest));
  }
  await write('package-lock.json', render(lock));
  for (const [path, pattern] of Object.entries(runtimePatterns)) await write(path, (await readFile(join(root, path), 'utf8')).replace(pattern, version));
  for (const [path, access] of Object.entries(jsonVersions)) { const value = await readJson<{ version?: string; metadata?: { version?: string } }>(root, path); access(value).set(version); await write(path, render(value)); }
  for (const path of documentation(root)) {
    const text = await readFile(join(root, path), 'utf8');
    if (!text.includes(markerStart)) continue;
    const next = text.replace(markerBlock, (whole, marked: string) => whole.replace(marked, marked.replaceAll(previous, version)));
    if (next !== text) await write(path, next);
  }
  await check(root);
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [arg] = process.argv.slice(2);
  if (arg === '--check') process.stdout.write(`Every version declaration is ${await check()}\n`);
  else if (arg) process.stdout.write(`Bumped to ${arg}:\n${(await bump(arg)).map(path => `  ${path}`).join('\n')}\n`);
  else { process.stderr.write('Use: node scripts/release-bump.ts <version> | --check\n'); process.exit(2); }
}
