// Core and every add-on share one version. release-please (release-please-config.json, run by
// .github/workflows/release.yml) chooses the next one from the conventional commits since the last release and keeps
// a release pull request open that moves every declaration it can: package.json and its lockfile entry, each add-on's
// version and exact peers, the examples' core dependency, CORE_VERSION, the Claude plugin manifests and every
// x-release-please-start-version block in the Markdown. This script is only what release-please cannot do:
//
//   node scripts/release-versions.ts sync    in the release pull request: move the pinned links in non-Markdown text
//                                            and rebuild llms-full.txt (the workflow runs npm install for the lockfile)
//   node scripts/release-versions.ts check   fail unless every declaration agrees (`npm run check:code`)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLlmsFull } from './build-llms-full.ts';
import { addons, repositoryRoot } from './workspaces.ts';

const versionPattern = /^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/;
const core = '@jimhoyd/urlcode';
const CORE_VERSION = /^export const CORE_VERSION = '([^']+)'; \/\/ x-release-please-version$/m;
/** release-please's generic updater: the first match on each marked line becomes the new version. */
const RELEASE_PLEASE_VERSION = /\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[-\w.]+)?/g;
const LLMS_FULL = 'llms-full.txt';
/**
 * This repository at a release tag, as pinned in non-Markdown text (#948): `blob/` and `tree/` links, the raw schema
 * URL and the starter's Action ref.
 */
const PINNED_RELEASE = /(?<=jimhoyd-com\/urlcode\/(?:(?:blob|tree)\/|action@)?v)\d+\.\d+\.\d+(?:-alpha\.\d+)?(?=[/\s#)"'`]|$)/gm;

interface Manifest { name: string; version: string; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>; [key: string]: unknown }
interface Lock { version: string; packages: Record<string, { version?: string; peerDependencies?: Record<string, string> }> }
interface ExtraFile { type: string; path: string; jsonpath?: string; glob?: boolean }
const readJson = async <T>(root: string, path: string): Promise<T> => JSON.parse(await readFile(join(root, path), 'utf8')) as T;
const tracked = (root: string): string[] => execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
/** Authored documentation. llms-full.txt is generated from it, and changelogs are history. */
const documentation = (root: string): string[] => tracked(root).filter(path => (path.endsWith('.md') || path === 'llms.txt') && !/(?:^|\/)CHANGELOG\.md$/.test(path));
/** Tracked non-Markdown release text; this repository's own tests, scripts and workflows are not release text. */
const pinnedText = (root: string): string[] => tracked(root).filter(path => /\.(?:json|ya?ml|txt|toml|html|css)$/.test(path) && !['llms.txt', LLMS_FULL, 'package-lock.json'].includes(path) && !/^(?:\.github|scripts|test)\/|^packages\/[^/]+\/(?:scripts|test)\//.test(path));

/**
 * What release-please's generic updater would do to a Markdown file, checked before it runs: every line inside a block
 * (and a line carrying the inline marker) whose first version-looking token is not the current version would be
 * corrupted (`127.0.0.1`), and a second copy of the version on one line would be left behind.
 */
function markedVersions(text: string, path: string, version: string): number {
  let blocks = 0, open = false;
  for (const [index, line] of text.split('\n').entries()) {
    const where = `${path}:${index + 1}`;
    const starts = line.includes('x-release-please-start-version'), ends = line.includes('x-release-please-end');
    if (starts) { assert(!open, `${where}: a version block opens inside another`); open = true; blocks++; continue; }
    const found = [...line.matchAll(RELEASE_PLEASE_VERSION)].map(match => match[0]);
    if (open || line.includes('x-release-please-version')) {
      if (found.length) assert.equal(found[0], version, `${where}: release-please replaces the first version on a marked line, and here that is ${found[0]}, not ${version}; move it out of the block`);
      assert(!found.slice(1).includes(version), `${where}: ${version} appears twice on one marked line; release-please moves only the first`);
    } else assert(!line.includes(version), `${where}: ${version} appears outside an x-release-please-start-version block`);
    if (ends) { assert(open, `${where}: x-release-please-end without a start`); open = false; }
  }
  assert(!open, `${path}: an x-release-please-start-version block is never closed`);
  return blocks;
}

/** The release-please extra files this checkout needs: every add-on and example that names the shared version. */
async function expectedExtraFiles(root: string): Promise<ExtraFile[]> {
  const files: ExtraFile[] = [
    { type: 'generic', path: 'packages/core/src/release.ts' },
    { type: 'generic', path: 'llms.txt' },
    { type: 'generic', path: '**/*.md', glob: true },
  ];
  const json = (path: string, jsonpath: string): number => files.push({ type: 'json', path, jsonpath });
  const names = new Set((await addons(root)).map(addon => addon.packageName));
  for (const addon of await addons(root)) {
    const path = `${relative(root, addon.directory).split('\\').join('/')}/package.json`, manifest = await readJson<Manifest>(root, path);
    json(path, '$.version');
    for (const name of Object.keys(manifest.peerDependencies ?? {})) if (name === core || names.has(name)) json(path, `$.peerDependencies['${name}']`);
  }
  for (const { path, fields } of await examples(root)) for (const field of fields) json(path, `$.${field}['${core}']`);
  json('packaging/claude-plugin/.claude-plugin/plugin.json', '$.version');
  json('.claude-plugin/marketplace.json', '$.metadata.version');
  return files;
}
// Example projects (examples/<name>/package.json) that depend on core pin it exactly at the release version.
const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
async function examples(root: string): Promise<{ path: string; manifest: Record<string, Record<string, string> | undefined>; fields: string[] }[]> {
  const list = [];
  for (const entry of (await readdir(join(root, 'examples'), { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `examples/${entry.name}/package.json`;
    const text = entry.isDirectory() ? await readFile(join(root, path), 'utf8').catch(() => null) : null;
    if (text === null) continue;
    const manifest = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    const fields = dependencyFields.filter(field => manifest[field]?.[core] !== undefined);
    if (fields.length) list.push({ path, manifest, fields });
  }
  return list;
}

/** `root` is the checkout to read; tests pass a copy. */
export async function check(root = repositoryRoot): Promise<string> {
  const version = (await readJson<Manifest>(root, 'package.json')).version, lock = await readJson<Lock>(root, 'package-lock.json');
  assert.match(version, versionPattern, `package.json version ${version} is not X.Y.Z or X.Y.Z-alpha.N`);
  assert.equal((await readJson<Record<string, string>>(root, '.release-please-manifest.json'))['.'], version, '.release-please-manifest.json differs from package.json');
  assert.equal(lock.version, version, 'package-lock.json version differs from package.json');
  assert.equal(lock.packages['']?.version, version, 'package-lock.json root is not the package.json version');
  const list = await addons(root), names = new Set(list.map(addon => addon.packageName));
  for (const addon of list) {
    const dir = relative(root, addon.directory).split('\\').join('/'), manifest = await readJson<Manifest>(root, `${dir}/package.json`);
    assert.equal(manifest.version, version, `${dir}/package.json is ${manifest.version}; every add-on shares core's version ${version}`);
    assert.equal(lock.packages[dir]?.version, version, `package-lock.json ${dir} is not ${version}; run npm install`);
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (name !== core && !names.has(name)) continue;
      assert.equal(range, version, `${dir}/package.json must peer on ${name} ${version} exactly`);
      if (name !== core) assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${dir}/package.json: sibling peer ${name} must be optional so npm never installs a second copy`);
    }
    assert.deepEqual(lock.packages[dir]?.peerDependencies ?? {}, manifest.peerDependencies ?? {}, `package-lock.json ${dir} peers differ; run npm install`);
  }
  for (const { path, manifest, fields } of await examples(root)) {
    for (const field of fields) assert.equal(manifest[field]![core], version, `${path} depends on ${core} ${manifest[field]![core]}; an example pins core's version ${version} exactly`);
  }
  assert.equal(CORE_VERSION.exec(await readFile(join(root, 'packages/core/src/release.ts'), 'utf8'))?.[1], version, `packages/core/src/release.ts must declare CORE_VERSION = '${version}' with its x-release-please-version marker`);
  assert.equal((await readJson<{ version?: string }>(root, 'packaging/claude-plugin/.claude-plugin/plugin.json')).version, version, 'plugin.json is not the package.json version');
  assert.equal((await readJson<{ metadata?: { version?: string } }>(root, '.claude-plugin/marketplace.json')).metadata?.version, version, 'marketplace.json is not the package.json version');
  const configured = (await readJson<{ packages: Record<string, { 'extra-files'?: ExtraFile[] }> }>(root, 'release-please-config.json')).packages['.']?.['extra-files'] ?? [];
  const key = (file: ExtraFile): string => JSON.stringify([file.type, file.path, file.jsonpath ?? null, file.glob ?? false]);
  assert.deepEqual(configured.map(key).sort(), (await expectedExtraFiles(root)).map(key).sort(), 'release-please-config.json extra-files must list exactly the version declarations of this checkout');
  let blocks = 0;
  for (const path of documentation(root)) blocks += markedVersions(await readFile(join(root, path), 'utf8'), path, version);
  assert(blocks > 0, 'No x-release-please-start-version blocks found');
  for (const path of pinnedText(root)) {
    for (const match of (await readFile(join(root, path), 'utf8')).matchAll(PINNED_RELEASE)) assert.equal(match[0], version, `${path} links this repository at v${match[0]}; a pinned link names the current version ${version}`);
  }
  if (tracked(root).includes(LLMS_FULL)) assert(await readFile(join(root, LLMS_FULL), 'utf8') === await buildLlmsFull(root), `${LLMS_FULL} is not built for ${version}; run npm run docs:llms`);
  return version;
}

/** The release pull request's follow-up to release-please: pinned links and llms-full.txt, at package.json's version. */
export async function sync(root = repositoryRoot): Promise<string[]> {
  const version = (await readJson<Manifest>(root, 'package.json')).version, changed: string[] = [];
  const write = async (path: string, text: string): Promise<void> => {
    if (text === await readFile(join(root, path), 'utf8').catch(() => null)) return;
    await writeFile(join(root, path), text);
    changed.push(path);
  };
  for (const path of pinnedText(root)) await write(path, (await readFile(join(root, path), 'utf8')).replace(PINNED_RELEASE, version));
  if (tracked(root).includes(LLMS_FULL)) await write(LLMS_FULL, await buildLlmsFull(root));
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command] = process.argv.slice(2);
  if (command === 'check') process.stdout.write(`Every version declaration is ${await check()}\n`);
  else if (command === 'sync') process.stdout.write(`Synced to ${(await readJson<Manifest>(repositoryRoot, 'package.json')).version}:${(await sync()).map(path => `\n  ${path}`).join('') || ' nothing to change'}\n`);
  else { process.stderr.write('Use: node scripts/release-versions.ts check | sync\n'); process.exit(2); }
}
