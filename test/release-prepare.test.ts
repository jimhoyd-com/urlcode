import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyPreparation, checkReleaseConsistency, planPreparation } from '../scripts/release-prepare.ts';

const old = '0.4.0-alpha.3';
const next = '0.4.0-alpha.4';
const names = ['@jimhoyd/urlcode', '@jimhoyd/urlcode-ui', '@jimhoyd/urlcode-auth', '@jimhoyd/urlcode-admin'];
const dirs = ['', 'packages/ui', 'packages/auth', 'packages/admin'];
const encode = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-release-prepare-'));
  async function put(path: string, text: string): Promise<void> { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); }
  const manifests = names.map((name, index) => ({ name, version: old, description: 'Keep this unchanged', ...(index > 1 ? { peerDependencies: Object.fromEntries(names.slice(0, index).map(peer => [peer, `>=${old} <0.5.0`])) } : {}) }));
  for (const [index, manifest] of manifests.entries()) {
    await put(join(dirs[index]!, 'package.json'), encode(manifest));
    if (index > 0) await put(`${dirs[index]}/CHANGELOG.md`, `# ${manifest.name}\n\n## ${old}\n\nPrevious release.\n`);
  }
  await put('package-lock.json', encode({ version: old, lockfileVersion: 3, packages: { ...Object.fromEntries(dirs.map((dir, index) => [dir, manifests[index]])), 'node_modules/unrelated': { version: '1.2.3', integrity: 'do-not-change' } } }));
  await put('src/cli.ts', `const usage = \`URLCode ${old} — runtime\`;\n`);
  await put('src/mcp.ts', `const response = {serverInfo:{name:'urlcode',version:'${old}'}};\n`);
  await put('packaging/claude-plugin/.claude-plugin/plugin.json', encode({ version: old, name: 'urlcode' }));
  await put('.claude-plugin/marketplace.json', encode({ metadata: { version: old }, plugins: [] }));
  await put('.changeset/pre.json', encode({ mode: 'pre', tag: 'alpha' }));
  await put('.changeset/config.json', encode({ fixed: [], linked: [] }));
  await put('.changeset/README.md', 'Instructions\n');
  for (const path of ['README.md', 'docs/DEVELOPMENT-PIPELINE.md', 'docs/INSTALL.md', 'docs/STARTERS.md', 'docs/VERSION-ALIGNMENT.md', 'docs/NEW-GUIDE.md']) {
    await put(path, `Before\n<!-- urlcode-current-version:start -->\nCurrent release: ${old}\n<!-- urlcode-current-version:end -->\nAfter\n`);
  }
  for (const path of ['llms.txt', 'llms-full.txt']) {
    await put(path, `<!-- urlcode-current-version:start -->\nAI release: ${old}\n<!-- urlcode-current-version:end -->\n`);
  }
  await put('docs/RELEASE-0.3.0.md', `Historical release: ${old}\n`);
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'pipe' }); };
  git('init', '-b', 'codex/release-test');
  git('config', 'user.email', 'release-test@example.invalid'); git('config', 'user.name', 'Release test');
  git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
  return root;
}
async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fixture();
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const read = (root: string, path: string): Promise<string> => readFile(join(root, path), 'utf8');
function commit(root: string): void {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Pending change'], { cwd: root, stdio: 'pipe' });
}

test('coordinated plan is read-only and applies consistent consumer metadata while preserving dependency resolutions', async () => withFixture(async root => {
  const before = await read(root, 'package-lock.json');
  const plan = await planPreparation(root, next, { notes: 'Adds a reviewed improvement.' });
  assert.equal(await read(root, 'package-lock.json'), before);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  await applyPreparation(root, plan);
  await checkReleaseConsistency(root);
  const lock = JSON.parse(await read(root, 'package-lock.json'));
  assert.deepEqual(lock.packages['node_modules/unrelated'], { version: '1.2.3', integrity: 'do-not-change' });
  assert.equal(lock.packages['packages/admin'].peerDependencies['@jimhoyd/urlcode-auth'], `>=${next} <0.5.0`);
  assert.match(await read(root, 'packages/ui/CHANGELOG.md'), /Adds a reviewed improvement/);
  assert.match(await read(root, `docs/RELEASE-${next}.md`), /npm install --save-exact @jimhoyd\/urlcode@0.4.0-alpha.4/);
  for (const path of ['README.md', 'docs/DEVELOPMENT-PIPELINE.md', 'docs/INSTALL.md', 'docs/STARTERS.md', 'docs/VERSION-ALIGNMENT.md', 'docs/NEW-GUIDE.md']) {
    assert.equal(await read(root, path), `Before\n<!-- urlcode-current-version:start -->\nCurrent release: ${next}\n<!-- urlcode-current-version:end -->\nAfter\n`);
  }
  for (const path of ['llms.txt', 'llms-full.txt']) {
    assert.equal(await read(root, path), `<!-- urlcode-current-version:start -->\nAI release: ${next}\n<!-- urlcode-current-version:end -->\n`);
  }
  assert.equal(await read(root, 'docs/RELEASE-0.3.0.md'), `Historical release: ${old}\n`);
  assert.equal(await read(root, '.changeset/config.json'), encode({ fixed: [], linked: [] }));
}));

test('pending changesets need explicit consumption and are archived with complete text and relevant changelogs', async () => withFixture(async root => {
  const content = '---\n"@jimhoyd/urlcode-auth": patch\n---\n\nFix the actual authentication race.\n';
  await writeFile(join(root, '.changeset/auth-fix.md'), content); commit(root);
  const blocked = await planPreparation(root, next);
  await assert.rejects(applyPreparation(root, blocked), /explicit --consume-changesets/);
  assert.equal(await read(root, '.changeset/auth-fix.md'), content);
  const plan = await planPreparation(root, next, { consumeChangesets: true });
  await applyPreparation(root, plan);
  assert.equal(await read(root, '.changeset/pre/auth-fix.md'), content);
  await assert.rejects(read(root, '.changeset/auth-fix.md'), /ENOENT/);
  assert.match(await read(root, 'packages/auth/CHANGELOG.md'), /actual authentication race/);
  assert.doesNotMatch(await read(root, 'packages/ui/CHANGELOG.md'), /actual authentication race/);
  assert.match(await read(root, `docs/RELEASE-${next}.md`), /actual authentication race/);
  assert.match(await read(root, `.changeset/pre/coordinated-${next}.md`), /auth-fix.md/);
}));

test('individual package preparation changes only its manifest, lock entry, changelog and receipt', async () => withFixture(async root => {
  const plan = await planPreparation(root, next, { scope: 'auth', notes: 'Release auth independently.' });
  assert.equal(plan.scope, 'auth');
  await applyPreparation(root, plan);
  assert.equal(JSON.parse(await read(root, 'package.json')).version, old);
  assert.equal(JSON.parse(await read(root, 'packages/ui/package.json')).version, old);
  assert.equal(JSON.parse(await read(root, 'packages/auth/package.json')).version, next);
  assert.equal(JSON.parse(await read(root, 'packages/admin/package.json')).version, old);
  const lock = JSON.parse(await read(root, 'package-lock.json'));
  assert.equal(lock.version, old);
  assert.equal(lock.packages['packages/auth'].version, next);
  assert.equal(lock.packages['packages/admin'].version, old);
  assert.equal(JSON.parse(await read(root, 'packages/auth/package.json')).peerDependencies['@jimhoyd/urlcode'], `>=${old} <0.5.0`);
  assert.match(await read(root, `docs/RELEASE-auth-${next}.md`), /@jimhoyd\/urlcode-auth@0.4.0-alpha.4/);
  assert.match(await read(root, `.changeset/pre/auth-${next}.md`), /urlcode-auth/);
  assert.equal(JSON.parse(await read(root, '.changeset/pre.json')).tag, 'alpha');
  assert.equal(await read(root, 'src/cli.ts'), `const usage = \`URLCode ${old} — runtime\`;\n`);
  await checkReleaseConsistency(root);
}));

test('individual changeset consumption leaves unrelated intent and rejects cross-scope changesets', async () => withFixture(async root => {
  await writeFile(join(root, '.changeset/auth.md'), '---\n"@jimhoyd/urlcode-auth": patch\n---\n\nAuth change.\n');
  await writeFile(join(root, '.changeset/ui.md'), '---\n"@jimhoyd/urlcode-ui": patch\n---\n\nUI change.\n');
  commit(root);
  const plan = await planPreparation(root, next, { scope: 'auth', consumeChangesets: true });
  assert.deepEqual(plan.pendingChangesets, ['auth.md']);
  await applyPreparation(root, plan);
  assert.match(await read(root, '.changeset/ui.md'), /UI change/);
  assert.match(await read(root, '.changeset/pre/auth.md'), /Auth change/);

  const second = await fixture();
  try {
    await writeFile(join(second, '.changeset/cross.md'), '---\n"@jimhoyd/urlcode-auth": patch\n"@jimhoyd/urlcode-ui": patch\n---\n\nShared change.\n');
    commit(second);
    await assert.rejects(planPreparation(second, next, { scope: 'auth', consumeChangesets: true }), /spans selected and unselected/);
  } finally { await rm(second, { recursive: true, force: true }); }
}));

test('preparation refuses downgrades, reused versions, unsupported prereleases and malformed versions', async () => withFixture(async root => {
  for (const version of ['0.4.0-alpha.2', old, '0.3.1', '0.4.1+build.1', '0.4.0-beta.1', 'v0.4.0-alpha.4', '0.4.0-alpha.04']) {
    await assert.rejects(planPreparation(root, version));
  }
}));

test('execution refuses main, detached HEAD, dirty state, and existing tags', async () => withFixture(async root => {
  const plan = await planPreparation(root, next);
  await writeFile(join(root, 'unrelated.txt'), 'User work');
  await assert.rejects(applyPreparation(root, plan), /clean checkout/);
  await rm(join(root, 'unrelated.txt'));
  execFileSync('git', ['branch', '-m', 'main'], { cwd: root });
  await assert.rejects(applyPreparation(root, plan), /Prepare on a branch/);
  execFileSync('git', ['switch', '--detach'], { cwd: root, stdio: 'pipe' });
  await assert.rejects(applyPreparation(root, plan), /Prepare on a branch/);
  execFileSync('git', ['switch', '-c', 'codex/release-again'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['tag', `v${next}`], { cwd: root });
  await assert.rejects(applyPreparation(root, plan), /Existing local release tag/);
  assert.equal(JSON.parse(await read(root, 'package.json')).version, old);
}));

test('consistency catches drift in duplicated versions and peer ranges before writing', async () => withFixture(async root => {
  await writeFile(join(root, 'src/cli.ts'), 'const usage = `URLCode 0.4.0-alpha.2 — runtime`;\n');
  await assert.rejects(checkReleaseConsistency(root), /runtime version differs/);
  await assert.rejects(planPreparation(root, next), /runtime version differs/);
  await writeFile(join(root, 'src/cli.ts'), `const usage = \`URLCode ${old} — runtime\`;\n`);
  const manifest = JSON.parse(await read(root, 'packages/auth/package.json'));
  manifest.peerDependencies['@jimhoyd/urlcode'] = '>=0.5.0';
  await writeFile(join(root, 'packages/auth/package.json'), encode(manifest));
  await assert.rejects(checkReleaseConsistency(root), /lock peers differ/);
}));

test('consistency requires current-version markers in live documentation', async () => withFixture(async root => {
  await writeFile(join(root, 'README.md'), `Current release: ${old}\n`);
  await assert.rejects(checkReleaseConsistency(root), /README\.md: current version .* must be inside/);
  await writeFile(join(root, 'README.md'), '<!-- urlcode-current-version:start -->\nStale release: 0.4.0-alpha.2\n<!-- urlcode-current-version:end -->\n');
  await assert.rejects(checkReleaseConsistency(root), /marked current-version block does not contain/);
  await writeFile(join(root, 'README.md'), `<!-- urlcode-current-version:start -->\nCurrent release: ${old}\n`);
  await assert.rejects(checkReleaseConsistency(root), /current-version markers are unbalanced/);
}));

test('independent package versions remain valid when lock metadata and peer compatibility agree', async () => withFixture(async root => {
  const manifest = JSON.parse(await read(root, 'packages/admin/package.json'));
  manifest.version = '0.4.0-alpha.4';
  await writeFile(join(root, 'packages/admin/package.json'), encode(manifest));
  const lock = JSON.parse(await read(root, 'package-lock.json'));
  lock.packages['packages/admin'].version = manifest.version;
  await writeFile(join(root, 'package-lock.json'), encode(lock));
  await checkReleaseConsistency(root);
}));

test('archive collisions and unsupported Changeset packages fail before edits', async () => withFixture(async root => {
  await writeFile(join(root, '.changeset/fix.md'), '---\n"@jimhoyd/unknown": patch\n---\n\nFix.\n');
  await assert.rejects(planPreparation(root, next, { consumeChangesets: true }), /Unknown Changeset package/);
  await writeFile(join(root, '.changeset/fix.md'), '---\n"@jimhoyd/urlcode-auth": patch\n---\n\nFix.\n');
  await mkdir(join(root, '.changeset/pre'), { recursive: true });
  await writeFile(join(root, '.changeset/pre/fix.md'), 'Historical archive');
  await assert.rejects(planPreparation(root, next, { consumeChangesets: true }), /archive already exists/);
  assert.equal(JSON.parse(await read(root, 'package.json')).version, old);
}));

test('a plan cannot overwrite tracked edits committed after its snapshot', async () => withFixture(async root => {
  const plan = await planPreparation(root, next);
  const manifest = JSON.parse(await read(root, 'package.json'));
  manifest.description = 'Newer contributor work';
  await writeFile(join(root, 'package.json'), encode(manifest)); commit(root);
  await assert.rejects(applyPreparation(root, plan), /changed since planning/);
  assert.equal(JSON.parse(await read(root, 'package.json')).description, 'Newer contributor work');
}));

test('post-write validation failure rolls all local changes back', async () => withFixture(async root => {
  const plan = await planPreparation(root, next);
  const runtime = plan.edits.find(edit => edit.path === 'src/cli.ts')!;
  runtime.after = `const usage = \`URLCode ${old} — runtime\`;\n`;
  await assert.rejects(applyPreparation(root, plan), /runtime version differs/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  await checkReleaseConsistency(root);
}));

test('npm prerelease peer semantics are respected, not broadened to any prerelease', async () => withFixture(async root => {
  const manifest = JSON.parse(await read(root, 'packages/ui/package.json'));
  manifest.version = '0.4.1-alpha.1';
  await writeFile(join(root, 'packages/ui/package.json'), encode(manifest));
  const lock = JSON.parse(await read(root, 'package-lock.json'));
  lock.packages['packages/ui'].version = manifest.version;
  await writeFile(join(root, 'package-lock.json'), encode(lock));
  await assert.rejects(checkReleaseConsistency(root), /does not satisfy/);
}));


test('CLI defaults to a read-only plan and explicit execution works in a clean release branch', async () => withFixture(async root => {
  const script = fileURLToPath(new URL('../scripts/release-prepare.ts', import.meta.url));
  const cli = (...args: string[]): string => execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  assert.match(cli('--version', next), /Dry run: no files changed/);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
  assert.throws(() => cli('--version'), /needs a value/);
  assert.throws(() => cli('--version', next, '--unknown'), /Unknown option/);
  assert.match(cli('--version', next, '--execute'), /Prepared local edits/);
  assert.match(cli('--check'), /Release metadata is consistent/);
  assert.equal(JSON.parse(await read(root, 'package.json')).version, next);
}));


test('stable transition exits prerelease mode and prepares latest metadata while preserving alpha history', async () => withFixture(async root => {
  await mkdir(join(root, '.changeset/pre'), { recursive: true });
  await writeFile(join(root, '.changeset/pre/historical-alpha.md'), 'Previously released alpha change.\n');
  await writeFile(join(root, '.changeset/stable-fix.md'), '---\n"@jimhoyd/urlcode-auth": patch\n---\n\nFix a reviewed authentication issue.\n');
  commit(root);
  const plan = await planPreparation(root, '0.4.1', { consumeChangesets: true });
  assert(plan.edits.some(edit => edit.path === '.changeset/pre.json' && edit.after === null));
  assert.equal(JSON.parse(await read(root, '.changeset/pre.json')).mode, 'pre', 'Planning must not exit prerelease mode');
  await applyPreparation(root, plan);
  await assert.rejects(read(root, '.changeset/pre.json'), /ENOENT/);
  await checkReleaseConsistency(root);
  for (const directory of dirs) assert.equal(JSON.parse(await read(root, join(directory, 'package.json'))).version, '0.4.1');
  assert.equal(JSON.parse(await read(root, 'packages/auth/package.json')).peerDependencies['@jimhoyd/urlcode'], '>=0.4.1 <0.5.0');
  assert.equal(await read(root, '.changeset/pre/historical-alpha.md'), 'Previously released alpha change.\n');
  assert.match(await read(root, 'packages/auth/CHANGELOG.md'), /coordinated stable release.*latest/);
  const notes = await read(root, 'docs/RELEASE-0.4.1.md');
  assert.match(notes, /Publish to the npm `latest` channel/);
  assert.match(notes, /`alpha` channel stay unchanged/);
  assert.match(notes, /reviewed authentication issue/);
  assert.match(await read(root, '.changeset/pre/coordinated-0.4.1.md'), /stable version.*`latest`/);
  assert.equal(await read(root, '.changeset/config.json'), encode({ fixed: [], linked: [] }));
}));

test('subsequent stable patch works without pre.json and does not implicitly reenter alpha mode', async () => withFixture(async root => {
  await applyPreparation(root, await planPreparation(root, '0.4.1')); commit(root);
  for (const version of ['0.3.1', '0.4.0', '0.4.1']) await assert.rejects(planPreparation(root, version), /target must be newer/);
  await assert.rejects(planPreparation(root, '0.4.2-alpha.1'), /entering prerelease mode must be an explicit separate decision/);
  const patch = await planPreparation(root, '0.4.2');
  assert(!patch.edits.some(edit => edit.path === '.changeset/pre.json'));
  await applyPreparation(root, patch);
  await checkReleaseConsistency(root);
  assert.equal(JSON.parse(await read(root, 'package.json')).version, '0.4.2');
  await assert.rejects(read(root, '.changeset/pre.json'), /ENOENT/);
}));

test('failed stable transition restores prerelease mode with all original files', async () => withFixture(async root => {
  const before = await read(root, '.changeset/pre.json');
  const plan = await planPreparation(root, '0.4.1');
  plan.edits.find(edit => edit.path === 'src/cli.ts')!.after = `const usage = \`URLCode ${old} — runtime\`;\n`;
  await assert.rejects(applyPreparation(root, plan), /runtime version differs/);
  assert.equal(await read(root, '.changeset/pre.json'), before);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
}));
