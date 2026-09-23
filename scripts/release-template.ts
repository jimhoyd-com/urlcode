// Explicit opt-in: open a checked template update PR; never bypass or merge checks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import { waitForInstallability } from './release-installability.ts';
import { npmCommand } from './release-npm.ts';
import { releaseIdentity } from './release-identity.ts';

const repository = 'jimhoyd-com/urlcode-template';
interface TemplateResult { url: string; number: number; head: string }
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
/** Copy application files from the exact published initializer, retaining only template-owned packaging and onboarding files. */
export async function copyPublishedTemplateStarter(directory: string, version: string): Promise<void> {
  const installed = join(directory, 'node_modules', '@jimhoyd', 'urlcode');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@jimhoyd/urlcode', 'Installed starter must belong to the runtime');
  assert.equal(manifest.version, version, 'Installed starter must match the selected runtime');
  const starter = join(installed, 'starters', 'default');
  const files = (await filesBelow(starter)).filter(path => !templateOwnsStarterPath(path));
  const previous = await recordedStarterFiles(directory);
  for (const path of previous) {
    if (!files.includes(path)) await rm(join(directory, path), { force: true });
  }
  for (const path of files) {
    assertGeneratedStarterPath(path);
    const destination = join(directory, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await copyFile(join(starter, path), destination);
  }
  await writeFile(join(directory, templateSourceManifest), JSON.stringify({ files }, null, 2) + '\n');
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
  const contents = JSON.parse(execFileSync('gh', ['api', `repos/${repository}/contents/package.json?ref=main`], { encoding: 'utf8', timeout: 60000 })) as { content: string; encoding: string };
  assert.equal(contents.encoding, 'base64');
  const manifest = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8'));
  const current = manifest.dependencies?.['@jimhoyd/urlcode'];
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
  const gh = (args: string[]) => execFileSync('gh', args, { encoding: 'utf8', timeout: 60000 });
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
      const contents = JSON.parse(gh(['api', `repos/${repository}/contents/package.json?ref=${existing[0].headRefOid}`])) as { content: string; encoding: string };
      assert.equal(contents.encoding, 'base64');
      const proposed = JSON.parse(Buffer.from(contents.content, 'base64').toString('utf8'));
      assertTemplateUpgrade(previous, version, proposed.dependencies?.['@jimhoyd/urlcode'] ?? '');
      const lockContents = JSON.parse(gh(['api', `repos/${repository}/contents/package-lock.json?ref=${existing[0].headRefOid}`])) as { content: string; encoding: string };
      assert.equal(lockContents.encoding, 'base64');
      assertTemplateLock(version, JSON.parse(Buffer.from(lockContents.content, 'base64').toString('utf8')));
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
    const files = run('git', ['ls-files', '-z']).split('\0').filter(file => file === 'README.md' || /\.ya?ml$/.test(file));
    for (const file of files) {
      const path = join(directory, file), original = await readFile(path, 'utf8');
      const updated = updateTemplateText(original, previous, version);
      if (updated !== original) await writeFile(path, updated);
    }
    run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
    assertTemplateLock(version, JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8')));
    run('npm', ['ci', '--ignore-scripts', '--registry=https://registry.npmjs.org']);
    await copyPublishedTemplateGuide(directory, version);
    for (const script of ['validate', 'test', 'audit']) run('npm', ['run', script]);
    run('npm', ['run', 'benchmark', '--', '--requests', '50', '--concurrency', '2']);
    run('git', ['add', '--all']);
    if (run('git', ['status', '--porcelain']).trim()) run('git', [...releaseIdentity, 'commit', '-m', `Pin starter runtime to ${version}`]);
    run('git', ['push', 'origin', branch]); // Never force an existing branch.
    const body = join(directory, '.git', 'release-pr.md');
    await writeFile(body, `Pin the standalone starter to @jimhoyd/urlcode@${version}, refresh its lockfile and matching schema/documentation references, and synchronize the generated authoring guide, skills and MCP registration.\n\nValidation: npm ci, validate, test, audit and a 50-request benchmark passed against the published package.\n`);
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
