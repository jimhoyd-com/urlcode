import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { check, sync } from '../scripts/release-versions.ts';
import { buildLlmsFull } from '../scripts/build-llms-full.ts';

const core = '@jimhoyd/urlcode';
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
const extraFiles = [
  { type: 'generic', path: 'packages/core/src/release.ts' },
  { type: 'generic', path: 'llms.txt' },
  { type: 'generic', path: '**/*.md', glob: true },
  { type: 'json', path: 'packages/audit/package.json', jsonpath: '$.version' },
  { type: 'json', path: 'packages/audit/package.json', jsonpath: `$.peerDependencies['${core}']` },
  { type: 'json', path: 'packages/auth/package.json', jsonpath: '$.version' },
  { type: 'json', path: 'packages/auth/package.json', jsonpath: `$.peerDependencies['${core}']` },
  { type: 'json', path: 'packages/auth/package.json', jsonpath: "$.peerDependencies['@jimhoyd/urlcode-audit']" },
  { type: 'json', path: 'artifacts/site/package.json', jsonpath: '$.version' },
  { type: 'json', path: 'examples/cloudflare/package.json', jsonpath: `$.dependencies['${core}']` },
  { type: 'json', path: 'packaging/claude-plugin/.claude-plugin/plugin.json', jsonpath: '$.version' },
  { type: 'json', path: '.claude-plugin/marketplace.json', jsonpath: '$.metadata.version' },
];

/** A minimal checkout carrying one of every version declaration, all at `version`. */
async function fixture(version = '1.0.0'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-versions-'));
  const files: Record<string, string> = {
    'package.json': json({ name: core, version, devDependencies: { typescript: '6.0.3' } }),
    '.release-please-manifest.json': json({ '.': version }),
    'release-please-config.json': json({ packages: { '.': { 'release-type': 'node', 'extra-files': extraFiles } } }),
    'packages/audit/urlcode.json': json({ kind: 'extension', name: 'audit' }),
    'packages/audit/package.json': json({ name: '@jimhoyd/urlcode-audit', version, peerDependencies: { [core]: version } }),
    'packages/auth/urlcode.json': json({ kind: 'extension', name: 'auth', requires: ['audit'] }),
    'packages/auth/package.json': json({
      name: '@jimhoyd/urlcode-auth', version,
      peerDependencies: { [core]: version, '@jimhoyd/urlcode-audit': version, typescript: '>=6.0.3 <7.0.0' },
      peerDependenciesMeta: { '@jimhoyd/urlcode-audit': { optional: true }, typescript: { optional: true } },
    }),
    'artifacts/site/urlcode.json': json({ kind: 'artifact', name: 'site' }),
    'artifacts/site/package.json': json({ name: '@jimhoyd/urlcode-site', version }),
    'examples/cloudflare/package.json': json({ name: 'cloudflare-example', private: true, type: 'module', dependencies: { [core]: version }, devDependencies: { wrangler: '^4' } }),
    'examples/aws/package.json': json({ name: 'aws-example', private: true, dependencies: { other: '^1.0.0' } }),
    'packages/core/src/release.ts': `export const CORE_VERSION = '${version}'; // x-release-please-version\n`,
    'llms.txt': `<!-- x-release-please-start-version -->\n# URLCode ${version}\n<!-- x-release-please-end -->\n\n## Start\n`,
    'starters/default/app/urlcode.yaml': `# yaml-language-server: $schema=https://raw.githubusercontent.com/jimhoyd-com/urlcode/v${version}/schemas/urlcode.schema.json\nroutes: []\n`,
    'starters/default/.github/workflows/urlcode.yml': `steps:\n  - uses: jimhoyd-com/urlcode/action@v${version}\n`,
    'packaging/claude-plugin/.claude-plugin/plugin.json': json({ name: 'urlcode', version }),
    '.claude-plugin/marketplace.json': json({ name: 'urlcode', metadata: { version } }),
    'README.md': `Introduced in 0.1.0.\n\n<!-- x-release-please-start-version -->\nCurrent: ${version}, served on 127.0.0.1.\n<!-- x-release-please-end -->\n`,
    'docs/INSTALL.md': `\`\`\`sh\nversion=${version} # x-release-please-version\n\`\`\`\n`,
    'docs/GUIDE.md': 'No version here.\n',
    'schemas/urlcode.schema.json': json({ description: `Matching rules in https://github.com/jimhoyd-com/urlcode/blob/v${version}/docs/ROUTING.md.` }),
    'examples/site/urlcode.yaml': `# See https://github.com/jimhoyd-com/urlcode/blob/v${version}/docs/SITE.md#robots.\nroutes: {}\n`,
    'test/fixture.json': json({ historical: 'https://github.com/jimhoyd-com/urlcode/blob/v0.1.0/docs/X.md' }),
    'packages/audit/CHANGELOG.md': `## ${version}\n`,
  };
  const manifests = ['packages/audit', 'packages/auth', 'artifacts/site'];
  files['package-lock.json'] = json({ name: core, version, lockfileVersion: 3, packages: Object.fromEntries([
    ['', { name: core, version }],
    ...manifests.map(dir => {
      const { name: _name, ...rest } = JSON.parse(files[`${dir}/package.json`]!) as Record<string, unknown>;
      return [dir, rest];
    }),
  ]) });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await writeFile(join(root, 'llms-full.txt'), await buildLlmsFull(root));
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

/**
 * The release pull request as release-please v17 writes it from the fixture's config (the node strategy, the generic
 * updater's first-match-per-marked-line rule and the json updater), then what release.yml's `npm install
 * --package-lock-only` does to the workspace lock entries.
 */
async function releasePullRequest(root: string, version: string): Promise<void> {
  const first = /\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[-\w.]+)?/;
  const generic = (text: string): string => {
    let open = false;
    return text.split('\n').map(line => {
      if (line.includes('x-release-please-version')) return line.replace(first, version);
      if (!open) { open = line.includes('x-release-please-start-version'); return line; }
      if (line.includes('x-release-please-end')) open = false;
      return line.replace(first, version);
    }).join('\n');
  };
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  for (const file of extraFiles) {
    for (const path of file.glob ? tracked.filter(candidate => candidate.endsWith('.md')) : [file.path]) {
      if (file.type === 'generic') { await edit(root, path, generic); continue; }
      const value = await readJson<Record<string, unknown>>(root, path);
      const [, field, child] = /^\$\.(\w+)(?:\.(\w+)|\['([^']+)'\])?$/.exec(file.jsonpath!)!.filter(part => part !== undefined);
      if (child) (value[field!] as Record<string, string>)[child] = version;
      else value[field!] = version;
      await writeFile(join(root, path), json(value));
    }
  }
  await edit(root, 'package.json', text => text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
  await writeFile(join(root, '.release-please-manifest.json'), json({ '.': version }));
  const lock = await readJson<{ version: string; packages: Record<string, Record<string, unknown>> }>(root, 'package-lock.json');
  lock.version = version;
  for (const [key, entry] of Object.entries(lock.packages)) {
    const { name: _name, ...manifest } = await readJson(root, `${key || '.'}/package.json`);
    Object.assign(entry, key ? manifest : { version });
  }
  await writeFile(join(root, 'package-lock.json'), json(lock));
}

test('check accepts a checkout whose declarations agree', () => withFixture(async root => {
  assert.equal(await check(root), '1.0.0');
}));

test('the release pull request moves every declaration: release-please by config, then sync', () => withFixture(async root => {
  await releasePullRequest(root, '1.1.0-alpha.1');
  // Before sync the pinned links and llms-full.txt still name the old version.
  await assert.rejects(check(root), /links this repository at v1\.0\.0/);
  const changed = await sync(root);
  assert.deepEqual(changed.sort(), ['examples/site/urlcode.yaml', 'llms-full.txt', 'schemas/urlcode.schema.json', 'starters/default/.github/workflows/urlcode.yml', 'starters/default/app/urlcode.yaml']);
  assert.equal(await check(root), '1.1.0-alpha.1');
  assert.deepEqual(await sync(root), [], 'sync is idempotent');
  assert.equal(await read(root, 'packages/core/src/release.ts'), "export const CORE_VERSION = '1.1.0-alpha.1'; // x-release-please-version\n");
  assert.match(await read(root, 'starters/default/app/urlcode.yaml'), /urlcode\/v1\.1\.0-alpha\.1\/schemas\/urlcode\.schema\.json/);
  assert.match(await read(root, 'starters/default/.github/workflows/urlcode.yml'), /action@v1\.1\.0-alpha\.1\n/);
  assert.match(await read(root, 'llms-full.txt'), /Source: https:\/\/github\.com\/jimhoyd-com\/urlcode\/blob\/v1\.1\.0-alpha\.1\/docs\//);
  // Only the marked lines move; history outside them, changelogs and this repository's tests are left alone.
  assert.equal(await read(root, 'README.md'), 'Introduced in 0.1.0.\n\n<!-- x-release-please-start-version -->\nCurrent: 1.1.0-alpha.1, served on 127.0.0.1.\n<!-- x-release-please-end -->\n');
  assert.equal(await read(root, 'packages/audit/CHANGELOG.md'), '## 1.0.0\n');
  assert.equal((await readJson(root, 'test/fixture.json')).historical, 'https://github.com/jimhoyd-com/urlcode/blob/v0.1.0/docs/X.md');
  assert.deepEqual((await readJson(root, 'packages/auth/package.json')).peerDependencies, { [core]: '1.1.0-alpha.1', '@jimhoyd/urlcode-audit': '1.1.0-alpha.1', typescript: '>=6.0.3 <7.0.0' });
}));

const drifts: [string, (root: string) => Promise<void>, RegExp][] = [
  ['an add-on version', root => edit(root, 'artifacts/site/package.json', text => text.replace('"1.0.0"', '"1.0.1"')), /artifacts\/site\/package\.json is 1\.0\.1/],
  ['the lockfile', root => edit(root, 'package-lock.json', text => text.replace('"version": "1.0.0"', '"version": "0.9.0"')), /package-lock\.json version differs/],
  ['the release-please manifest', root => edit(root, '.release-please-manifest.json', text => text.replace('1.0.0', '0.9.0')), /\.release-please-manifest\.json differs/],
  ['a ranged core peer', root => edit(root, 'packages/audit/package.json', text => text.replace(`"${core}": "1.0.0"`, `"${core}": "^1.0.0"`)), /must peer on @jimhoyd\/urlcode 1\.0\.0 exactly/],
  ['a required sibling peer', root => edit(root, 'packages/auth/package.json', text => text.replace('"@jimhoyd/urlcode-audit": {\n      "optional": true\n    },', '')), /sibling peer @jimhoyd\/urlcode-audit must be optional/],
  ['a stale example dependency', root => edit(root, 'examples/cloudflare/package.json', text => text.replace(`"${core}": "1.0.0"`, `"${core}": "0.3.0"`)), /examples\/cloudflare\/package\.json depends on @jimhoyd\/urlcode 0\.3\.0/],
  ['a runtime literal', root => edit(root, 'packages/core/src/release.ts', text => text.replace('1.0.0', '0.9.0')), /release\.ts must declare CORE_VERSION = '1\.0\.0'/],
  ['a runtime literal without its marker', root => edit(root, 'packages/core/src/release.ts', text => text.replace(' // x-release-please-version', '')), /x-release-please-version marker/],
  ['a stale llms-full.txt', root => edit(root, 'llms-full.txt', text => text.replaceAll('blob/v1.0.0/', 'blob/main/')), /llms-full\.txt is not built for 1\.0\.0/],
  ['the plugin manifest', root => edit(root, '.claude-plugin/marketplace.json', text => text.replace('1.0.0', '0.9.0')), /marketplace\.json is not/],
  ['a current version outside its markers', root => edit(root, 'docs/GUIDE.md', () => 'Install 1.0.0.\n'), /GUIDE\.md:1: 1\.0\.0 appears outside an x-release-please-start-version block/],
  ['a stale marker block', root => edit(root, 'README.md', text => text.replace('Current: 1.0.0', 'Current: 0.9.0')), /README\.md:4: release-please replaces the first version on a marked line, and here that is 0\.9\.0/],
  ['another version first on a marked line', root => edit(root, 'README.md', text => text.replace('Current: 1.0.0, served on 127.0.0.1', 'Served on 127.0.0.1 at 1.0.0')), /here that is 127\.0\.0/],
  ['the version twice on a marked line', root => edit(root, 'README.md', text => text.replace('Current: 1.0.0,', 'Current: 1.0.0 (1.0.0),')), /appears twice on one marked line/],
  ['a stale pinned link in a schema', root => edit(root, 'schemas/urlcode.schema.json', text => text.replace('blob/v1.0.0/', 'blob/v0.9.0/')), /schemas\/urlcode\.schema\.json links this repository at v0\.9\.0/],
  ['a stale starter Action ref', root => edit(root, 'starters/default/.github/workflows/urlcode.yml', text => text.replace('@v1.0.0', '@v0.9.0')), /urlcode\.yml links this repository at v0\.9\.0/],
  ['an unclosed block', root => edit(root, 'README.md', text => text.replace('<!-- x-release-please-end -->', '')), /never closed/],
  ['an add-on missing from the release-please config', root => edit(root, 'release-please-config.json', text => text.replace(/\{\s*"type": "json",\s*"path": "artifacts\/site\/package\.json",\s*"jsonpath": "\$\.version"\s*\},/, '')), /extra-files must list exactly the version declarations/],
];
for (const [name, drift, message] of drifts) {
  test(`check fails on drift in ${name}`, () => withFixture(async root => {
    await drift(root);
    await assert.rejects(check(root), message);
  }));
}

test('the command line check passes on this checkout and a missing argument exits 2', () => {
  const script = join(process.cwd(), 'scripts', 'release-versions.ts');
  assert.match(execFileSync(process.execPath, [script, 'check'], { encoding: 'utf8' }), /^Every version declaration is \S+\n$/);
  assert.throws(() => execFileSync(process.execPath, [script], { stdio: 'pipe' }), (error: { status?: number }) => error.status === 2);
});
