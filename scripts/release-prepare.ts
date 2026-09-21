// Local, reviewable coordinated release preparation. Never tags, merges or publishes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { parse } from 'yaml';
import { assertPeerFloorCoversApi, coreName, raisedCorePeer, scaffoldApiUsed } from './peer-api.ts';

const directories = ['.', 'packages/ui', 'packages/auth', 'packages/admin', 'packages/store'] as const;
export type ReleaseScope = 'all' | 'core' | 'ui' | 'auth' | 'admin' | 'store';
const scopeDirectory: Record<Exclude<ReleaseScope, 'all'>, typeof directories[number]> = {
  core: '.', ui: 'packages/ui', auth: 'packages/auth', admin: 'packages/admin', store: 'packages/store',
};
export function directoriesForScope(scope: ReleaseScope): readonly string[] {
  return scope === 'all' ? directories : [scopeDirectory[scope]];
}
export function receiptPath(scope: ReleaseScope, version: string): string {
  return `.changeset/pre/${scope === 'all' ? 'coordinated' : scope}-${version}.md`;
}
interface Manifest { name: string; version: string; peerDependencies?: Record<string, string> }
interface Lock { version: string; lockfileVersion: number; packages: Record<string, Manifest> }
export interface Edit { path: string; before: string | null; after: string | null }
export interface Preparation { version: string; scope: ReleaseScope; pendingChangesets: string[]; edits: Edit[]; consumesChangesets: boolean }
interface Options { consumeChangesets?: boolean; notes?: string; scope?: ReleaseScope }
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
async function optional(root: string, path: string): Promise<string | null> {
  try { return await readFile(join(root, path), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function manifests(root: string): Promise<Manifest[]> {
  return Promise.all(directories.map(async dir => JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8')) as Manifest));
}
const runtimePatterns = {
  'src/cli.ts': /(?<=const usage = `URLCode )[^\s]+/g,
  'src/mcp.ts': /(?<=serverInfo:\{name:'urlcode',version:')[^']+/g,
};
const currentVersionStart = '<!-- urlcode-current-version:start -->';
const currentVersionEnd = '<!-- urlcode-current-version:end -->';
const currentVersionPattern = /<!-- urlcode-current-version:start -->([\s\S]*?)<!-- urlcode-current-version:end -->/g;
function liveDocumentationPaths(root: string): string[] {
  return execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(path =>
    (path.endsWith('.md') || path === 'llms.txt' || path === 'llms-full.txt') &&
    !path.startsWith('.changeset/') &&
    !path.startsWith('docs/archive/') &&
    !/^docs\/RELEASE-/.test(path) &&
    !path.endsWith('/CHANGELOG.md'));
}
function checkCurrentVersionMarkers(text: string, path: string, version: string): number {
  const starts = text.split(currentVersionStart).length - 1;
  const ends = text.split(currentVersionEnd).length - 1;
  assert.equal(starts, ends, `${path}: current-version markers are unbalanced`);
  let count = 0;
  const outside = text.replace(currentVersionPattern, (_whole, marked: string) => {
    assert(marked.includes(version), `${path}: marked current-version block does not contain ${version}`);
    count++;
    return '';
  });
  assert(!outside.includes(version), `${path}: current version ${version} must be inside urlcode-current-version markers`);
  return count;
}
function updateCurrentVersionMarkers(text: string, path: string, previous: string, next: string): string {
  checkCurrentVersionMarkers(text, path, previous);
  return text.replace(currentVersionPattern, (whole, marked: string) => whole.replace(marked, marked.replaceAll(previous, next)));
}
function runtimeVersion(text: string, pattern: RegExp, path: string): string {
  const matches = [...text.matchAll(pattern)];
  assert.equal(matches.length, 1, `${path}: expected exactly one runtime version declaration`);
  return matches[0]![0];
}

// Independent package versions are supported. This checks duplicated metadata,
// not a permanent fixed-version policy or a requirement to bump every peer floor.
export async function checkReleaseConsistency(root: string): Promise<void> {
  const packages = await manifests(root);
  const core = packages[0]!;
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as Lock;
  assert.equal(lock.lockfileVersion, 3, 'Expected npm lockfile version 3');
  assert.equal(lock.version, core.version, 'Root lock version differs from manifest');
  for (const [index, pkg] of packages.entries()) {
    assert.equal(semver.valid(pkg.version), pkg.version, `${pkg.name}: invalid version`);
    const key = index === 0 ? '' : directories[index]!;
    assert.equal(lock.packages[key]?.version, pkg.version, `${key || 'root'} lock version differs from manifest`);
    assert.deepEqual(lock.packages[key]?.peerDependencies ?? {}, pkg.peerDependencies ?? {}, `${pkg.name}: lock peers differ from manifest`);
    for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
      const local = packages.find(item => item.name === peer);
      if (local) assert(semver.satisfies(local.version, range), `${pkg.name}: ${peer}@${local.version} does not satisfy ${range}`);
    }
  }
  for (const [path, pattern] of Object.entries(runtimePatterns)) {
    assert.equal(runtimeVersion(await readFile(join(root, path), 'utf8'), pattern, path), core.version, `${path}: runtime version differs from core`);
  }
  const plugin = JSON.parse(await readFile(join(root, 'packaging/claude-plugin/.claude-plugin/plugin.json'), 'utf8')) as { version: string };
  const marketplace = JSON.parse(await readFile(join(root, '.claude-plugin/marketplace.json'), 'utf8')) as { metadata: { version: string } };
  assert.equal(plugin.version, core.version, 'Plugin version differs from core');
  assert.equal(marketplace.metadata.version, core.version, 'Marketplace version differs from core');
  let markedReferences = 0;
  for (const path of liveDocumentationPaths(root)) {
    const text = await readFile(join(root, path), 'utf8');
    markedReferences += checkCurrentVersionMarkers(text, path, core.version);
  }
  assert(markedReferences > 0, 'No current-version documentation markers found');
}

export async function planPreparation(root: string, version: string, options: Options = {}): Promise<Preparation> {
  assert.equal(semver.valid(version), version, 'Provide an exact semantic version');
  assert.match(version, /^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/, 'Only exact stable or alpha versions are supported');
  const alpha = semver.prerelease(version) !== null;
  const releaseKind = alpha ? 'alpha' : 'stable';
  const channel = alpha ? 'alpha' : 'latest';
  const scope = options.scope ?? 'all';
  const selectedDirectories = new Set(directoriesForScope(scope));
  await checkReleaseConsistency(root);
  const packages = await manifests(root);
  const previousCoreVersion = packages[0]!.version;
  for (const [index, pkg] of packages.entries()) {
    if (selectedDirectories.has(directories[index]!)) assert(semver.gt(version, pkg.version), `${pkg.name}: target must be newer than ${pkg.version}`);
  }
  const preText = await optional(root, '.changeset/pre.json');
  if (preText !== null) {
    const pre = JSON.parse(preText) as { mode: string; tag: string };
    assert(pre.mode === 'pre' && pre.tag === 'alpha', 'Expected existing Changesets alpha prerelease mode');
  }
  assert(!alpha || preText !== null, 'Alpha preparation requires existing Changesets alpha prerelease mode; entering prerelease mode must be an explicit separate decision');
  const pendingFiles = (await readdir(join(root, '.changeset'))).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
  const changes: { name: string; content: string; packages: string[]; summary: string }[] = [];
  for (const name of pendingFiles) {
    const content = await readFile(join(root, '.changeset', name), 'utf8');
    const parts = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
    assert(parts, `${name}: invalid Changeset frontmatter`);
    const metadata: unknown = parse(parts[1]!);
    assert(metadata && typeof metadata === 'object' && !Array.isArray(metadata), `${name}: invalid Changeset package map`);
    const entries = Object.entries(metadata);
    for (const [name, kind] of entries) {
      assert(packages.some(pkg => pkg.name === name), `Unknown Changeset package: ${name}`);
      assert(['patch', 'minor', 'major'].includes(String(kind)), `Unsupported Changeset release type: ${kind}`);
    }
    assert(parts[2]!.trim(), `${name}: empty Changeset summary`);
    changes.push({ name, content, packages: entries.map(([name]) => name), summary: parts[2]!.trim() });
  }
  const selectedNames = new Set(packages.filter((_pkg, index) => selectedDirectories.has(directories[index]!)).map(pkg => pkg.name));
  const selectedChanges = changes.filter(change => change.packages.some(name => selectedNames.has(name)));
  for (const change of selectedChanges) {
    assert(change.packages.every(name => selectedNames.has(name)), `${change.name}: changeset spans selected and unselected packages; release them together`);
  }
  const pendingChangesets = selectedChanges.map(change => change.name);
  const edits: Edit[] = [];
  async function edit(path: string, after: string | null): Promise<void> {
    const before = await optional(root, path);
    if (before !== after) edits.push({ path, before, after });
  }
  // Stable promotion exits Changesets prerelease mode in this same reviewable
  // plan. Later stable patches work without pre.json; historical archives stay.
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as Lock;
  if (selectedDirectories.has('.')) lock.version = version;
  const nextMinor = `${semver.major(version)}.${semver.minor(version) + 1}.0`;
  for (const [index, pkg] of packages.entries()) {
    const directory = directories[index]!;
    if (!selectedDirectories.has(directory)) continue;
    pkg.version = version;
    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      const peerIndex = packages.findIndex(item => item.name === peer);
      if (peerIndex >= 0 && selectedDirectories.has(directories[peerIndex]!)) pkg.peerDependencies![peer] = `>=${version} <${nextMinor}`;
    }
    // A floor also rises for the core API the package's scaffold needs (#346), from the in-repo core that
    // already has it: a package released alone keeps its peer floor otherwise, and would pair with a core
    // that lacks the API. Refuses when the in-repo core does not have it yet, or when the floor still falls short.
    if (index > 0) {
      const raised = selectedDirectories.has('.') ? undefined : raisedCorePeer(pkg.name, await scaffoldApiUsed(root, directory), pkg.peerDependencies, packages[0]!.version);
      if (raised) pkg.peerDependencies = { ...pkg.peerDependencies, [coreName]: raised };
      await assertPeerFloorCoversApi(root, directory, pkg.name, pkg.peerDependencies);
    }
    await edit(join(directory, 'package.json'), json(pkg));
    const locked = lock.packages[index === 0 ? '' : directory]!;
    locked.version = version;
    if (pkg.peerDependencies) locked.peerDependencies = { ...pkg.peerDependencies };
    if (index > 0) {
      const path = `${directory}/CHANGELOG.md`;
      const before = await readFile(join(root, path), 'utf8');
      assert(before.startsWith(`# ${pkg.name}\n`), `${path}: unexpected changelog heading`);
      const summaries = options.consumeChangesets ? selectedChanges.filter(change => change.packages.includes(pkg.name)).map(change => change.summary) : [];
      const notes = [options.notes?.trim(), ...summaries].filter(Boolean);
      const entry = `## ${version}\n\nAlign the coordinated ${releaseKind} release at \`${version}\` on npm’s \`${channel}\` channel.${Object.keys(pkg.peerDependencies ?? {}).some(peer => packages.some(item => item.name === peer)) ? ' Internal peer minimums advance to this release.' : ''}\n${notes.length ? `\n${notes.join('\n\n')}\n` : ''}`;
      await edit(path, before.replace(`# ${pkg.name}\n`, `# ${pkg.name}\n\n${entry}`));
    }
  }
  const projected = packages.map((pkg, index) => selectedDirectories.has(directories[index]!) ? version : pkg.version);
  const hasAlpha = projected.some(item => semver.prerelease(item) !== null);
  if (!hasAlpha && preText !== null) await edit('.changeset/pre.json', null);
  await edit('package-lock.json', json(lock));
  if (selectedDirectories.has('.')) {
    for (const path of liveDocumentationPaths(root)) {
      const before = await readFile(join(root, path), 'utf8');
      const after = updateCurrentVersionMarkers(before, path, previousCoreVersion, version);
      await edit(path, after);
    }
    for (const [path, pattern] of Object.entries(runtimePatterns)) {
      const before = await readFile(join(root, path), 'utf8');
      await edit(path, before.replace(pattern, version));
    }
    const pluginPath = 'packaging/claude-plugin/.claude-plugin/plugin.json';
    const plugin = JSON.parse(await readFile(join(root, pluginPath), 'utf8')) as { version: string };
    plugin.version = version;
    await edit(pluginPath, json(plugin));
    const marketplacePath = '.claude-plugin/marketplace.json';
    const marketplace = JSON.parse(await readFile(join(root, marketplacePath), 'utf8')) as { metadata: { version: string } };
    marketplace.metadata.version = version;
    await edit(marketplacePath, json(marketplace));
  }
  const selectedPackages = packages.filter((_pkg, index) => selectedDirectories.has(directories[index]!));
  const releasePath = `docs/RELEASE-${scope === 'all' ? '' : `${scope}-`}${version}.md`;
  assert.equal(await optional(root, releasePath), null, `${releasePath} already exists; review it rather than overwriting`);
  const summaries = options.consumeChangesets ? selectedChanges.map(change => `### ${change.name}\n\n${change.summary}`) : [];
  const releaseChanges = [options.notes?.trim(), ...summaries].filter(Boolean).join('\n\n') || 'No package behavior changes were recorded for this release.';
  await edit(releasePath, `# URLCode ${scope === 'all' ? '' : `${scope} `}${version}\n\n${scope === 'all' ? 'Core, UI, auth, admin and store share' : selectedPackages[0]!.name + ' uses'} this explicitly selected ${releaseKind} version. Independent package versioning remains enabled.\n\n\`\`\`sh\nnpm install --save-exact ${selectedPackages.map(pkg => `${pkg.name}@${version}`).join(' ')}\n\`\`\`\n\n## Changes\n\n<!-- github-release-notes:start -->\n${releaseChanges}\n<!-- github-release-notes:end -->\n\nPublish to the npm \`${channel}\` channel only after exact-commit CI and candidate verification. Existing tags and the \`${alpha ? 'latest' : 'alpha'}\` channel stay unchanged.${!hasAlpha && preText !== null ? ' Changesets prerelease mode is exited.' : ''}${selectedDirectories.has('.') ? ' Update the standalone starter after core registry installability is verified.' : ''} This preparation is not evidence of publication or an independent security assessment.\n`);
  if (options.consumeChangesets) {
    for (const change of selectedChanges) {
      const archived = `.changeset/pre/${change.name}`;
      assert.equal(await optional(root, archived), null, `Changeset archive already exists: ${archived}`);
      await edit(archived, change.content);
      await edit(`.changeset/${change.name}`, null);
    }
  }
  // A durable receipt records the explicit version decision and which pending
  // changes were consumed; Changesets' independent-package config is untouched.
  const receipt = receiptPath(scope, version);
  assert.equal(await optional(root, receipt), null, `Release preparation receipt already exists: ${receipt}`);
  await edit(receipt, `# ${scope === 'all' ? 'Coordinated' : scope} ${version}\n\nThe maintainer explicitly selected this ${releaseKind} version for ${scope === 'all' ? 'core and all extensions' : selectedPackages[0]!.name}, targeting npm \`${channel}\`. Independent package versioning remains enabled.\n\nConsumed Changesets: ${options.consumeChangesets && pendingChangesets.length ? pendingChangesets.join(', ') : 'none'}.\n`);
  return { version, scope, pendingChangesets, edits, consumesChangesets: options.consumeChangesets ?? false };
}

export async function applyPreparation(root: string, plan: Preparation): Promise<void> {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(git('status', '--porcelain'), '', 'Preparation requires a clean checkout; commit or preserve existing work first');
  const branch = git('branch', '--show-current');
  assert(branch && !['main', 'master'].includes(branch), 'Prepare on a branch, not main or detached HEAD');
  assert(plan.consumesChangesets || plan.pendingChangesets.length === 0, 'Pending Changesets require explicit --consume-changesets');
  const packages = await manifests(root);
  const selectedDirectories = new Set(directoriesForScope(plan.scope));
  for (const [index, pkg] of packages.entries()) {
    if (!selectedDirectories.has(directories[index]!)) continue;
    const tag = index === 0 ? `v${plan.version}` : `${pkg.name}@${plan.version}`;
    assert.equal(git('tag', '--list', tag), '', `Existing local release tag ${tag}; do not reuse a released version`);
  }
  for (const edit of plan.edits) assert.equal(await optional(root, edit.path), edit.before, `${edit.path} changed since planning`);
  const applied: Edit[] = [];
  try {
    for (const edit of plan.edits) {
      applied.push(edit);
      if (edit.after === null) await rm(join(root, edit.path));
      else { await mkdir(dirname(join(root, edit.path)), { recursive: true }); await writeFile(join(root, edit.path), edit.after); }
    }
    await checkReleaseConsistency(root);
  } catch (error) {
    for (const edit of applied.reverse()) {
      if (edit.before === null) await rm(join(root, edit.path), { force: true });
      else await writeFile(join(root, edit.path), edit.before);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('release:prepare --version <X.Y.Z|X.Y.Z-alpha.N> [--package all|core|ui|auth|admin|store] [--notes <file>] [--consume-changesets] [--execute]\nDry-run by default. --check checks metadata consistency only. No tags, PRs or publication.'); return; }
  if (args.length === 1 && args[0] === '--check') { await checkReleaseConsistency(process.cwd()); console.log('Release metadata is consistent.'); return; }
  const options: Options = {};
  let version: string | undefined;
  let scope: ReleaseScope = 'all';
  let execute = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--execute') execute = true;
    else if (arg === '--consume-changesets') options.consumeChangesets = true;
    else if (arg === '--version' || arg === '--notes' || arg === '--package') {
      const value = args[++index];
      assert(value && !value.startsWith('--'), `${arg} needs a value`);
      if (arg === '--version') version = value;
      else if (arg === '--notes') options.notes = await readFile(resolve(value), 'utf8');
      else { assert(['all', 'core', 'ui', 'auth', 'admin', 'store'].includes(value), 'Unknown release package'); scope = value as ReleaseScope; }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  assert(version, 'Provide --version <X.Y.Z|X.Y.Z-alpha.N>');
  const plan = await planPreparation(process.cwd(), version, { ...options, scope });
  console.log(json({ version, scope, execute, pendingChangesets: plan.pendingChangesets, consumesChangesets: plan.consumesChangesets, files: plan.edits.map(edit => edit.path) }));
  if (execute) { await applyPreparation(process.cwd(), plan); console.log('Prepared local edits. Review the diff, generate/check docs, run verification, and open a release PR. Nothing published.'); }
  else console.log('Dry run: no files changed. Use --execute on a clean branch to apply.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
