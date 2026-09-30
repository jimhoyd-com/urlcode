import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { searchDocs } from '../packages/core/src/agent-context.ts';
import { coreDocs, headingsOf } from '../packages/core/src/docs-search.ts';
import type { DocsSearch } from '../packages/core/src/docs-search.ts';
import { recordPackage, writeFilesLock } from '../packages/core/src/package-files.ts';
import { renderAgentsGuide } from '../packages/core/src/agents-guide.ts';
import { serveMcp } from '../packages/core/src/mcp.ts';
import {byReplyId} from './helpers.ts';

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

test('the generated instructions name the bounded search fallback, and the command they name reaches the mcp guide (#759)', async t => {
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
  const root = await site(t, ['mcp', 'store-schema']);
  const run = spawnSync(process.execPath, [cli, 'docs', 'search', 'serverVersion', '--project', 'app', '--json'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const found = JSON.parse(run.stdout) as DocsSearch;
  assert.equal(found.results[0]?.package, '@jimhoyd/urlcode-mcp');
  assert.equal(found.results[0]?.section, 'Declare a server');
  const text = spawnSync(process.execPath, [cli, 'docs', 'search', 'serverVersion', '--project', 'app'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /matched:/);
  assert.match(text.stdout, /^searched: .*@jimhoyd\/urlcode-mcp/m);
  assert.match(text.stdout, /^not searched: /m);
});

test('serverVersion reaches the mcp guide section and the mcp schema path', async t => {
  const root = await site(t, ['mcp', 'store-schema']);
  const found = await searchDocs('serverVersion', { project: join(root, 'app') });
  bounded(found);
  const guide = found.results.find(result => result.id === 'mcp:README.md');
  assert.ok(guide, 'the mcp guide is a result');
  assert.equal(guide.source, 'installed');
  assert.equal(guide.section, 'Declare a server');
  assert.match(guide.excerpt, /serverVersion/);
  assert.match(guide.next, /"Declare a server" section of node_modules\/@jimhoyd\/urlcode-mcp\/README\.md/);
  const schema = found.results.find(result => result.id === 'mcp:urlcode.json');
  assert.ok(schema, 'the mcp descriptor schema is a result');
  assert.equal(schema.configPath, 'extensions.mcp.config.servers.*.serverVersion');
  assert.match(schema.excerpt, /^"serverVersion": \{/);
  assert.match(schema.next, /get_extensions/);
  assert.ok(found.coverage.searched.installed.some(item => item.package === '@jimhoyd/urlcode-mcp' && item.files.includes('README.md') && item.files.includes('urlcode.json')));
  assert.equal(found.note, undefined);
});

test('an add-on named by the whole query reaches its own guide and schema first', async t => {
  const root = await site(t, ['store']);
  const found = await searchDocs('store', { project: join(root, 'app') });
  bounded(found);
  const [first, second] = found.results;
  assert.equal(first?.id, 'store:README.md');
  assert.equal(first.title, 'store extension guide');
  assert.match(first.excerpt, /bounded JSON CRUD API/);
  assert.equal(second?.id, 'store:urlcode.json');
  assert.equal(second.configPath, 'extensions.store.config');
  const catalog = found.catalog.find(match => match.name === 'store');
  assert.equal(catalog?.availability, 'release-catalog');
  assert.equal(catalog.installedInProject, true);
});

test('an unknown term is an honest no-match with the coverage limits, never "unsupported"', async t => {
  const root = await site(t, ['mcp', 'store-schema']);
  const found = await searchDocs('zzqxnonexistent', { project: join(root, 'app') });
  bounded(found);
  assert.deepEqual(found.results, []);
  assert.deepEqual(found.catalog, []);
  assert.match(found.note ?? '', /^No match in the searched sources\./);
  assert.match(found.note ?? '', /not evidence the feature is unsupported/);
  assert.doesNotMatch(JSON.stringify(found).replace(/not evidence the feature is unsupported/g, ''), /unsupported/i, 'nothing else in the answer calls the term unsupported');
  assert.deepEqual(found.coverage.searched.core, [...corePaths]);
  assert.deepEqual(found.coverage.searched.installed.map(item => item.package), ['@jimhoyd/urlcode-mcp', '@jimhoyd/urlcode-store-schema']);
  const notInstalled = found.coverage.notSearched.find(gap => gap.names !== undefined);
  assert.ok(notInstalled?.names?.includes('store') && notInstalled.names.includes('auth'), 'catalog add-ons that are not installed are listed as not searched');
  assert.ok(!notInstalled?.names?.includes('mcp'));
  for (const source of ['llms-full.txt', 'project files', 'operator host registrations']) assert.ok(found.coverage.notSearched.some(gap => gap.source.includes(source)), source);
  assert.ok(found.next.length > 0);
});

test('extension guides outside the fixed core corpus are covered only when installed; the catalog stays separate', async t => {
  // Without a project only the core corpus is searched: serverVersion is documented by mcp alone.
  const core = await searchDocs('serverVersion');
  bounded(core);
  assert.deepEqual(core.results, []);
  assert.ok(core.coverage.notSearched.some(gap => /no project was given/.test(gap.reason)));
  assert.ok(core.next.some(step => /--project app/.test(step)));
  const named = await searchDocs('store');
  assert.ok(named.results.every(result => result.source === 'core'));
  assert.equal(named.catalog.find(match => match.name === 'store')?.installedInProject, null);

  // An installed artifact and an installed extension are both outside core's corpus.
  const root = await site(t, ['store-schema', 'mcp']);
  const artifact = await searchDocs('store schema', { project: join(root, 'app') });
  bounded(artifact);
  const hit = artifact.results.find(result => result.package === '@jimhoyd/urlcode-store-schema');
  assert.ok(hit && !corePaths.has(hit.path) && hit.kind === 'artifact');
  assert.match(hit.next, /get_extension_artifact/);
  const mcp = await searchDocs('serverVersion', { project: join(root, 'app') });
  assert.ok(mcp.results.some(result => result.package === '@jimhoyd/urlcode-mcp'), 'the mcp guide is searched');
  // store is in the release catalog, not installed here: a catalog match, never a result.
  const absent = await searchDocs('store', { project: join(root, 'app') });
  assert.ok(absent.results.every(result => result.package !== '@jimhoyd/urlcode-store'));
  const listed = absent.catalog.find(match => match.name === 'store');
  assert.equal(listed?.installedInProject, false);
  assert.match(listed.next, /not evidence this project has it/);
});

test('only pin-verified add-ons are read, as data, never imported', async t => {
  // A copy of mcp whose module entry would leave a marker if anything imported it.
  const scratch = await mkdtemp(join(tmpdir(), 'urlcode-docs-search-copy-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = join(scratch, 'imported');
  const copy = join(scratch, 'mcp');
  await mkdir(join(copy, 'dist'), { recursive: true });
  for (const file of ['README.md', 'urlcode.json']) await cp(join(source('mcp'), file), join(copy, file));
  const booby = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'x');export default {};\n`;
  await writeFile(join(copy, 'dist', 'extension.js'), booby);
  await writeFile(join(copy, 'dist', 'index.js'), booby);
  await writeFile(join(copy, 'package.json'), JSON.stringify({ name: '@jimhoyd/urlcode-mcp', version: '0.6.1', type: 'module', main: 'dist/index.js', exports: { '.': './dist/index.js', './extension': './dist/extension.js' } }));
  const root = await site(t, [], { unverified: ['store'], copies: { mcp: copy } });
  const found = await searchDocs('serverVersion shortLinks', { project: join(root, 'app') });
  bounded(found);
  await assert.rejects(access(marker), { code: 'ENOENT' }, 'no add-on module was imported');
  assert.ok(found.results.some(result => result.package === '@jimhoyd/urlcode-mcp'));
  assert.equal(found.coverage.searched.installed.find(item => item.package === '@jimhoyd/urlcode-mcp')?.version, '0.6.1');
  assert.ok(found.results.every(result => result.package !== '@jimhoyd/urlcode-store'), 'an unverified install is not read');
  assert.ok(found.coverage.notSearched.some(gap => gap.source === '@jimhoyd/urlcode-store' && /not pin-verified/.test(gap.reason)));
});

test('broad queries stay bounded', async t => {
  const root = await site(t, ['store', 'auth', 'mcp', 'store-schema']);
  for (const query of ['extension config schema route', 'form', 'the a of to', 'auth', 'sandbox', 'x'.repeat(200) + ' route']) {
    const found = await searchDocs(query, { project: join(root, 'app') });
    bounded(found);
  }
  await assert.rejects(searchDocs('!!'), /must contain a word/);
});

test('MCP search_docs searches the operator-selected site and states its coverage', async t => {
  const root = await site(t, ['mcp', 'store-schema']);
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_docs', arguments: { text: 'serverVersion' } } },
  ];
  await serveMcp({ project: join(root, 'app'), input: Readable.from([messages.map(value => JSON.stringify(value) + '\n').join('')]), output });
  const replies = text.trim().split('\n').map(line => JSON.parse(line) as { result: { tools?: { name: string; description: string }[]; content?: { text: string }[] } }).sort(byReplyId);
  const tool = replies[1]!.result.tools!.find(candidate => candidate.name === 'search_docs')!;
  assert.match(tool.description, /installed and verified in this site \(core-pinned, or independent/);
  assert.match(tool.description, /not that a feature is unsupported/);
  const found = JSON.parse(replies[2]!.result.content![0]!.text) as DocsSearch;
  assert.equal(found.results[0]?.id, 'mcp:README.md');
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

// #826: a `#` comment inside a fenced code block is not a Markdown heading, so it never names the section.
test('a shell comment in a code fence is not the section of a store README match (#826)', async t => {
  const root = await site(t, ['store']);
  const found = await searchDocs('maxRecordsPerOwner', { project: join(root, 'app') });
  bounded(found);
  const guide = found.results.find(result => result.id === 'store:README.md');
  assert.ok(guide, 'the store guide is a result');
  assert.notEqual(guide.section, 'or, in an existing site:');
  const headings = headingsOf(await readFile(join(repo, 'packages/store/README.md'), 'utf8')).map(heading => heading.title);
  assert.ok(guide.section !== undefined && headings.includes(guide.section), `${guide.section} is a real heading of the store README`);
  assert.ok(!headings.some(title => title.startsWith('or, in an existing site')));
});

// #931: intervals and transfers have their own store README headings, so a search for either lands on it.
test('a search for intervals or transfers lands on its own store README section (#931)', async t => {
  const root = await site(t, ['store']);
  for (const [query, section] of [['intervals', 'Intervals'], ['transfers', 'Transfers']] as const) {
    const found = await searchDocs(query, { project: join(root, 'app') });
    bounded(found);
    assert.equal(found.results.find(result => result.id === 'store:README.md')?.section, section, query);
  }
});

test('headings inside backtick and tilde fences are ignored, with CommonMark closing rules (#826)', () => {
  const titles = (text: string) => headingsOf(text).map(heading => heading.title);
  // No fences: every ATX heading at column 0, as before.
  assert.deepEqual(titles('# One\ntext\n## Two ##\n#no\n  # indented\n### Three'), ['One', 'Two', 'Three']);
  // Backtick and tilde fences, with info strings and up to three spaces of indentation.
  assert.deepEqual(titles('# A\n```sh\n# comment\n```\n## B\n~~~yaml title="x"\n# yaml comment\n~~~\n## C\n   ```\n# c\n   ```\n## D'), ['A', 'B', 'C', 'D']);
  // A heading right after the closing fence counts; a run with text after it does not close.
  assert.deepEqual(titles('```\n# x\n```\n# After'), ['After']);
  assert.deepEqual(titles('```\n# x\n``` not a close\n# still code\n```\n# After'), ['After']);
  // Only the same character, at least as long, closes: a shorter run or the other character is content.
  assert.deepEqual(titles('````md\n```\n# inner\n```\n# still inside\n````\n# Out'), ['Out']);
  assert.deepEqual(titles('~~~\n```\n# inner\n~~~~~\n# Out'), ['Out']);
  assert.deepEqual(titles('```\n~~~\n# inner\n```\n# Out'), ['Out']);
  // A backtick run with a backtick in its info string is not a fence; nor is one indented four spaces.
  assert.deepEqual(titles('``` a`b\n# Real'), ['Real']);
  assert.deepEqual(titles('    ```\n# Real'), ['Real']);
  // An unclosed fence runs to the end of the document.
  assert.deepEqual(titles('# Top\n```\n# a\n## b'), ['Top']);
  // Positions are the start of the heading line; a CRLF closing fence closes.
  const text = 'intro\n```\r\n# x\r\n```\r\n## Real\n';
  assert.deepEqual(headingsOf(text), [{ title: 'Real', index: text.indexOf('## Real') }]);
});

test('a fence comment above a match does not rank it as opening a section (#826)', async t => {
  const readme = [
    '# Probe add-on', '', '## Setup', '', '```sh', '# comment', 'widgetQuota=1 npm start', '```', '',
    'Some prose.', '', '## Limits', '', 'Other prose.', 'Set widgetQuota to cap widgets.', '',
  ].join('\n');
  const copy = await mkdtemp(join(tmpdir(), 'urlcode-docs-search-fence-'));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(source('mcp'), copy, { recursive: true, filter: path => !path.includes('node_modules') });
  await writeFile(join(copy, 'README.md'), readme);
  const root = await site(t, [], { copies: { mcp: copy } });
  const found = await searchDocs('widgetQuota', { project: join(root, 'app') });
  const guide = found.results.find(result => result.id === 'mcp:README.md');
  assert.ok(guide, 'the copied guide is a result');
  // Both occurrences start a line; the first sits just below `# comment`, which is code, not a heading, so the tie
  // keeps the first occurrence, under the real Setup heading.
  assert.equal(guide.section, 'Setup');
  assert.match(guide.excerpt, /^## Setup/);
});

/**
 * A site with an independent add-on package (#844) as `urlcode extensions add` leaves it: a lock entry carrying npm's
 * sha512 integrity and, unless `record` is false, its installed files recorded in addon-files.lock.json.
 */
async function independentSite(t: TestContext, { pkg = '@audit/notes', name = 'notes', record = true } = {}): Promise<{ root: string; directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-docs-search-independent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app', 'urlcode.yaml'), 'version: "1"\nroutes: {}\n');
  const directory = join(root, 'node_modules', ...pkg.split('/'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: pkg, version: '1.2.3' }));
  await writeFile(join(directory, 'urlcode.json'), JSON.stringify({ kind: 'extension', name, description: `The ${name} extension from an independent publisher.`, contract: 2, requires: [], targets: ['node'], schema: { type: 'object' },
    agent: { description: `How to use ${name}.`, references: [{ name: `${name} field guide`, description: 'Fields and limits.', path: 'GUIDE.md' }] } }));
  await writeFile(join(directory, 'README.md'), `# ${name}\n\n## Quokkas\n\nThe quokkaunique option turns on marsupial mode.\n`);
  await writeFile(join(directory, 'GUIDE.md'), `# ${name} fields\n\nwallabyfield limits the pouch.\n`);
  const entry = { version: '1.2.3', resolved: `https://registry.example/${pkg}/-/package-1.2.3.tgz`, integrity: `sha512-${createHash('sha512').update(pkg).digest('base64')}` };
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { [pkg]: '^1.2.3' } }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, [`node_modules/${pkg}`]: entry } }));
  if (record) await writeFilesLock(root, { lockfileVersion: 1, packages: { [pkg]: await recordPackage(root, pkg, entry, { name, kind: 'extension', spec: pkg }) } });
  return { root, directory };
}

test('a verified independent add-on\'s guide and agent references are searched and labelled as independent (#1090)', async t => {
  const { root } = await independentSite(t);
  const found = await searchDocs('quokkaunique', { project: join(root, 'app') });
  bounded(found);
  const guide = found.results.find(result => result.id === 'notes:README.md');
  assert.ok(guide, 'the independent README is a result');
  assert.deepEqual([guide.source, guide.package, guide.version, guide.section], ['installed', '@audit/notes', '1.2.3', 'Quokkas']);
  assert.match(guide.next, /node_modules\/@audit\/notes\/README\.md \(this site's installed independent package/);
  assert.deepEqual(found.coverage.searched.installed, [{ package: '@audit/notes', version: '1.2.3', files: ['urlcode.json', 'README.md', 'GUIDE.md'], independent: true }]);
  assert.ok(!found.coverage.notSearched.some(gap => gap.source.startsWith('@audit/notes')), 'a verified package is not also listed as not searched');
  // A declared agent reference is searched as well.
  assert.equal((await searchDocs('wallabyfield', { project: join(root, 'app') })).results[0]?.id, 'notes:GUIDE.md');
});

test('an independent add-on whose installed files changed or were never recorded is reported as not searched (#1090)', async t => {
  const { root, directory } = await independentSite(t);
  await writeFile(join(directory, 'README.md'), '# notes\n\nquokkaunique, but tampered after install.\n');
  const tampered = await searchDocs('quokkaunique', { project: join(root, 'app') });
  assert.ok(!tampered.results.some(result => result.package === '@audit/notes'), 'modified files are not read');
  assert.deepEqual(tampered.coverage.searched.installed, []);
  const gap = tampered.coverage.notSearched.find(item => item.source === '@audit/notes');
  assert.ok(gap, JSON.stringify(tampered.coverage.notSearched));
  assert.match(gap.reason, /independent package providing notes, installed but not verified \(.*differ from addon-files\.lock\.json.*\); not read\. get_addon_agent_tooling/);
  const { root: unrecorded } = await independentSite(t, { record: false });
  const missing = await searchDocs('quokkaunique', { project: join(unrecorded, 'app') });
  assert.deepEqual(missing.results.filter(result => result.source === 'installed'), []);
  assert.match(missing.coverage.notSearched.find(item => item.source === '@audit/notes')?.reason ?? '', /no entry in addon-files\.lock\.json/);
});

test('an independent package in a first-party role is searched, and the catalog match names it rather than the bundled package (#1090)', async t => {
  const { root } = await independentSite(t, { pkg: '@audit/store', name: 'store' });
  const found = await searchDocs('quokkaunique store', { project: join(root, 'app') });
  assert.ok(found.results.some(result => result.package === '@audit/store'), 'the independent store guide is read');
  const store = found.catalog.find(match => match.name === 'store');
  assert.ok(store, 'the release catalog still lists store');
  assert.equal(store.installedInProject, true);
  assert.match(store.next, /independent package @audit\/store, not @jimhoyd\/urlcode-store/);
  assert.ok(!found.coverage.notSearched.some(gap => gap.names?.includes('store')), 'store is not reported as uninstalled');
});
