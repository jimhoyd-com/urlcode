import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { searchDocs } from '../packages/core/src/agent-context.ts';
import { coreDocs } from '../packages/core/src/docs-search.ts';
import type { DocsSearch } from '../packages/core/src/docs-search.ts';
import { renderAgentsGuide } from '../packages/core/src/agents-guide.ts';
import { serveMcp } from '../packages/core/src/mcp.ts';

// #759: search_docs / urlcode docs search is the bounded documentation fallback the generated agent instructions
// name. These tests hold the instructions and the retrieval contract together: what the guide tells an agent to run
// must reach the authoritative add-on guide or schema, stay bounded and report its coverage honestly.

const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = join(repo, 'packages/core/src/cli.ts');
const source = (name: string) => join(repo, name === 'store-schema' ? 'artifacts' : 'packages', name);

/**
 * A site whose node_modules holds the named add-ons (linked to this checkout's sources, as `npm run build`'s
 * development manifest pins them). `unverified` names get a lock entry that does not match core's pin.
 */
async function site(t: TestContext, installed: readonly string[], { unverified = [] as readonly string[], copies = {} as Record<string, string> } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-docs-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app', 'urlcode.yaml'), 'version: "1"\nroutes: {}\n');
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  const all = [...installed, ...unverified, ...Object.keys(copies)];
  for (const name of all) {
    const target = join(root, 'node_modules', '@jimhoyd', `urlcode-${name}`);
    if (copies[name] !== undefined) await cp(copies[name]!, target, { recursive: true });
    else await symlink(source(name), target);
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(all.map(name => [`@jimhoyd/urlcode-${name}`, `file:${source(name)}`])) }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: Object.fromEntries(all.map(name => [`node_modules/@jimhoyd/urlcode-${name}`,
    unverified.includes(name) ? { version: '0.0.0', resolved: 'https://registry.example/tampered.tgz', integrity: 'sha512-x' } : { link: true, resolved: source(name) }])) }));
  return root;
}
function bounded(found: DocsSearch): void {
  assert.ok(found.results.length <= 3, 'at most three results');
  for (const result of found.results) assert.ok(result.excerpt.length <= 1800, `${result.id} excerpt is bounded`);
  assert.ok(found.catalog.length <= 5, 'at most five catalog matches');
  assert.ok(found.next.length <= 4, 'at most four next steps');
  assert.ok(JSON.stringify(found).length <= 16384, `answer is ${JSON.stringify(found).length} bytes; keep it under 16 KiB`);
}
const corePaths: ReadonlySet<string> = new Set(coreDocs.map(doc => doc.file));

test('the generated instructions name the bounded search fallback, and the command they name reaches the forms guide (#759)', async t => {
  const guide = renderAgentsGuide({ routes: 0 });
  assert.match(guide, /Do not read or grep `llms-full\.txt` or whole packaged docs/);
  assert.match(guide, /bounded fallback `search_docs` \(`urlcode docs search TEXT --project app`\)/);
  assert.match(guide, /installed add-on guides and `urlcode\.json` schemas/);
  assert.match(guide, /no match there is not evidence a feature is unsupported/);
  assert.equal(await readFile(join(repo, 'starters/default/AGENTS.md'), 'utf8').then(text => text.includes('bounded fallback `search_docs`')), true, 'the starter AGENTS.md is regenerated');
  for (const path of ['skills/urlcode/SKILL.md', '.claude/skills/urlcode-authoring/SKILL.md', 'packaging/claude-plugin/skills/urlcode-authoring/SKILL.md']) {
    const text = (await readFile(join(repo, path), 'utf8')).replace(/\s+/g, ' ');
    assert.match(text, /search_docs/, path);
    assert.match(text, /urlcode\.json` schemas/, `${path} names the installed add-on schemas`);
    assert.match(text, /not (?:evidence (?:that )?a feature is|an) unsupported/, `${path} says an empty result is not a capability verdict`);
  }

  // Run exactly what the guide tells an agent to run, from the site.
  const root = await site(t, ['forms', 'ui']);
  const run = spawnSync(process.execPath, [cli, 'docs', 'search', 'requiredWhen', '--project', 'app', '--json'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const found = JSON.parse(run.stdout) as DocsSearch;
  assert.equal(found.results[0]?.package, '@jimhoyd/urlcode-forms');
  assert.equal(found.results[0]?.section, 'Conditionally required fields');
  const text = spawnSync(process.execPath, [cli, 'docs', 'search', 'requiredWhen', '--project', 'app'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /matched:/);
  assert.match(text.stdout, /^searched: .*@jimhoyd\/urlcode-forms/m);
  assert.match(text.stdout, /^not searched: /m);
});

test('requiredWhen reaches the forms guide section and the forms schema path', async t => {
  const root = await site(t, ['forms', 'ui']);
  const found = await searchDocs('requiredWhen', { project: join(root, 'app') });
  bounded(found);
  const guide = found.results.find(result => result.id === 'forms:README.md');
  assert.ok(guide, 'the forms guide is a result');
  assert.equal(guide.source, 'installed');
  assert.equal(guide.section, 'Conditionally required fields');
  assert.match(guide.excerpt, /`requiredWhen: \{field, in\}`/);
  assert.match(guide.next, /"Conditionally required fields" section of node_modules\/@jimhoyd\/urlcode-forms\/README\.md/);
  const schema = found.results.find(result => result.id === 'forms:urlcode.json');
  assert.ok(schema, 'the forms descriptor schema is a result');
  assert.equal(schema.configPath, 'extensions.forms.config.flows.*.fields.*.requiredWhen');
  assert.match(schema.excerpt, /^"requiredWhen": \{/);
  assert.match(schema.next, /get_extensions/);
  assert.ok(found.coverage.searched.installed.some(item => item.package === '@jimhoyd/urlcode-forms' && item.files.includes('README.md') && item.files.includes('urlcode.json')));
  assert.equal(found.note, undefined);
});

test('form-records reaches its own composition contract first', async t => {
  const root = await site(t, ['forms', 'store', 'ui', 'form-records']);
  const found = await searchDocs('form-records', { project: join(root, 'app') });
  bounded(found);
  const [first, second] = found.results;
  assert.equal(first?.id, 'form-records:README.md');
  assert.equal(first.title, 'form-records extension guide');
  assert.match(first.excerpt, /owns only the composition/);
  assert.match(first.excerpt, /never reads `extensions\.forms\.config` or `extensions\.store\.config`/);
  assert.equal(second?.id, 'form-records:urlcode.json');
  assert.equal(second.configPath, 'extensions.form-records.config');
  assert.match(second.excerpt, /"requires": \[\s*"forms",\s*"store",\s*"ui"/);
  const catalog = found.catalog.find(match => match.name === 'form-records');
  assert.equal(catalog?.availability, 'release-catalog');
  assert.equal(catalog.installedInProject, true);
});

test('an unknown term is an honest no-match with the coverage limits, never "unsupported"', async t => {
  const root = await site(t, ['forms', 'ui']);
  const found = await searchDocs('zzqxnonexistent', { project: join(root, 'app') });
  bounded(found);
  assert.deepEqual(found.results, []);
  assert.deepEqual(found.catalog, []);
  assert.match(found.note ?? '', /^No match in the searched sources\./);
  assert.match(found.note ?? '', /not evidence the feature is unsupported/);
  assert.doesNotMatch(JSON.stringify(found).replace(/not evidence the feature is unsupported/g, ''), /unsupported/i, 'nothing else in the answer calls the term unsupported');
  assert.deepEqual(found.coverage.searched.core, [...corePaths]);
  assert.deepEqual(found.coverage.searched.installed.map(item => item.package), ['@jimhoyd/urlcode-forms', '@jimhoyd/urlcode-ui']);
  const notInstalled = found.coverage.notSearched.find(gap => gap.names !== undefined);
  assert.ok(notInstalled?.names?.includes('form-records') && notInstalled.names.includes('auth'), 'catalog add-ons that are not installed are listed as not searched');
  assert.ok(!notInstalled?.names?.includes('forms'));
  for (const source of ['llms-full.txt', 'project files', 'operator host registrations']) assert.ok(found.coverage.notSearched.some(gap => gap.source.includes(source)), source);
  assert.ok(found.next.length > 0);
});

test('extension guides outside the fixed core corpus are covered only when installed; the catalog stays separate', async t => {
  // Without a project only the core corpus is searched: requiredWhen is documented by forms alone.
  const core = await searchDocs('requiredWhen');
  bounded(core);
  assert.deepEqual(core.results, []);
  assert.ok(core.coverage.notSearched.some(gap => /no project was given/.test(gap.reason)));
  assert.ok(core.next.some(step => /--project app/.test(step)));
  const named = await searchDocs('form-records');
  assert.ok(named.results.every(result => result.source === 'core'));
  assert.equal(named.catalog.find(match => match.name === 'form-records')?.installedInProject, null);

  // An installed artifact and an installed extension are both outside core's corpus.
  const root = await site(t, ['store-schema', 'mail']);
  const artifact = await searchDocs('store schema', { project: join(root, 'app') });
  bounded(artifact);
  const hit = artifact.results.find(result => result.package === '@jimhoyd/urlcode-store-schema');
  assert.ok(hit && !corePaths.has(hit.path) && hit.kind === 'artifact');
  assert.match(hit.next, /get_extension_artifact/);
  const mail = await searchDocs('transport', { project: join(root, 'app') });
  assert.ok(mail.results.some(result => result.package === '@jimhoyd/urlcode-mail'), 'the mail guide is searched');
  // form-records is in the release catalog, not installed here: a catalog match, never a result.
  const absent = await searchDocs('form-records', { project: join(root, 'app') });
  assert.ok(absent.results.every(result => result.package !== '@jimhoyd/urlcode-form-records'));
  const listed = absent.catalog.find(match => match.name === 'form-records');
  assert.equal(listed?.installedInProject, false);
  assert.match(listed.next, /not evidence this project has it/);
});

test('only pin-verified add-ons are read, as data, never imported', async t => {
  // A copy of forms whose module entry would leave a marker if anything imported it.
  const scratch = await mkdtemp(join(tmpdir(), 'urlcode-docs-search-copy-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = join(scratch, 'imported');
  const copy = join(scratch, 'mail');
  await mkdir(join(copy, 'dist'), { recursive: true });
  for (const file of ['README.md', 'urlcode.json']) await cp(join(source('mail'), file), join(copy, file));
  const booby = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'x');export default {};\n`;
  await writeFile(join(copy, 'dist', 'extension.js'), booby);
  await writeFile(join(copy, 'dist', 'index.js'), booby);
  await writeFile(join(copy, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode-mail', version: '0.6.1', type: 'module', main: 'dist/index.js', exports: { '.': './dist/index.js', './extension': './dist/extension.js' } }));
  const root = await site(t, [], { unverified: ['forms'], copies: { mail: copy } });
  const found = await searchDocs('transport requiredWhen', { project: join(root, 'app') });
  bounded(found);
  await assert.rejects(access(marker), { code: 'ENOENT' }, 'no add-on module was imported');
  assert.ok(found.results.some(result => result.package === '@jimhoyd/urlcode-mail'));
  assert.equal(found.coverage.searched.installed.find(item => item.package === '@jimhoyd/urlcode-mail')?.version, '0.6.1');
  assert.ok(found.results.every(result => result.package !== '@jimhoyd/urlcode-forms'), 'an unverified install is not read');
  assert.ok(found.coverage.notSearched.some(gap => gap.source === '@jimhoyd/urlcode-forms' && /not pin-verified/.test(gap.reason)));
});

test('broad queries stay bounded', async t => {
  const root = await site(t, ['forms', 'store', 'ui', 'form-records', 'auth', 'admin', 'mail', 'abuse', 'audit', 'mcp', 'store-schema']);
  for (const query of ['extension config schema route', 'form', 'the a of to', 'auth', 'sandbox', 'x'.repeat(200) + ' route']) {
    const found = await searchDocs(query, { project: join(root, 'app') });
    bounded(found);
  }
  await assert.rejects(searchDocs('!!'), /must contain a word/);
});

test('MCP search_docs searches the operator-selected site and states its coverage', async t => {
  const root = await site(t, ['forms', 'ui']);
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_docs', arguments: { text: 'requiredWhen' } } },
  ];
  await serveMcp({ project: join(root, 'app'), input: Readable.from([messages.map(value => JSON.stringify(value) + '\n').join('')]), output });
  const replies = text.trim().split('\n').map(line => JSON.parse(line) as { result: { tools?: { name: string; description: string }[]; content?: { text: string }[] } });
  const tool = replies[1]!.result.tools!.find(candidate => candidate.name === 'search_docs')!;
  assert.match(tool.description, /installed and pin-verified/);
  assert.match(tool.description, /not that a feature is unsupported/);
  const found = JSON.parse(replies[2]!.result.content![0]!.text) as DocsSearch;
  assert.equal(found.results[0]?.id, 'forms:README.md');
  assert.ok(found.coverage.notSearched.length > 0);
});

test('agent-facts rejects prose that shrinks the search back to the core corpus or reads no-match as unsupported', async t => {
  const script = join(repo, 'scripts/check-agent-facts.ts');
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-docs-search-facts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scan = async (body: string) => { const file = join(dir, 'SKILL.md'); await writeFile(file, body); return spawnSync(process.execPath, [script, '--files', file], { encoding: 'utf8', timeout: 30000 }); };
  for (const [body, fact] of [
    ['`search_docs` searches the small packaged agent documentation corpus.\n', 'docsSearch.installedAddonGuides'],
    ['If `urlcode docs search` returns no match, that means the feature is unsupported.\n', 'docsSearch.emptyIsNoMatch'],
  ] as const) {
    const result = await scan(body);
    assert.equal(result.status, 1, `${fact} should reject: ${body}`);
    assert.ok(result.stderr.includes(`[${fact}`), result.stderr);
  }
  const clean = await scan('`search_docs` covers installed add-on guides; no match there is not evidence a feature is unsupported.\n');
  assert.equal(clean.status, 0, clean.stderr);
});
