// Explicit opt-in: open a checked template update PR; never bypass or merge checks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { waitForInstallability } from './release-installability.ts';
import { npmCommand } from './npm-command.ts';
import { releaseIdentity } from './release-identity.ts';

const repository = 'jimhoyd-com/urlcode-template';
interface TemplateResult { url: string; number: number; head: string }
function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 60000 });
}
/** Fetch and decode a JSON file from the template repository's GitHub contents API at `ref`. */
function fetchTemplateJsonFile<T>(ref: string, path: string): T {
  const contents = JSON.parse(gh(['api', `repos/${repository}/contents/${path}?ref=${ref}`])) as { content: string; encoding: string };
  assert.equal(contents.encoding, 'base64');
  return JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8')) as T;
}
export function assertTemplateUpgrade(current: string, target: string, proposed = target): void {
  assert.equal(semver.valid(current), current, 'Template dependency must already be an exact version');
  assert.equal(semver.valid(target), target, 'Template requires an exact valid version');
  assert(semver.gte(target, current), 'Refusing template runtime downgrade');
  assert.equal(proposed, target, 'Existing template PR has a different runtime pin');
}
// The template pins the runtime as a local dependency, so the bare `urlcode` command the default starter registers is not
// on PATH there. `npx --no --package` runs the installed copy and refuses to fetch (a bare `npx urlcode` names an unrelated package).
export function localMcpConfig(installedConfig: string): string {
  const config = JSON.parse(installedConfig) as { mcpServers: Record<string, { command: string; args: string[] }> };
  const server = config.mcpServers?.urlcode;
  assert(server && Array.isArray(server.args), 'Installed .mcp.json must register the urlcode server');
  if (server.command === 'urlcode') config.mcpServers.urlcode = { command: 'npx', args: ['--no', '--package', '@jimhoyd/urlcode', 'urlcode', ...server.args] };
  return JSON.stringify(config, null, 2) + '\n';
}
const templateSkills = ['urlcode-authoring', 'urlcode-operations'] as const;
const templateOwnedStarterPaths = new Set(['AGENTS.md', '.mcp.json', 'README.md', 'starter.json', 'gitignore.template']);
const templateSourceManifest = '.urlcode-starter-source.json';
/**
 * Every application file the template sync owns: what the starter ships now plus what earlier starters shipped.
 * The first source manifest recorded only the files the starter had then, so manifest tracking alone never removes
 * the older example app (#570); this list does. A path here that the published starter no longer ships is deleted
 * from the template, and a new starter file must be added here before it can be synchronized.
 */
export const templateSyncedPaths: readonly string[] = [
  'urlcode.yaml', 'Makefile', '.gitattributes', 'tests/requests.json',
  // The example app the starter shipped before the bare starter (#503).
  'functions/hello.mjs', 'middleware/headers.mjs', 'routes/functions.yaml', 'routes/marketing/links.yaml',
];
function templateOwnsStarterPath(path: string): boolean {
  return templateOwnedStarterPaths.has(path) || path.startsWith('.github/');
}
async function filesBelow(directory: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(join(directory, entry.name), path));
    else {
      assert(entry.isFile(), `Starter contains unsupported entry: ${path}`);
      files.push(path);
    }
  }
  return files.sort();
}
function assertGeneratedStarterPath(path: string): void {
  assert.match(path, /^(?:[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._-]+)*$/, `Invalid generated starter path: ${path}`);
  assert(!templateOwnsStarterPath(path), `Template-owned path cannot be generated: ${path}`);
}
async function recordedStarterFiles(directory: string): Promise<string[]> {
  try {
    const contents = JSON.parse(await readFile(join(directory, templateSourceManifest), 'utf8')) as { files?: unknown };
    assert(Array.isArray(contents.files), 'Template source manifest must contain a files array');
    const files = contents.files.map(String).sort();
    for (const path of files) assertGeneratedStarterPath(path);
    assert.equal(new Set(files).size, files.length, 'Template source manifest must not contain duplicate files');
    return files;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function removeWithEmptyParents(directory: string, path: string): Promise<void> {
  await rm(join(directory, path), { force: true });
  for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
    try { await rmdir(join(directory, parent)); } catch { break; } // not empty, or already gone
  }
}
/** Copy application files from the exact published initializer, retaining only template-owned packaging and onboarding files. */
export async function copyPublishedTemplateStarter(directory: string, version: string): Promise<void> {
  const installed = join(directory, 'node_modules', '@jimhoyd', 'urlcode');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@jimhoyd/urlcode', 'Installed starter must belong to the runtime');
  assert.equal(manifest.version, version, 'Installed starter must match the selected runtime');
  const starter = join(installed, 'starters', 'default');
  const files = (await filesBelow(starter)).filter(path => !templateOwnsStarterPath(path));
  for (const path of files) assert(templateSyncedPaths.includes(path), `Starter ships ${path}, which the template sync does not own; add it to templateSyncedPaths`);
  // Owned paths the starter stopped shipping go whether or not a manifest ever recorded them.
  const stale = new Set([...await recordedStarterFiles(directory), ...templateSyncedPaths]);
  for (const path of stale) {
    if (!files.includes(path)) await removeWithEmptyParents(directory, path);
  }
  for (const path of files) {
    assertGeneratedStarterPath(path);
    const destination = join(directory, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await copyFile(join(starter, path), destination);
  }
  await writeFile(join(directory, templateSourceManifest), JSON.stringify({ files }, null, 2) + '\n');
}
/**
 * The template README is template-owned and never rewritten by the sync, so it can keep documenting an app the
 * starter no longer ships. Refuse the release when it names a synchronized path that is absent from the template.
 */
export async function assertTemplateReadmeCurrent(directory: string): Promise<void> {
  const readme = await readFile(join(directory, 'README.md'), 'utf8');
  const missing: string[] = [];
  for (const path of templateSyncedPaths) {
    if (!readme.includes(path)) continue;
    try { await access(join(directory, path)); } catch { missing.push(path); }
  }
  assert.deepEqual(missing, [], `Template README.md references files the template no longer contains: ${missing.join(', ')}. Update README.md in ${repository} first`);
}
/** Copy application files, authoring guidance, skills and MCP registration from the exact installed runtime, never a newer checkout. */
export async function copyPublishedTemplateGuide(directory: string, version: string): Promise<void> {
  const installed = join(directory, 'node_modules', '@jimhoyd', 'urlcode');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@jimhoyd/urlcode', 'Installed guide must belong to the runtime');
  assert.equal(manifest.version, version, 'Installed guide must match the selected runtime');
  await copyPublishedTemplateStarter(directory, version);
  await copyFile(join(installed, 'starters', 'default', 'AGENTS.md'), join(directory, 'AGENTS.md'));
  // Missing files fail the release loudly: a silently skipped copy is how the template's skills went stale.
  for (const skill of templateSkills) {
    await mkdir(join(directory, '.claude', 'skills', skill), { recursive: true });
    await copyFile(join(installed, '.claude', 'skills', skill, 'SKILL.md'), join(directory, '.claude', 'skills', skill, 'SKILL.md'));
  }
  await writeFile(join(directory, '.mcp.json'), localMcpConfig(await readFile(join(installed, 'starters', 'default', '.mcp.json'), 'utf8')));
}

/** Recheck immediately before merging a previously prepared template PR. */
export function assertTemplateCurrent(version: string): boolean {
  const manifest = fetchTemplateJsonFile<{ dependencies?: Record<string, string> }>('main', 'package.json');
  const current = manifest.dependencies?.['@jimhoyd/urlcode'];
  assert(current, 'Template package.json is missing the runtime dependency');
  assertTemplateUpgrade(current, version);
  return current !== version;
}

export function assertTemplateLock(version: string, lock: { packages?: Record<string, { version?: string; dependencies?: Record<string, string> }> }): void {
  assert.equal(lock.packages?.['']?.dependencies?.['@jimhoyd/urlcode'], version, 'Template lock root does not match runtime pin');
  assert.equal(lock.packages?.['node_modules/@jimhoyd/urlcode']?.version, version, 'Template installed lock entry does not match runtime pin');
}

export function updateTemplateText(text: string, previous: string, version: string): string {
  const escaped = previous.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Restrict prose replacements to current-pin statements: historical migration
  // notes deliberately retain the version in which behavior changed.
  return text.replace(new RegExp(`/v${escaped}/`, 'g'), `/v${version}/`)
    .replace(new RegExp('(Under the pinned |In the |This template pins the )`' + escaped + '`(?= runtime| published)', 'g'), `$1\`${version}\``)
    .replace(/(https:\/\/raw\.githubusercontent\.com\/jimhoyd-com\/urlcode\/)[^/]+(\/schemas\/urlcode\.schema\.json)/g, `$1v${version}$2`);
}

/** Rewrites version references in the template's README and YAML files; listed paths that no longer exist are skipped. */
export async function updateTemplateFiles(directory: string, files: string[], previous: string, version: string): Promise<void> {
  for (const file of files.filter(file => file === 'README.md' || /\.ya?ml$/.test(file))) {
    const path = join(directory, file);
    let original: string;
    try { original = await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const updated = updateTemplateText(original, previous, version);
    if (updated !== original) await writeFile(path, updated);
  }
}

export async function updateTemplate(version: string, options: { execute?: boolean } = {}): Promise<TemplateResult | undefined> {
  assert.equal(semver.valid(version), version, 'Template requires an exact valid version');
  const branch = `codex/runtime-${version.replaceAll('.', '-')}`;
  if (!options.execute) {
    console.log(JSON.stringify({ repository, branch, version, action: 'validate and open template PR; pass --execute to write' }));
    return;
  }
  const source = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(source.name, '@jimhoyd/urlcode', 'Run template updates from the release checkout');
  assert.equal(source.version, version, 'Run template updates from the selected core manifest version');
  await waitForInstallability({ name: '@jimhoyd/urlcode', version });
  const existing = JSON.parse(gh(['pr', 'list', '--repo', repository, '--head', branch, '--state', 'open', '--json', 'url,number,headRefOid'])) as Array<{ url: string; number: number; headRefOid: string }>;

  const directory = await mkdtemp(join(tmpdir(), 'urlcode-template-release-'));
  try {
    const run = (command: string, args: string[]) => {
      const invocation = command === 'npm' ? npmCommand(args) : { command, args };
      return execFileSync(invocation.command, invocation.args, { cwd: directory, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
    };
    run('git', ['clone', '--depth', '1', `https://github.com/${repository}.git`, '.']);
    let manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const previous = manifest.dependencies?.['@jimhoyd/urlcode'];
    assertTemplateUpgrade(previous, version);
    if (previous === version) { console.log(`Template already pins ${version}`); return; }
    if (existing[0]) {
      const proposed = fetchTemplateJsonFile<{ dependencies?: Record<string, string> }>(existing[0].headRefOid, 'package.json');
      assertTemplateUpgrade(previous, version, proposed.dependencies?.['@jimhoyd/urlcode'] ?? '');
      const lock = fetchTemplateJsonFile<{ packages?: Record<string, { version?: string; dependencies?: Record<string, string> }> }>(existing[0].headRefOid, 'package-lock.json');
      assertTemplateLock(version, lock);
      return { url: existing[0].url, number: existing[0].number, head: existing[0].headRefOid };
    }
    const remoteBranch = run('git', ['ls-remote', '--heads', 'origin', branch]).trim();
    if (remoteBranch) {
      run('git', ['fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`]);
      run('git', ['switch', '--track', `origin/${branch}`]);
      const resumed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      assert.equal(resumed.dependencies?.['@jimhoyd/urlcode'], version, 'Existing release branch has a different runtime pin');
      manifest = resumed;
    } else run('git', ['switch', '-c', branch]);
    manifest.dependencies['@jimhoyd/urlcode'] = version;
    await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
    assertTemplateLock(version, JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8')));
    run('npm', ['ci', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
    await copyPublishedTemplateGuide(directory, version);
    await assertTemplateReadmeCurrent(directory);
    // After the copy, not before: copying replaces urlcode.yaml with the published starter's, so rewriting first
    // left the template on whatever schema pin that starter carried (#557).
    await updateTemplateFiles(directory, run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0'), previous, version);
    // Not `audit` or `benchmark`: the bare starter (#503) ships with zero example routes by
    // design. `urlcode audit` refuses "ready" for any project with no active routes regardless
    // of --expect-routes, and `urlcode benchmark` refuses outright ("No GET/HEAD workload") with
    // nothing to request, so neither can ever pass here. Both still work fine run standalone
    // once routes are added.
    for (const script of ['validate', 'test']) run('npm', ['run', script]);
    run('git', ['add', '--all']);
    if (run('git', ['status', '--porcelain']).trim()) run('git', [...releaseIdentity, 'commit', '-m', `Pin starter runtime to ${version}`]);
    run('git', ['push', 'origin', branch]); // Never force an existing branch.
    const body = join(directory, '.git', 'release-pr.md');
    await writeFile(body, `Pin the standalone starter to @jimhoyd/urlcode@${version}, refresh its lockfile and matching schema/documentation references, and synchronize the generated authoring guide, skills and MCP registration.\n\nValidation: npm ci, validate and test passed against the published package.\n`);
    const url = run('gh', ['pr', 'create', '--repo', repository, '--head', branch, '--base', 'main', '--title', `Pin starter runtime to ${version}`, '--body-file', body]).trim();
    const pr = JSON.parse(gh(['pr', 'view', url, '--repo', repository, '--json', 'url,number,headRefOid'])) as { url: string; number: number; headRefOid: string };
    return { url: pr.url, number: pr.number, head: pr.headRefOid };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const version = process.argv[process.argv.indexOf('--version') + 1];
  assert(process.argv.includes('--version') && version, 'Usage: node scripts/release-template.ts --version VERSION [--execute]');
  console.log(JSON.stringify(await updateTemplate(version, { execute: process.argv.includes('--execute') }) ?? { complete: true }));
}
