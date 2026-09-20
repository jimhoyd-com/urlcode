// Local, reviewable coordinated alpha preparation. Never tags, merges or publishes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { parse } from 'yaml';

const directories = ['.', 'packages/ui', 'packages/auth', 'packages/admin'];
interface Manifest { name: string; version: string; peerDependencies?: Record<string, string> }
interface Lock { version: string; lockfileVersion: number; packages: Record<string, Manifest> }
export interface Edit { path: string; before: string | null; after: string | null }
export interface Preparation { version: string; pendingChangesets: string[]; edits: Edit[]; consumesChangesets: boolean }
interface Options { consumeChangesets?: boolean; notes?: string }
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
}

export async function planPreparation(root: string, version: string, options: Options = {}): Promise<Preparation> {
  assert.equal(semver.valid(version), version, 'Provide an exact semantic version');
  assert.match(version, /^\d+\.\d+\.\d+-alpha\.\d+$/, 'Only explicit alpha versions are supported');
  await checkReleaseConsistency(root);
  const packages = await manifests(root);
  for (const pkg of packages) assert(semver.gt(version, pkg.version), `${pkg.name}: target must be newer than ${pkg.version}`);
  const pre = JSON.parse(await readFile(join(root, '.changeset/pre.json'), 'utf8')) as { mode: string; tag: string };
  assert(pre.mode === 'pre' && pre.tag === 'alpha', 'Expected existing Changesets alpha prerelease mode');
  const pendingChangesets = (await readdir(join(root, '.changeset'))).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
  const changes: { name: string; content: string; packages: string[]; summary: string }[] = [];
  for (const name of pendingChangesets) {
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
  const edits: Edit[] = [];
  async function edit(path: string, after: string | null): Promise<void> {
    const before = await optional(root, path);
    if (before !== after) edits.push({ path, before, after });
  }
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as Lock;
  lock.version = version;
  const nextMinor = `${semver.major(version)}.${semver.minor(version) + 1}.0`;
  for (const [index, pkg] of packages.entries()) {
    pkg.version = version;
    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      if (packages.some(item => item.name === peer)) pkg.peerDependencies![peer] = `>=${version} <${nextMinor}`;
    }
    const directory = directories[index]!;
    await edit(join(directory, 'package.json'), json(pkg));
    const locked = lock.packages[index === 0 ? '' : directory]!;
    locked.version = version;
    if (pkg.peerDependencies) locked.peerDependencies = { ...pkg.peerDependencies };
    if (index > 0) {
      const path = `${directory}/CHANGELOG.md`;
      const before = await readFile(join(root, path), 'utf8');
      assert(before.startsWith(`# ${pkg.name}\n`), `${path}: unexpected changelog heading`);
      const summaries = options.consumeChangesets ? changes.filter(change => change.packages.includes(pkg.name)).map(change => change.summary) : [];
      const notes = [options.notes?.trim(), ...summaries].filter(Boolean);
      const entry = `## ${version}\n\nAlign the coordinated alpha release at \`${version}\`.${Object.keys(pkg.peerDependencies ?? {}).some(peer => packages.some(item => item.name === peer)) ? ' Internal peer minimums advance to this release.' : ''}\n${notes.length ? `\n${notes.join('\n\n')}\n` : ''}`;
      await edit(path, before.replace(`# ${pkg.name}\n`, `# ${pkg.name}\n\n${entry}`));
    }
  }
  await edit('package-lock.json', json(lock));
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
  const releasePath = `docs/RELEASE-${version}.md`;
  assert.equal(await optional(root, releasePath), null, `${releasePath} already exists; review it rather than overwriting`);
  const summaries = options.consumeChangesets ? changes.map(change => `### ${change.name}\n\n${change.summary}`) : [];
  await edit(releasePath, `# URLCode ${version}\n\nCore, UI, auth and admin share this explicitly selected alpha version. This does not enable permanent fixed versioning. Internal peer minimums advance to this version; install the coordinated set together.\n\n\`\`\`sh\nnpm install --save-exact ${packages.map(pkg => `${pkg.name}@${version}`).join(' ')}\n\`\`\`\n\n${options.notes?.trim() ? `${options.notes.trim()}\n\n` : ''}${summaries.length ? `${summaries.join('\n\n')}\n\n` : ''}Publish to the npm \`alpha\` channel in core → UI → auth → admin order after exact-commit CI and candidate verification. Existing tags and the \`latest\` channel stay unchanged. Update the standalone starter's exact core pin after registry installability is verified. This preparation is not evidence of publication or an independent security assessment.\n`);
  if (options.consumeChangesets) {
    for (const change of changes) {
      const archived = `.changeset/pre/${change.name}`;
      assert.equal(await optional(root, archived), null, `Changeset archive already exists: ${archived}`);
      await edit(archived, change.content);
      await edit(`.changeset/${change.name}`, null);
    }
  }
  // A durable receipt records the explicit version decision and which pending
  // changes were consumed; Changesets' independent-package config is untouched.
  const receipt = `.changeset/pre/coordinated-${version}.md`;
  assert.equal(await optional(root, receipt), null, `Release preparation receipt already exists: ${receipt}`);
  await edit(receipt, `# Coordinated ${version}\n\nThe maintainer explicitly selected this alpha version for core and all extensions. The local release preparation helper applied it directly, including core (which is not a Changesets workspace). Independent package versioning remains enabled.\n\nConsumed Changesets: ${options.consumeChangesets && pendingChangesets.length ? pendingChangesets.join(', ') : 'none'}.\n`);
  return { version, pendingChangesets, edits, consumesChangesets: options.consumeChangesets ?? false };
}

export async function applyPreparation(root: string, plan: Preparation): Promise<void> {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(git('status', '--porcelain'), '', 'Preparation requires a clean checkout; commit or preserve existing work first');
  const branch = git('branch', '--show-current');
  assert(branch && !['main', 'master'].includes(branch), 'Prepare on a branch, not main or detached HEAD');
  assert(plan.consumesChangesets || plan.pendingChangesets.length === 0, 'Pending Changesets require explicit --consume-changesets');
  const packages = await manifests(root);
  for (const [index, pkg] of packages.entries()) {
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
  if (args.includes('--help')) { console.log('release:prepare --version <X.Y.Z-alpha.N> [--notes <file>] [--consume-changesets] [--execute]\nDry-run by default. --check checks metadata consistency only. No tags, PRs or publication.'); return; }
  if (args.length === 1 && args[0] === '--check') { await checkReleaseConsistency(process.cwd()); console.log('Release metadata is consistent.'); return; }
  const options: Options = {};
  let version: string | undefined;
  let execute = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--execute') execute = true;
    else if (arg === '--consume-changesets') options.consumeChangesets = true;
    else if (arg === '--version' || arg === '--notes') {
      const value = args[++index];
      assert(value && !value.startsWith('--'), `${arg} needs a value`);
      if (arg === '--version') version = value;
      else options.notes = await readFile(resolve(value), 'utf8');
    } else throw new Error(`Unknown option: ${arg}`);
  }
  assert(version, 'Provide --version <X.Y.Z-alpha.N>');
  const plan = await planPreparation(process.cwd(), version, options);
  console.log(json({ version, execute, pendingChangesets: plan.pendingChangesets, consumesChangesets: plan.consumesChangesets, files: plan.edits.map(edit => edit.path) }));
  if (execute) { await applyPreparation(process.cwd(), plan); console.log('Prepared local edits. Review the diff, generate/check docs, run verification, and open a release PR. Nothing published.'); }
  else console.log('Dry run: no files changed. Use --execute on a clean branch to apply.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
}
