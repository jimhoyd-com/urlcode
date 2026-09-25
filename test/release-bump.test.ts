import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bump, check } from '../scripts/release-bump.ts';

const core = '@jimhoyd/urlcode';
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';

/** A minimal checkout carrying one of every version declaration release-bump owns, all at `version`. */
async function fixture(version = '1.0.0'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-bump-'));
  const files: Record<string, string> = {
    'package.json': json({ name: core, version, devDependencies: { typescript: '6.0.3' } }),
    'packages/ui/urlcode.json': json({ kind: 'extension', name: 'ui' }),
    'packages/ui/package.json': json({ name: '@jimhoyd/urlcode-ui', version, peerDependencies: { [core]: version } }),
    'packages/audit/urlcode.json': json({ kind: 'extension', name: 'audit' }),
    'packages/audit/package.json': json({ name: '@jimhoyd/urlcode-audit', version, peerDependencies: { [core]: version } }),
    'packages/auth/urlcode.json': json({ kind: 'extension', name: 'auth', requires: ['ui', 'audit'] }),
    'packages/auth/package.json': json({
      name: '@jimhoyd/urlcode-auth', version,
      // audit is a required sibling peer (auth imports it at runtime); ui stays optional.
      peerDependencies: { [core]: version, '@jimhoyd/urlcode-audit': version, '@jimhoyd/urlcode-ui': version, typescript: '>=6.0.3 <7.0.0' },
      peerDependenciesMeta: { '@jimhoyd/urlcode-ui': { optional: true }, typescript: { optional: true } },
    }),
    'artifacts/site/urlcode.json': json({ kind: 'artifact', name: 'site' }),
    'artifacts/site/package.json': json({ name: '@jimhoyd/urlcode-site', version }),
    'packages/core/src/cli.ts': `const VERSION = '${version}';\n`,
    'packages/core/src/mcp.ts': `const info = {serverInfo:{name:'urlcode',version:'${version}'}};\n`,
    'starters/default/app/urlcode.yaml': `# yaml-language-server: $schema=https://raw.githubusercontent.com/jimhoyd-com/urlcode/v${version}/schemas/urlcode.schema.json\nroutes: []\n`,
    'starters/default/.github/workflows/urlcode.yml': `steps:\n  - uses: jimhoyd-com/urlcode/action@v${version}\n`,
    'packaging/claude-plugin/.claude-plugin/plugin.json': json({ name: 'urlcode', version }),
    '.claude-plugin/marketplace.json': json({ name: 'urlcode', metadata: { version } }),
    'README.md': `Introduced in 0.1.0.\n\n<!-- urlcode-current-version:start -->\nCurrent: ${version}.\n<!-- urlcode-current-version:end -->\n`,
    'docs/GUIDE.md': 'No version here.\n',
    'packages/ui/CHANGELOG.md': `## ${version}\n`,
  };
  const manifests = ['packages/ui', 'packages/audit', 'packages/auth', 'artifacts/site'];
  const lock = { name: core, version, lockfileVersion: 3, packages: Object.fromEntries([
    ['', { name: core, version }],
    ...manifests.map(dir => {
      const { name: _name, ...rest } = JSON.parse(files[`${dir}/package.json`]!) as Record<string, unknown>;
      return [dir, rest];
    }),
  ]) };
  files['package-lock.json'] = json(lock);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}
const read = async (root: string, path: string): Promise<string> => readFile(join(root, path), 'utf8');
const readJson = async <T = Record<string, unknown>>(root: string, path: string): Promise<T> => JSON.parse(await read(root, path)) as T;
async function edit(root: string, path: string, change: (text: string) => string): Promise<void> {
  await writeFile(join(root, path), change(await read(root, path)));
}
async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fixture();
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('bump rewrites every version declaration and check accepts the result', () => withFixture(async root => {
  assert.equal(await check(root), '1.0.0');
  const changed = await bump('1.1.0-alpha.1', root);
  assert.equal(await check(root), '1.1.0-alpha.1');
  for (const path of ['package.json', 'packages/ui/package.json', 'packages/auth/package.json', 'artifacts/site/package.json']) {
    assert.equal((await readJson(root, path)).version, '1.1.0-alpha.1', path);
    assert(changed.includes(path), path);
  }
  const lock = await readJson<{ version: string; packages: Record<string, { version: string; peerDependencies?: Record<string, string> }> }>(root, 'package-lock.json');
  assert.equal(lock.version, '1.1.0-alpha.1');
  for (const key of ['', 'packages/ui', 'packages/auth', 'artifacts/site']) assert.equal(lock.packages[key]!.version, '1.1.0-alpha.1', key);
  assert.deepEqual(lock.packages['packages/auth']!.peerDependencies, { [core]: '1.1.0-alpha.1', '@jimhoyd/urlcode-audit': '1.1.0-alpha.1', '@jimhoyd/urlcode-ui': '1.1.0-alpha.1', typescript: '>=6.0.3 <7.0.0' });
  assert.equal(await read(root, 'packages/core/src/cli.ts'), "const VERSION = '1.1.0-alpha.1';\n");
  assert.match(await read(root, 'packages/core/src/mcp.ts'), /version:'1\.1\.0-alpha\.1'/);
  assert.match(await read(root, 'starters/default/app/urlcode.yaml'), /urlcode\/v1\.1\.0-alpha\.1\/schemas\/urlcode\.schema\.json/);
  assert.match(await read(root, 'starters/default/.github/workflows/urlcode.yml'), /action@v1\.1\.0-alpha\.1\n/);
  assert.equal((await readJson(root, 'packaging/claude-plugin/.claude-plugin/plugin.json')).version, '1.1.0-alpha.1');
  assert.deepEqual((await readJson(root, '.claude-plugin/marketplace.json')).metadata, { version: '1.1.0-alpha.1' });
  // Only the marked block moves; history outside it and changelogs are left alone, and untouched files are not rewritten.
  assert.equal(await read(root, 'README.md'), 'Introduced in 0.1.0.\n\n<!-- urlcode-current-version:start -->\nCurrent: 1.1.0-alpha.1.\n<!-- urlcode-current-version:end -->\n');
  assert.equal(await read(root, 'packages/ui/CHANGELOG.md'), '## 1.0.0\n');
  assert(!changed.includes('docs/GUIDE.md'));
}));

test('peers on core and sibling add-ons become exact, siblings optional except a runtime import, other peers untouched', () => withFixture(async root => {
  await bump('2.0.0', root);
  const auth = await readJson<{ peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional?: boolean }> }>(root, 'packages/auth/package.json');
  assert.deepEqual(auth.peerDependencies, { [core]: '2.0.0', '@jimhoyd/urlcode-audit': '2.0.0', '@jimhoyd/urlcode-ui': '2.0.0', typescript: '>=6.0.3 <7.0.0' });
  assert.deepEqual(auth.peerDependenciesMeta, { '@jimhoyd/urlcode-ui': { optional: true }, typescript: { optional: true } });
  assert.equal(await check(root), '2.0.0');
  assert.deepEqual((await readJson(root, 'packages/ui/package.json')).peerDependencies, { [core]: '2.0.0' });
  assert.equal((await readJson(root, 'artifacts/site/package.json')).peerDependencies, undefined);
}));

test('bump refuses a malformed version, the current version and an older one without writing anything', () => withFixture(async root => {
  const before = await read(root, 'package.json');
  for (const version of ['v1.2.0', '1.2', '1.2.0-beta.1', '1.2.0-alpha', '']) await assert.rejects(bump(version, root), /X\.Y\.Z/, version);
  await assert.rejects(bump('1.0.0', root), /Already at 1\.0\.0/);
  await assert.rejects(bump('0.9.9', root), /0\.9\.9 is not newer than 1\.0\.0; a release only moves forward/);
  await assert.rejects(bump('1.0.0-alpha.1', root), /is not newer than 1\.0\.0/);
  assert.equal(await read(root, 'package.json'), before);
}));

test('bump refuses to start from a checkout whose declarations already disagree', () => withFixture(async root => {
  await edit(root, 'packages/core/src/cli.ts', () => "const VERSION = '0.9.0';\n");
  await assert.rejects(bump('1.1.0', root), /cli\.ts must declare 1\.0\.0 exactly once/);
  assert.equal((await readJson(root, 'package.json')).version, '1.0.0');
}));

const drifts: [string, (root: string) => Promise<void>, RegExp][] = [
  ['an add-on version', root => edit(root, 'artifacts/site/package.json', text => text.replace('"1.0.0"', '"1.0.1"')), /artifacts\/site\/package\.json is 1\.0\.1/],
  ['the lockfile', root => edit(root, 'package-lock.json', text => text.replace('"version": "1.0.0"', '"version": "0.9.0"')), /package-lock\.json version differs/],
  ['a ranged core peer', root => edit(root, 'packages/ui/package.json', text => text.replace(`"${core}": "1.0.0"`, `"${core}": "^1.0.0"`)), /must peer on @jimhoyd\/urlcode 1\.0\.0 exactly/],
  ['an optional runtime-imported sibling peer', root => edit(root, 'packages/auth/package.json', text => text.replace('"peerDependenciesMeta": {', '"peerDependenciesMeta": {\n    "@jimhoyd/urlcode-audit": {\n      "optional": true\n    },')), /sibling peer @jimhoyd\/urlcode-audit is imported at runtime and must be a required peer/],
  ['a required sibling peer', root => edit(root, 'packages/auth/package.json', text => text.replace('"@jimhoyd/urlcode-ui": {\n      "optional": true\n    },', '')), /sibling peer @jimhoyd\/urlcode-ui must be optional/],
  ['a runtime literal', root => edit(root, 'packages/core/src/mcp.ts', text => text.replace('1.0.0', '0.9.0')), /mcp\.ts must declare 1\.0\.0 exactly once/],
  ['a duplicated runtime literal', root => edit(root, 'starters/default/.github/workflows/urlcode.yml', text => text + text.slice('steps:\n'.length)), /urlcode\.yml must declare 1\.0\.0 exactly once/],
  ['the plugin manifest', root => edit(root, '.claude-plugin/marketplace.json', text => text.replace('1.0.0', '0.9.0')), /marketplace\.json is not 1\.0\.0/],
  ['a current version outside its markers', root => edit(root, 'docs/GUIDE.md', () => 'Install 1.0.0.\n'), /GUIDE\.md: 1\.0\.0 appears outside a current-version block/],
  ['a stale marker block', root => edit(root, 'README.md', text => text.replace('Current: 1.0.0', 'Current: 0.9.0')), /README\.md: a current-version block does not name 1\.0\.0/],
  ['unbalanced markers', root => edit(root, 'README.md', text => text.replace('<!-- urlcode-current-version:end -->', '')), /markers are unbalanced/],
];
for (const [name, drift, message] of drifts) {
  test(`check fails on drift in ${name}`, () => withFixture(async root => {
    await drift(root);
    await assert.rejects(check(root), message);
  }));
}

test('the command line --check passes on this checkout and a missing argument exits 2', () => withFixture(async root => {
  // The CLI reads this checkout; the fixture proves the exported check the CLI calls, so only exit codes are compared here.
  const script = join(process.cwd(), 'scripts', 'release-bump.ts');
  assert.match(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' }), /^Every version declaration is \S+\n$/);
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }), (error: { status?: number }) => error.status === 2);
  assert.equal(await check(root), '1.0.0');
}));
