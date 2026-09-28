import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeInstalledAgentTooling, hostIdentifier } from '../packages/core/src/addon-install.ts';
import { readAddonCatalog } from '../packages/core/src/addon-manifest.ts';
import type { AddonDescriptor } from '../packages/core/src/addon-manifest.ts';
import { searchDocs } from '../packages/core/src/agent-context.ts';
import { agentProblems, declaredProperties, declaredSchemas, END, expected, firstPartyExtensions, INDEX, missingDescriptions, renderReference, rows, START } from '../scripts/generate-extension-reference.ts';

// #822: every first-party extension's configuration, route-policy and hook schemas are described and rendered into a
// generated field reference; #823: every first-party extension ships agent references, so an installed one is never
// missing from get_addon_agent_tooling. These tests hold the descriptors, the generated README blocks and the
// discovery path together; a passing link check alone is not completeness evidence.

const repo = fileURLToPath(new URL('../', import.meta.url));
const sources = await firstPartyExtensions();
// The nine extensions AGENTS.md names; a new one must be added here deliberately, with its reference and agent entry.
const FIRST_PARTY = ['abuse', 'audit', 'auth', 'form-records', 'forms', 'mail', 'mcp', 'store', 'ui'];

test('the first-party extension set is the one the repository documents', () => {
  assert.deepEqual(sources.map(source => source.name).sort(), FIRST_PARTY);
});

test('every first-party extension ships agent references that resolve inside its package (#823)', async () => {
  for (const source of sources) {
    assert.deepEqual(await agentProblems(source), [], source.name);
    for (const reference of source.descriptor.agent!.references) await access(join(source.directory, reference.path));
  }
  const abuse = sources.find(source => source.name === 'abuse')!;
  assert.deepEqual(abuse.descriptor.agent!.references.map(reference => reference.path), ['README.md', 'SECURITY.md']);
  // The release catalog carries the same agent block, so hosted discovery sees abuse too.
  const catalog = await readAddonCatalog();
  for (const name of FIRST_PARTY) assert.ok(catalog.addons.find(entry => entry.name === name)?.agent?.references.length, `${name} has agent references in the release catalog`);
});

test('the agent-reference check refuses a missing entry and an unshipped path', async () => {
  const abuse = sources.find(source => source.name === 'abuse')!;
  const { agent: _agent, ...bare } = abuse.descriptor;
  assert.match((await agentProblems({ ...abuse, descriptor: bare as AddonDescriptor }))[0]!, /no agent references/);
  const unshipped = { ...abuse, files: ['dist', 'urlcode.json', 'README.md'] };
  assert.match((await agentProblems(unshipped)).join('\n'), /SECURITY\.md is not in package\.json files/);
});

test('every declared configuration, route-policy and hook property has a description (#822)', () => {
  let total = 0;
  for (const source of sources) {
    assert.deepEqual(missingDescriptions(source.descriptor), [], `${source.name} has undescribed properties`);
    total += declaredProperties(source.descriptor).length;
  }
  // 299 at the #822 audit; 243 once the Better Auth rebuild (#841) removed the old auth and admin schemas.
  assert.ok(total >= 243, `the nine descriptors declare ${total} properties; at least 243 are expected in schema and policySchema alone`);
});

test('every described schema still compiles under the strict Ajv options core prepares extensions with', async () => {
  const Ajv = ((await import('ajv/dist/2020.js')) as unknown as { default: new (options: object) => { compile(schema: object): unknown } }).default;
  for (const source of sources) for (const [prefix, schema] of declaredSchemas(source.descriptor)) {
    // packages/core/src/extensions.ts prepareExtensions: a schema Ajv refuses fails the extension before activation.
    assert.doesNotThrow(() => new Ajv({ strict: true, allErrors: false, verbose: true }).compile(schema as object), `${source.name} urlcode.json${prefix}`);
  }
});

test('the description gate walks nested, map-value, branch and hook shapes', () => {
  const descriptor = { kind: 'extension', name: 'probe', description: 'probe', requires: [],
    schema: { type: 'object', properties: { a: { description: 'a', type: 'object', additionalProperties: { type: 'object', properties: { b: { type: 'string' } } } }, c: { description: 'c', oneOf: [{ type: 'string' }, { type: 'object', properties: { d: { type: 'string' } } }] } } },
    policySchema: { type: 'object', properties: { e: { type: 'string' } } },
    hooks: [{ name: 'h', kind: 'action', description: 'h', inputSchema: { type: 'object', properties: { f: { type: 'string' } } } }] } as unknown as AddonDescriptor;
  assert.deepEqual(missingDescriptions(descriptor), ['/schema/properties/a/additionalProperties/properties/b', '/schema/properties/c/oneOf/1/properties/d', '/policySchema/properties/e', '/hooks/0/inputSchema/properties/f']);
});

test('every declared property appears in its extension\'s generated field reference', () => {
  for (const source of sources) {
    const rendered = new Set<string>(), block = renderReference(source);
    for (const [prefix, schema] of declaredSchemas(source.descriptor)) for (const row of rows(schema)) {
      rendered.add(`${prefix}${row.pointer}`);
      assert.ok(block.includes(`${row.path}\``), `${source.name}: ${row.path} is rendered`);
      assert.ok(block.includes(row.description.slice(0, 40).replaceAll('|', '\\|').split('<')[0]!), `${source.name}: ${row.path} carries its description`);
    }
    for (const pointer of declaredProperties(source.descriptor)) assert.ok(rendered.has(pointer), `${source.name}: urlcode.json${pointer} is not in the field reference`);
  }
});

test('the generated READMEs and index are fresh and every reference path resolves', async () => {
  const { files, problems } = await expected();
  assert.deepEqual(problems, []);
  assert.equal(files.size, sources.length + 1);
  for (const [path, content] of files) assert.equal(await readFile(path, 'utf8'), content, `${path} is stale; run npm run docs:extensions`);
  for (const source of sources) {
    const readme = await readFile(join(source.directory, 'README.md'), 'utf8');
    assert.equal(readme.split(START).length, 2, `${source.name} README has one generated block`);
    assert.match(readme.slice(readme.indexOf(START), readme.indexOf(END)), /^## Field reference$/m);
  }
  const index = await readFile(join(repo, INDEX), 'utf8');
  for (const name of FIRST_PARTY) {
    const link = `../packages/${name}/README.md#field-reference`;
    assert.ok(index.includes(link), `${INDEX} links ${link}`);
    await access(join(repo, 'packages', name, 'README.md'));
  }
});

/** A site with `name` installed as core's development manifest pins it, declared in YAML and imported by host.mjs. */
async function site(t: TestContext, names: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-extension-reference-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
  const source = (name: string) => join(repo, 'packages', name);
  for (const name of names) await symlink(source(name), join(root, 'node_modules', '@jimhoyd', `urlcode-${name}`));
  await writeFile(join(root, 'app', 'urlcode.yaml'), `version: "1"\nextensions:\n${names.map(name => `  ${name}: {version: "1", config: {}}\n`).join('')}routes: {}\n`);
  await writeFile(join(root, 'host.mjs'), `import { composeHost } from '@jimhoyd/urlcode/host';\n${names.map(name => `import ${hostIdentifier(name)} from '@jimhoyd/urlcode-${name}/extension';`).join('\n')}\nexport default await composeHost(import.meta.url, [\n${names.map(name => `  ${hostIdentifier(name)}(),`).join('\n')}\n]);\n`);
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: Object.fromEntries(names.map(name => [`@jimhoyd/urlcode-${name}`, `file:${source(name)}`])) }));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: Object.fromEntries(names.map(name => [`node_modules/@jimhoyd/urlcode-${name}`, { link: true, resolved: source(name) }])) }));
  return root;
}

test('an installed abuse appears in get_addon_agent_tooling with references that resolve in the installed package (#823)', async t => {
  const root = await site(t, ['abuse']);
  const tooling = await describeInstalledAgentTooling(join(root, 'app'));
  const abuse = tooling.addons.find(addon => addon.name === 'abuse');
  assert.ok(abuse, 'abuse is listed');
  assert.equal(abuse.kind, 'extension');
  for (const reference of abuse.agent.references) await access(join(root, 'node_modules', '@jimhoyd', 'urlcode-abuse', reference.path));
});

test('core plus an installed extension: a search for an extension-only key reaches its generated field reference (#822)', async t => {
  const root = await site(t, ['store']);
  const found = await searchDocs('shortLinks destination clicks', { project: join(root, 'app') });
  const guide = found.results.find(result => result.id === 'store:README.md');
  assert.ok(guide, `the store README is a result: ${JSON.stringify(found.results.map(result => result.id))}`);
  assert.equal(guide.source, 'installed');
  assert.ok(found.coverage.searched.installed.some(item => item.package === '@jimhoyd/urlcode-store' && item.files.includes('README.md')));
  // A key only the field reference spells out in full is found in that section, with its description.
  const deep = await searchDocs('maxRecordsPerOwner owner_quota_exceeded', { project: join(root, 'app') });
  assert.ok(deep.results.some(result => result.id.startsWith('store:')), JSON.stringify(deep.results.map(result => result.id)));
  // Without the store installed the same query cannot reach it, and says the catalog lists it rather than claiming support.
  const bare = await site(t, []);
  const missing = await searchDocs('shortLinks destination clicks', { project: join(bare, 'app') });
  assert.ok(!missing.results.some(result => result.source === 'installed'));
  assert.equal(missing.catalog.find(match => match.name === 'store')?.installedInProject ?? false, false);
});
