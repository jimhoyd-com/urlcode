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

test('preparation refuses downgrades, reused versions, non-alpha and malformed versions', async () => withFixture(async root => {
  for (const version of ['0.4.0-alpha.2', old, '0.4.0', '0.4.0-beta.1', 'v0.4.0-alpha.4', '0.4.0-alpha.04']) {
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
