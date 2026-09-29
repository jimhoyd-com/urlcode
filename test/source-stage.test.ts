// #844 operation 2: a shadcn registry item or an Agent Skill is staged offline as data, with every file it would write,
// every dependency it declares and every refusal; materialization is the separate, all-or-nothing opt-in. These tests
// hold the report, the malicious-input refusals, the limits, the write rules and the CLI/MCP agreement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { materializeSourceAssets, sourceStageLimits, stageSiteSourceAssets, stageSourceAssets } from '../packages/core/src/source-stage.ts';
import type { SourceStageReport } from '../packages/core/src/source-stage.ts';
import { runAddonCommand } from '../packages/core/src/extensions-cli.ts';
import { serveMcp } from '../packages/core/src/mcp.ts';
import { byReplyId } from './helpers.ts';

const fixtures = fileURLToPath(new URL('./fixtures/source-stage/', import.meta.url));
const card = join(fixtures, 'hello-card'), skill = join(fixtures, 'pdf-notes'), malicious = join(fixtures, 'malicious', 'registry-item.json');
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const codes = (report: SourceStageReport, severity?: 'error' | 'warning'): string[] => report.diagnostics.filter(item => severity === undefined || item.severity === severity).map(item => item.code);
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

async function temp(t: TestContext, prefix = 'urlcode-stage-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function files(t: TestContext, entries: Record<string, string | Buffer>): Promise<string> {
  const dir = await temp(t);
  for (const [path, value] of Object.entries(entries)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), value);
  }
  return dir;
}
const skillMd = (name: string, extra = ''): string => `---\nname: ${name}\ndescription: Synthetic skill.\n${extra}---\n\n# ${name}\n`;

test('a shadcn registry item stages every file with its target, digest, media type and class, and lists its dependencies and style deltas as data', async t => {
  const site = await files(t, { 'package.json': JSON.stringify({ dependencies: { zod: '^3.22.0' } }) });
  const report = await stageSourceAssets(card, { site });
  assert.deepEqual([report.source.format, report.source.schema, report.source.descriptor], ['shadcn-registry-item', 'https://ui.shadcn.com/schema/registry-item.json', 'registry-item.json']);
  assert.equal(report.source.descriptorSha256, sha256(await readFile(join(card, 'registry-item.json'))));
  assert.deepEqual(report.item, { name: 'hello-card', type: 'registry:block', title: 'Hello card', description: 'A synthetic card component with a formatting utility, theme variables and dependencies.', version: '1.0.0' });
  assert.deepEqual(report.files.map(file => [file.target, file.targetFrom, file.class, file.review, file.inline, file.mediaType]), [
    ['components/hello-card.tsx', 'type-default', 'code', true, true, 'text/tsx'],
    ['lib/format.ts', 'type-default', 'code', true, false, 'text/typescript'],
    ['content/hello.json', 'target', 'data', false, false, 'application/json'],
  ]);
  const utility = await readFile(join(card, 'lib', 'format.ts'));
  assert.deepEqual([report.files[1]!.sha256, report.files[1]!.bytes], [sha256(utility), utility.length]);
  const item = JSON.parse(await readFile(join(card, 'registry-item.json'), 'utf8')) as { files: { content?: string }[]; cssVars: unknown };
  assert.equal(report.files[0]!.sha256, sha256(item.files[0]!.content!), 'inline content is digested as the bytes that would be written');
  assert.deepEqual(report.dependencies, [
    { spec: 'zod@3.23.8', kind: 'dependency', declared: '^3.22.0' },
    { spec: 'clsx', kind: 'dependency', declared: null },
    { spec: '@types/react@19.1.0', kind: 'devDependency', declared: null },
  ]);
  assert.deepEqual(report.registryDependencies, [{ spec: 'button', kind: 'name' }, { spec: 'https://registry.example/r/editor.json', kind: 'url' }]);
  assert.deepEqual(report.install, { dependencies: "npm install --ignore-scripts 'zod@3.23.8' 'clsx'", devDependencies: "npm install --ignore-scripts --save-dev '@types/react@19.1.0'" });
  assert.deepEqual(report.styles?.cssVars, item.cssVars);
  assert.deepEqual(report.styles?.envVars, { HELLO_CARD_GREETING: 'Hello' });
  assert.deepEqual(codes(report), ['unknown-field', 'remote-url', 'registry-dependency']);
  assert.equal(report.summary.errors, 0);
  assert.match(report.notice, /untrusted/);
  assert.match(report.inertNotice, /does not make these files inert artifacts/);
  assert.match(report.inertNotice, /"components\/hello-card.tsx", "lib\/format.ts"/);
});

test('an Agent Skill stages SKILL.md as untrusted agent instructions and its scripts as code, and grants none of its pre-approved tools', async () => {
  const report = await stageSourceAssets(skill);
  assert.deepEqual([report.source.format, report.source.schema, report.source.specification], ['agent-skill', null, 'https://agentskills.io/specification']);
  assert.deepEqual([report.item.name, report.item.version], ['pdf-notes', '0.2.0']);
  assert.deepEqual(report.files.map(file => [file.target, file.class, file.role, file.review]), [
    ['pdf-notes/SKILL.md', 'docs', 'agent-instructions', false],
    ['pdf-notes/assets/template.json', 'data', 'asset', false],
    ['pdf-notes/references/REFERENCE.md', 'docs', 'reference', false],
    ['pdf-notes/scripts/extract.sh', 'code', 'script', true],
  ]);
  assert.equal(report.files[3]!.sha256, sha256(await readFile(join(skill, 'scripts', 'extract.sh'))));
  assert.deepEqual(report.skill, { license: 'Apache-2.0', compatibility: null, metadata: { version: '0.2.0' }, allowedTools: 'Bash(pdftotext:*) Read' });
  assert.deepEqual(codes(report), ['pre-approved-tools']);
  assert.match(report.notice, /SKILL\.md and all other prose/);
  assert.match(report.inertNotice, /an Agent Skill is not an artifact package/);
  assert.deepEqual([report.dependencies, report.registryDependencies, report.install], [[], [], { dependencies: null, devDependencies: null }]);
});

test('malicious targets and paths are refused: .. escapes, absolute targets, remote URLs and hidden targets stage nothing', async () => {
  const report = await stageSourceAssets(malicious);
  assert.deepEqual(report.files, []);
  assert.deepEqual(codes(report, 'error'), ['path-escape', 'absolute-path', 'path-escape', 'remote-url', 'path-escape', 'hidden-path']);
  assert.deepEqual(report.diagnostics.map(item => item.subject), ['../escape.ts', '/etc/evil.ts', '~/../tilde.ts', 'https://registry.example/r/remote.tsx', '../outside.ts', '~/.env']);
});

test('symlinks are never followed, oversize files are never read, and hidden, deep and invalid skill entries are reported', async t => {
  const outside = await files(t, { 'secret.txt': 'synthetic secret\n' });
  const dir = await files(t, {
    'SKILL.md': skillMd('probe', 'unknown-key: 1\n'),
    'references/big.md': Buffer.alloc(sourceStageLimits.maxFileBytes + 1, 0x61),
    '.git/config': 'synthetic',
    'a/b/c/d/e/f/g/h/deep.md': 'deep',
  });
  await symlink(join(outside, 'secret.txt'), join(dir, 'references', 'link.md'));
  const report = await stageSourceAssets(dir);
  const byCode = Object.fromEntries(report.diagnostics.map(item => [item.subject ?? item.code, item.code]));
  assert.equal(byCode['references/link.md'], 'symlink');
  assert.equal(byCode['references/big.md'], 'limit');
  assert.equal(byCode['.git'], 'hidden-path');
  assert.equal(byCode['unknown-key'], 'unknown-field');
  assert.equal(byCode['name'], 'name-mismatch');
  assert.ok(report.diagnostics.some(item => item.code === 'limit' && item.subject?.startsWith('a/b/c/d/e/f/g')), 'a path past the depth limit is refused');
  assert.deepEqual(report.files.map(file => file.target), ['probe/SKILL.md']);
  assert.ok(!JSON.stringify(report).includes('synthetic secret'), 'the symlink target is never read');

  // A shadcn file path through a symlink, and a symlinked source, are refused too.
  const item = await files(t, { 'registry-item.json': JSON.stringify({ name: 'x', files: [{ path: 'lib/link.ts', type: 'registry:lib' }] }) });
  await mkdir(join(item, 'lib'));
  await symlink(join(outside, 'secret.txt'), join(item, 'lib', 'link.ts'));
  assert.deepEqual(codes(await stageSourceAssets(item), 'error'), ['symlink']);
  await symlink(item, join(outside, 'linked'));
  await assert.rejects(stageSourceAssets(join(outside, 'linked')), /is a symlink/);
});

test('the file-count limit stops a registry item that lists too many files, and an invalid skill name or frontmatter is an error', async t => {
  const many = Array.from({ length: sourceStageLimits.maxFiles + 2 }, (_, index) => ({ path: `f${index}.json`, type: 'registry:file', target: `~/data/f${index}.json`, content: '{}' }));
  const item = await files(t, { 'registry-item.json': JSON.stringify({ name: 'many', files: many }) });
  const report = await stageSourceAssets(item);
  assert.equal(report.files.length, sourceStageLimits.maxFiles);
  assert.deepEqual(codes(report, 'error'), ['limit']);
  const bad = await files(t, { 'SKILL.md': '---\nname: Bad--Name\n---\n' });
  assert.deepEqual(codes(await stageSourceAssets(bad), 'error'), ['invalid-field', 'invalid-field']);
  const anchors = await files(t, { 'SKILL.md': '---\nname: &a x\ndescription: *a\n---\n' });
  assert.ok(codes(await stageSourceAssets(anchors), 'error').includes('invalid-field'), 'YAML anchors are refused under the runtime profile');
});

test('staging executes nothing: an importable module and a lifecycle script in the source never run', async t => {
  const dir = await files(t, {
    'SKILL.md': skillMd('inert-check'),
    'scripts/run.mjs': 'import {writeFileSync} from "node:fs";writeFileSync(new URL("./ran.marker",import.meta.url),"ran");',
    'package.json': JSON.stringify({ scripts: { postinstall: 'node scripts/run.mjs', preinstall: 'node scripts/run.mjs' } }),
  });
  const report = await stageSourceAssets(dir);
  assert.ok(report.files.some(file => file.target.endsWith('scripts/run.mjs') && file.class === 'code'));
  assert.equal(await exists(join(dir, 'scripts', 'ran.marker')), false);
});

test('materialize writes exactly the staged bytes, without an execute bit, and installs nothing', async t => {
  const site = await files(t, { 'package.json': '{}\n', 'app/urlcode.yaml': 'routes: {}\n' });
  const into = join(site, 'vendor', 'card');
  const result = await materializeSourceAssets(card, { into, site });
  assert.deepEqual(result.written.map(file => file.target), ['components/hello-card.tsx', 'lib/format.ts', 'content/hello.json']);
  for (const file of result.written) {
    const bytes = await readFile(join(into, file.target));
    assert.equal(sha256(bytes), file.sha256, file.target);
    assert.equal((await stat(join(into, file.target))).mode & 0o111, 0, `${file.target} has no execute bit`);
  }
  assert.equal(await readFile(join(site, 'package.json'), 'utf8'), '{}\n', 'no dependency was installed');
  assert.equal(await exists(join(site, 'node_modules')), false);
  assert.match(result.notice, /no dependency was installed/);
  // Staging against the same directory now reports every target as existing, and a second materialization refuses.
  assert.deepEqual((await stageSourceAssets(card, { into })).files.map(file => file.status), ['exists', 'exists', 'exists']);
  await assert.rejects(materializeSourceAssets(card, { into, site }), /already exist and are never overwritten/);
  // The skill's script is written as data: no execute bit even when the source had one.
  const skillInto = join(site, 'vendor', 'skills');
  await materializeSourceAssets(skill, { into: skillInto, site });
  assert.equal((await stat(join(skillInto, 'pdf-notes', 'scripts', 'extract.sh'))).mode & 0o111, 0);
});

test('materialize refuses app/ without --allow-app, a source with errors, a symlinked directory, and rolls back a partial write', async t => {
  const site = await files(t, { 'package.json': '{}\n', 'app/urlcode.yaml': 'routes: {}\n' });
  await assert.rejects(materializeSourceAssets(card, { into: join(site, 'app', 'components'), site }), /site's app\/.*--allow-app/);
  await assert.rejects(materializeSourceAssets(card, { into: site, site }), /is, or contains, the site's app\//);
  const allowed = await materializeSourceAssets(card, { into: join(site, 'app', 'vendor'), site, allowApp: true });
  assert.equal(allowed.written.length, 3);
  await assert.rejects(materializeSourceAssets(malicious, { into: join(site, 'out'), site }), /staging reported 6 error\(s\)/);
  assert.equal(await exists(join(site, 'out')), false);
  // A directory segment that is a symlink is refused before anything is written.
  const elsewhere = await temp(t);
  await mkdir(join(site, 'linked'));
  await symlink(elsewhere, join(site, 'linked', 'lib'));
  await assert.rejects(materializeSourceAssets(card, { into: join(site, 'linked'), site }), /not a plain directory/);
  assert.deepEqual(await readdir(elsewhere), []);
  assert.deepEqual((await readdir(join(site, 'linked'))).sort(), ['lib'], 'the components/ written before the refusal was rolled back');
  // A later target whose parent is a file fails mid-write: everything written before it is removed.
  const partial = join(site, 'partial');
  await mkdir(partial);
  await writeFile(join(partial, 'content'), 'a file where a directory is needed');
  await assert.rejects(materializeSourceAssets(card, { into: partial, site }));
  assert.deepEqual((await readdir(partial)).sort(), ['content']);
  assert.ok((await lstat(join(partial, 'content'))).isFile());
});

test('the CLI prints the same report as the core function, exits 1 on an error diagnostic and gates its flags', async t => {
  const printed: unknown[] = [];
  const print = (value: unknown): boolean => { printed.push(value); return true; };
  assert.equal(await runAddonCommand('artifacts', 'stage', [card], { json: true }, print), undefined);
  assert.deepEqual(printed[0], await stageSourceAssets(card, { site: '.' }));
  assert.equal(await runAddonCommand('artifacts', 'stage', [malicious], {}, print), 1);
  assert.match(String(printed[1]), /6 error\(s\): --materialize would refuse this source/);
  await runAddonCommand('artifacts', 'stage', [skill], {}, print);
  assert.match(String(printed[2]), /REVIEW code "pdf-notes\/scripts\/extract.sh"/);
  await assert.rejects(runAddonCommand('artifacts', 'stage', [card], { materialize: true }, print), /--materialize needs --into/);
  await assert.rejects(runAddonCommand('artifacts', 'stage', [card], { 'allow-app': true }, print), /--allow-app is only supported with --materialize/);
  await assert.rejects(runAddonCommand('artifacts', 'inspect', ['x'], { into: 'x' }, print), /only supported by artifacts stage/);
  await assert.rejects(runAddonCommand('extensions', 'stage', [card], {}, print), /only supported by artifacts/);
  const site = await files(t, { 'package.json': '{}\n' });
  await runAddonCommand('artifacts', 'stage', [card], { materialize: true, into: join(site, 'vendor'), site, json: true }, print);
  assert.equal((printed.at(-1) as { event: string }).event, 'source-assets-materialized');
});

test('MCP stage_source_assets returns exactly the CLI facts for a source inside the site, writes nothing and refuses paths outside it', async t => {
  const site = await temp(t);
  await mkdir(join(site, 'app'));
  await cp(card, join(site, 'vendor', 'hello-card'), { recursive: true });
  await symlink(skill, join(site, 'linked-skill'));
  const calls = [
    { name: 'stage_source_assets', arguments: { source: 'vendor/hello-card', into: 'staged' } },
    { name: 'stage_source_assets', arguments: { source: '../outside' } },
    { name: 'stage_source_assets', arguments: { source: '/etc' } },
    { name: 'stage_source_assets', arguments: { source: 'linked-skill' } },
    { name: 'stage_source_assets', arguments: {} },
  ];
  const messages = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }, ...calls.map((params, index) => ({ jsonrpc: '2.0', id: index + 3, method: 'tools/call', params }))];
  let text = '';
  await serveMcp({ project: join(site, 'app'), input: Readable.from([messages.map(value => JSON.stringify(value) + '\n').join('')]), output: new Writable({ write(chunk, _encoding, done) { text += String(chunk); done(); } }) });
  type Reply = { error?: { code: number }; result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[]; content: { text: string }[]; isError?: boolean } };
  const replies = text.trim().split('\n').map(line => JSON.parse(line) as Reply).sort(byReplyId);
  const tool = replies[1]!.result.tools.find(item => item.name === 'stage_source_assets');
  assert.equal(tool?.annotations.readOnlyHint, true);
  const staged = JSON.parse(replies[2]!.result.content[0]!.text) as SourceStageReport;
  assert.deepEqual(staged, JSON.parse(JSON.stringify(await stageSiteSourceAssets(site, 'vendor/hello-card', 'staged'))));
  assert.deepEqual(staged.files.map(file => file.status), ['create', 'create', 'create']);
  assert.equal(await exists(join(site, 'staged')), false, 'staging writes nothing');
  for (const reply of replies.slice(3, 6)) assert.equal(reply.result.isError, true);
  assert.match(replies[3]!.result.content[0]!.text, /\.\. segment/);
  assert.match(replies[5]!.result.content[0]!.text, /symlink/);
  assert.equal(replies[6]!.error?.code, -32602, 'source is required');
});
