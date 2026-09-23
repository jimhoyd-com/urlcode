import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTemplateLock, assertTemplateReadmeCurrent, assertTemplateUpgrade, copyPublishedTemplateGuide, copyPublishedTemplateStarter, localMcpConfig, templateSyncedPaths, updateTemplateFiles, updateTemplateText } from '../scripts/release-template.ts';

test('template upgrade changes active pins and schema references, preserving migration history', () => {
  const input = 'Under the pinned `0.4.0-alpha.3` runtime\nIn the `0.4.0-alpha.3` runtime this template pins\nThis template pins the `0.4.0-alpha.3` published runtime\nBefore `0.4.0-alpha.3`, behavior differed\nhttps://github.com/jimhoyd-com/urlcode/blob/v0.4.0-alpha.3/docs/SECURITY.md\n# yaml-language-server: $schema=https://raw.githubusercontent.com/jimhoyd-com/urlcode/abcdef/schemas/urlcode.schema.json';
  const result = updateTemplateText(input, '0.4.0-alpha.3', '0.4.0-alpha.4');
  assert.equal(result.match(/0\.4\.0-alpha\.4/g)?.length, 5);
  assert.match(result, /Before `0.4.0-alpha.3`, behavior differed/);
  assert.match(result, /urlcode\/v0.4.0-alpha.4\/schemas/);
});


test('template resume cannot reuse a stale release PR to downgrade main or another version branch', () => {
  assert.throws(() => assertTemplateUpgrade('0.4.0-alpha.4', '0.4.0-alpha.3'), /downgrade/);
  assert.throws(() => assertTemplateUpgrade('0.4.0-alpha.2', '0.4.0-alpha.3', '0.4.0-alpha.4'), /different runtime pin/);
  assert.throws(() => assertTemplateUpgrade('^0.4.0-alpha.2', '0.4.0-alpha.3'), /exact version/);
  assertTemplateUpgrade('0.4.0-alpha.2', '0.4.0-alpha.3', '0.4.0-alpha.3');
});


test('template resume rejects a package pin whose lock still installs another runtime', () => {
  const lock = { packages: { '': { dependencies: { '@jimhoyd/urlcode': '0.4.0-alpha.3' } }, 'node_modules/@jimhoyd/urlcode': { version: '0.4.0-alpha.2' } } };
  assert.throws(() => assertTemplateLock('0.4.0-alpha.3', lock), /installed lock entry/);
  lock.packages['node_modules/@jimhoyd/urlcode'].version = '0.4.0-alpha.3';
  assertTemplateLock('0.4.0-alpha.3', lock);
});


test('the template MCP registration never runs a bare npx of the unscoped name and is idempotent', () => {
  const bare = JSON.stringify({ mcpServers: { urlcode: { command: 'urlcode', args: ['mcp', '--project', '.'] } } });
  const local = localMcpConfig(bare);
  assert.equal(localMcpConfig(local), local);
  assert.ok(!JSON.parse(local).mcpServers.urlcode.args.includes('--allow-authoring'));
  assert.throws(() => localMcpConfig('{"mcpServers":{}}'), /must register the urlcode server/);
});
test('template starter and guidance come from the exact installed release, not the current checkout', async t => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-template-guide-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'node_modules', '@jimhoyd', 'urlcode');
  await mkdir(join(installed, 'starters', 'default'), { recursive: true });
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode', version: '0.4.0-alpha.3' }));
  await writeFile(join(installed, 'starters', 'default', 'AGENTS.md'), 'Guide shipped in alpha.3');
  await writeFile(join(installed, 'starters', 'default', '.mcp.json'), JSON.stringify({ mcpServers: { urlcode: { command: 'urlcode', args: ['mcp', '--project', '.'] } } }));
  await mkdir(join(installed, 'starters', 'default', 'routes'), { recursive: true });
  await writeFile(join(installed, 'starters', 'default', 'routes', 'functions.yaml'), 'routes: {}\n');
  await writeFile(join(installed, 'starters', 'default', 'README.md'), 'Initializer-owned README must not replace the template README');
  await mkdir(join(directory, 'routes'), { recursive: true });
  await writeFile(join(directory, 'routes', 'functions.yaml'), 'stale route');
  await writeFile(join(directory, 'README.md'), 'Template-owned README');
  for (const skill of ['urlcode-authoring', 'urlcode-operations']) {
    await mkdir(join(installed, '.claude', 'skills', skill), { recursive: true });
    await writeFile(join(installed, '.claude', 'skills', skill, 'SKILL.md'), `${skill} shipped in alpha.3`);
  }
  await copyPublishedTemplateGuide(directory, '0.4.0-alpha.3');
  assert.equal(await readFile(join(directory, 'routes', 'functions.yaml'), 'utf8'), 'routes: {}\n');
  assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), 'Template-owned README');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.urlcode-starter-source.json'), 'utf8')), { files: ['routes/functions.yaml'] });
  assert.equal(await readFile(join(directory, 'AGENTS.md'), 'utf8'), 'Guide shipped in alpha.3');
  assert.equal(await readFile(join(directory, '.claude', 'skills', 'urlcode-authoring', 'SKILL.md'), 'utf8'), 'urlcode-authoring shipped in alpha.3');
  assert.equal(await readFile(join(directory, '.claude', 'skills', 'urlcode-operations', 'SKILL.md'), 'utf8'), 'urlcode-operations shipped in alpha.3');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.mcp.json'), 'utf8')).mcpServers.urlcode, { command: 'npx', args: ['--no', '--package', '@jimhoyd/urlcode', 'urlcode', 'mcp', '--project', '.'] });
  await rm(join(installed, 'starters', 'default', 'routes', 'functions.yaml'));
  await copyPublishedTemplateGuide(directory, '0.4.0-alpha.3');
  await assert.rejects(readFile(join(directory, 'routes', 'functions.yaml')), /ENOENT/);
  await assert.rejects(copyPublishedTemplateGuide(directory, '0.4.0-alpha.4'), /must match the selected runtime/);
});
async function templateFixture(t: import('node:test').TestContext, starterFiles: Record<string, string>, templateFiles: Record<string, string>): Promise<string> {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { dirname, join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'urlcode-template-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const installed = join(directory, 'node_modules', '@jimhoyd', 'urlcode');
  const put = async (path: string, text: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); };
  await put(join(installed, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode', version: '0.5.9' }));
  for (const [path, text] of Object.entries(starterFiles)) await put(join(installed, 'starters', 'default', path), text);
  for (const [path, text] of Object.entries(templateFiles)) await put(join(directory, path), text);
  return directory;
}
test('template sync removes owned files the starter no longer ships even without a source manifest (#570)', async t => {
  const { readFile, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const legacy = ['functions/hello.mjs', 'middleware/headers.mjs', 'routes/functions.yaml', 'routes/marketing/links.yaml', 'tests/requests.json'];
  const directory = await templateFixture(t, { 'urlcode.yaml': 'version: "1"\nroutes: {}\n', Makefile: 'all:\n' },
    { ...Object.fromEntries(legacy.map(path => [path, 'old example'])), 'routes/mine.yaml': 'user file', 'README.md': 'Template README' });
  for (const path of legacy) assert.ok(templateSyncedPaths.includes(path), path);
  await copyPublishedTemplateStarter(directory, '0.5.9');
  for (const path of legacy) await assert.rejects(readFile(join(directory, path)), /ENOENT/, path);
  assert.equal(await readFile(join(directory, 'routes', 'mine.yaml'), 'utf8'), 'user file', 'a path the sync does not own is kept');
  assert.deepEqual((await readdir(directory)).filter(name => ['functions', 'middleware', 'tests'].includes(name)), [], 'emptied directories are removed');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.urlcode-starter-source.json'), 'utf8')), { files: ['Makefile', 'urlcode.yaml'] });
});
test('template sync refuses a starter file it does not own', async t => {
  const directory = await templateFixture(t, { 'urlcode.yaml': 'routes: {}\n', 'extra/new.mjs': 'export default 1' }, {});
  await assert.rejects(copyPublishedTemplateStarter(directory, '0.5.9'), /extra\/new\.mjs, which the template sync does not own/);
});
test('template release refuses a README that documents synchronized files the template no longer has', async t => {
  const directory = await templateFixture(t, {}, { 'README.md': 'Edit `urlcode.yaml`, then open /hello/Ada, served by `functions/hello.mjs`.', 'urlcode.yaml': 'routes: {}\n' });
  await assert.rejects(assertTemplateReadmeCurrent(directory), /functions\/hello\.mjs/);
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  await writeFile(join(directory, 'README.md'), 'Edit `urlcode.yaml` to add your first route.');
  await assertTemplateReadmeCurrent(directory);
});
test('template version rewrite runs over the copied starter, so its schema pin follows the release (#557)', async t => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const starterYaml = '# yaml-language-server: $schema=https://raw.githubusercontent.com/jimhoyd-com/urlcode/669632fb4f188f293a0f622847f87ee019c0627f/schemas/urlcode.schema.json\nversion: "1"\nroutes: {}\n';
  const directory = await templateFixture(t, { 'urlcode.yaml': starterYaml }, { 'README.md': 'Under the pinned `0.5.8` runtime' });
  await copyPublishedTemplateStarter(directory, '0.5.9');
  await updateTemplateFiles(directory, ['README.md', 'urlcode.yaml', 'functions/hello.mjs', 'gone.yaml'], '0.5.8', '0.5.9');
  assert.match(await readFile(join(directory, 'urlcode.yaml'), 'utf8'), /jimhoyd-com\/urlcode\/v0\.5\.9\/schemas\/urlcode\.schema\.json/);
  assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), 'Under the pinned `0.5.9` runtime');
});
