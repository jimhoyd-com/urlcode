import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTemplateLock, assertTemplateUpgrade, copyPublishedTemplateGuide, localMcpConfig, updateTemplateText } from '../scripts/release-template.ts';

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
test('template guide comes from the exact installed release, not the current checkout', async t => {
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
  for (const skill of ['urlcode-authoring', 'urlcode-operations']) {
    await mkdir(join(installed, '.claude', 'skills', skill), { recursive: true });
    await writeFile(join(installed, '.claude', 'skills', skill, 'SKILL.md'), `${skill} shipped in alpha.3`);
  }
  await copyPublishedTemplateGuide(directory, '0.4.0-alpha.3');
  assert.equal(await readFile(join(directory, 'AGENTS.md'), 'utf8'), 'Guide shipped in alpha.3');
  assert.equal(await readFile(join(directory, '.claude', 'skills', 'urlcode-authoring', 'SKILL.md'), 'utf8'), 'urlcode-authoring shipped in alpha.3');
  assert.equal(await readFile(join(directory, '.claude', 'skills', 'urlcode-operations', 'SKILL.md'), 'utf8'), 'urlcode-operations shipped in alpha.3');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.mcp.json'), 'utf8')).mcpServers.urlcode, { command: 'npx', args: ['--no', '--package', '@jimhoyd/urlcode', 'urlcode', 'mcp', '--project', '.'] });
  await assert.rejects(copyPublishedTemplateGuide(directory, '0.4.0-alpha.4'), /must match the selected runtime/);
});
