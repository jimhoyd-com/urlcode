import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Publish from '../scripts/release-publish.ts';

// release-publish.ts reads the version from its checkout's package.json and the files from <checkout>/release, so
// each case loads a private copy of the script beside a package.json at the version under test.
const repository = resolve(import.meta.dirname, '..');
const sha = 'a'.repeat(40);
const sha512 = (bytes: Buffer): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

interface Checkout { root: string; release: string; publish: typeof Publish }
async function checkout(version: string, files: Record<string, string | Buffer> = {}): Promise<Checkout> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'urlcode-publish-')));
  await mkdir(join(root, 'scripts'));
  for (const name of ['release-publish.ts', 'npm-command.ts', 'workspaces.ts']) await copyFile(join(repository, 'scripts', name), join(root, 'scripts', name));
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'junction');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode', version, type: 'module' }));
  const release = join(root, 'release');
  await mkdir(release);
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(release, name), bytes);
  const saved = { dir: process.env.URLCODE_RELEASE_DIR, repo: process.env.GITHUB_REPOSITORY };
  delete process.env.URLCODE_RELEASE_DIR;
  process.env.GITHUB_REPOSITORY = 'owner/repo';
  try {
    return { root, release, publish: await import(pathToFileURL(join(root, 'scripts', 'release-publish.ts')).href) as typeof Publish };
  } finally {
    if (saved.dir === undefined) delete process.env.URLCODE_RELEASE_DIR; else process.env.URLCODE_RELEASE_DIR = saved.dir;
    if (saved.repo === undefined) delete process.env.GITHUB_REPOSITORY; else process.env.GITHUB_REPOSITORY = saved.repo;
  }
}
async function using(version: string, files: Record<string, string | Buffer>, run: (checkout: Checkout) => Promise<void>): Promise<void> {
  const value = await checkout(version, files);
  try { await run(value); } finally { await rm(value.root, { recursive: true, force: true }); }
}

type Handler = (args: string[]) => string;
interface Fake extends Publish.Runner { calls: { tool: 'gh' | 'npm' | 'fetch'; args: string[] }[] }
function fake({ gh = () => { throw new Error('unexpected gh'); }, npm = () => { throw new Error('unexpected npm'); }, fetch = async () => { throw new Error('unexpected fetch'); } }: { gh?: Handler; npm?: Handler; fetch?: (url: string) => Promise<Buffer> } = {}): Fake {
  const calls: Fake['calls'] = [];
  return {
    calls,
    gh: args => { calls.push({ tool: 'gh', args }); return gh(args); },
    npm: args => { calls.push({ tool: 'npm', args }); return npm(args); },
    fetch: async url => { calls.push({ tool: 'fetch', args: [url] }); return fetch(url); },
  };
}
const missing = (): string => { throw new Error('404 Not Found'); };
const release = (tag: string, fields: { draft?: boolean; prerelease?: boolean; assets?: string[] } = {}) =>
  ({ tag_name: tag, draft: fields.draft ?? false, prerelease: fields.prerelease ?? false, assets: (fields.assets ?? []).map(name => ({ name })) });
/** A gh that lists `releases` and answers everything else through `rest`. */
const listing = (releases: unknown[], rest: Handler = () => ''): Handler => args =>
  args[0] === 'api' ? JSON.stringify([releases]) : rest(args);

test('plan: nothing to release only when the GitHub Release is published and npm has the version', async () => {
  await using('1.2.0', {}, async ({ publish }) => {
    const both = fake({ gh: () => 'false\n', npm: () => '1.2.0\n' });
    assert.deepEqual(await publish.plan(both), { version: '1.2.0', tag: 'v1.2.0', channel: 'latest', stable: true, release: false });
    assert.deepEqual(both.calls.map(call => call.args.slice(0, 2)), [['release', 'view'], ['view', '@jimhoyd/urlcode@1.2.0']]);
    assert.equal((await publish.plan(fake({ gh: missing, npm: () => '1.2.0\n' }))).release, true);
    assert.equal((await publish.plan(fake({ gh: () => 'true\n', npm: () => '1.2.0\n' }))).release, true, 'a draft is not a release');
    assert.equal((await publish.plan(fake({ gh: () => 'false\n', npm: missing }))).release, true);
  });
  await using('1.3.0-alpha.2', {}, async ({ publish }) => {
    assert.deepEqual(await publish.plan(fake({ gh: missing, npm: missing })), { version: '1.3.0-alpha.2', tag: 'v1.3.0-alpha.2', channel: 'alpha', stable: false, release: true });
  });
});

test('github: creates a stable release with generated notes, as latest, carrying every file', async () => {
  await using('1.2.0', { 'jimhoyd-urlcode-1.2.0.tgz': 'core', 'SHA256SUMS': 'sums' }, async ({ publish, release: out }) => {
    const runner = fake({ gh: listing([release('v1.1.0'), release('v1.2.0-alpha.1', { prerelease: true })]) });
    await publish.github(sha, runner);
    const create = runner.calls.at(-1)!.args;
    assert.deepEqual(create.slice(0, 4), ['release', 'create', 'v1.2.0', join(out, 'SHA256SUMS')]);
    assert.equal(create[4], join(out, 'jimhoyd-urlcode-1.2.0.tgz'));
    for (const flag of ['--generate-notes', '--latest=true', '--prerelease=false']) assert(create.includes(flag), flag);
    assert.equal(create[create.indexOf('--target') + 1], sha);
    assert.equal(create[create.indexOf('--repo') + 1], 'owner/repo');
    assert.equal(create[create.indexOf('--title') + 1], 'URLCode 1.2.0');
  });
});

test('github: an alpha is a prerelease and never latest, and may sit below the latest stable', async () => {
  await using('1.0.0-alpha.3', { 'a.tgz': 'a' }, async ({ publish }) => {
    const runner = fake({ gh: listing([release('v2.0.0')]) });
    await publish.github(sha, runner);
    const create = runner.calls.at(-1)!.args;
    for (const flag of ['--generate-notes', '--latest=false', '--prerelease=true']) assert(create.includes(flag), flag);
  });
});

test('github: refuses to move the latest release backwards', async () => {
  await using('1.2.0', { 'a.tgz': 'a' }, async ({ publish }) => {
    const runner = fake({ gh: listing([release('v1.3.0'), release('v9.0.0', { draft: true }), release('v9.0.0-alpha.1', { prerelease: true })]) });
    await assert.rejects(publish.github(sha, runner), /Refusing to move the latest release back from 1\.3\.0 to 1\.2\.0/);
    assert(!runner.calls.some(call => call.args[1] === 'create'));
  });
});

test('github: refuses anything but an exact commit and an empty release directory', async () => {
  await using('1.2.0', { 'a.tgz': 'a' }, async ({ publish }) => {
    await assert.rejects(publish.github('main', fake()), /exact commit/);
  });
  await using('1.2.0', {}, async ({ publish }) => {
    await assert.rejects(publish.github(sha, fake({ gh: listing([]) })), /is empty; run release:pack first/);
  });
});

test('github: completes an existing release by uploading only missing assets, and verifies the ones present', async () => {
  await using('1.2.0', { 'a.tgz': 'same', 'b.tgz': 'new' }, async ({ publish, release: out }) => {
    const runner = fake({ gh: listing([release('v1.2.0', { assets: ['a.tgz'] })], args => {
      if (args[1] === 'download') writeFileSync(join(args[args.indexOf('--dir') + 1]!, args[args.indexOf('--pattern') + 1]!), 'same');
      return '';
    }) });
    await publish.github(sha, runner);
    const actions = runner.calls.slice(1).map(call => call.args.slice(0, 4));
    assert.deepEqual(actions, [['release', 'download', 'v1.2.0', '--repo'], ['release', 'upload', 'v1.2.0', join(out, 'b.tgz')]]);
  });
});

test('github: refuses an existing asset with different bytes and an existing release on another channel', async () => {
  await using('1.2.0', { 'a.tgz': 'ours' }, async ({ publish }) => {
    const differing = fake({ gh: listing([release('v1.2.0', { assets: ['a.tgz'] })], args => {
      if (args[1] === 'download') writeFileSync(join(args[args.indexOf('--dir') + 1]!, 'a.tgz'), 'theirs');
      return '';
    }) });
    await assert.rejects(publish.github(sha, differing), /already has a different a\.tgz; a published asset is never replaced/);
    assert(!differing.calls.some(call => call.args[1] === 'upload'));
    await assert.rejects(publish.github(sha, fake({ gh: listing([release('v1.2.0', { prerelease: true })]) })), /exists with a different channel/);
  });
});

test('urls: every pinned add-on must download with exactly the pinned bytes', async () => {
  const ui = Buffer.from('ui tarball'), site = Buffer.from('site tarball');
  const pins = { format: 1, version: '1.2.0', addons: {
    ui: { url: 'https://example.test/ui.tgz', integrity: sha512(ui) },
    site: { url: 'https://example.test/site.tgz', integrity: sha512(site) },
  } };
  await using('1.2.0', { 'addons.json': JSON.stringify(pins) }, async ({ publish }) => {
    const bodies: Record<string, Buffer> = { 'https://example.test/ui.tgz': ui, 'https://example.test/site.tgz': site };
    const runner = fake({ fetch: async url => bodies[url]! });
    assert.deepEqual(await publish.urls(runner), ['ui', 'site']);
    assert.deepEqual(runner.calls.map(call => call.args[0]), ['https://example.test/ui.tgz', 'https://example.test/site.tgz']);
    bodies['https://example.test/site.tgz'] = Buffer.from('something else');
    await assert.rejects(publish.urls(fake({ fetch: async url => bodies[url]! })), /site: https:\/\/example\.test\/site\.tgz does not match core's pin/);
  });
});

test('npm: publishes the core tarball on the version channel with no install scripts', async () => {
  for (const [version, tag] of [['1.2.0', 'latest'], ['1.3.0-alpha.1', 'alpha']] as const) {
    const tarball = `jimhoyd-urlcode-${version}.tgz`;
    await using(version, { [tarball]: 'core bytes', 'jimhoyd-urlcode-ui-1.2.0.tgz': 'ui' }, async ({ publish, release: out }) => {
      const runner = fake({ npm: args => args[0] === 'view' ? missing() : '' });
      assert.equal(await publish.publish(runner), 'published');
      const args = runner.calls.at(-1)!.args;
      assert.deepEqual(args.slice(0, 2), ['publish', join(out, tarball)]);
      assert.equal(args[args.indexOf('--tag') + 1], tag);
      for (const flag of ['--ignore-scripts', '--access', '--registry=https://registry.npmjs.org']) assert(args.includes(flag), flag);
    });
  }
});

test('npm: an identical published version is a no-op and different bytes are refused', async () => {
  const bytes = Buffer.from('core bytes');
  await using('1.2.0', { 'jimhoyd-urlcode-1.2.0.tgz': bytes }, async ({ publish }) => {
    const identical = fake({ npm: () => `${createHash('sha1').update(bytes).digest('hex')}\n` });
    assert.equal(await publish.publish(identical), 'already published');
    assert.deepEqual(identical.calls.map(call => call.args[0]), ['view']);
    const different = fake({ npm: () => `${'0'.repeat(40)}\n` });
    await assert.rejects(publish.publish(different), /already on npm with different bytes/);
    assert(!different.calls.some(call => call.args[0] === 'publish'));
  });
  await using('1.2.0', { 'jimhoyd-urlcode-1.1.0.tgz': bytes }, async ({ publish }) => {
    await assert.rejects(publish.publish(fake()), /jimhoyd-urlcode-1\.2\.0\.tgz is missing/);
  });
});
