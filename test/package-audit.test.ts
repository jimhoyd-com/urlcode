import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { parsePackJson } from '../scripts/pack-json.ts';

test('parsePackJson tolerates leading noise', () => {
  assert.deepEqual(parsePackJson('built 86 modules into dist/\n[\n  {"name":"x"}\n]\n'), [{ name: 'x' }]);
  assert.deepEqual(parsePackJson('[{"name":"y"}]'), [{ name: 'y' }]);
});

test('parsePackJson failure includes stdout and stderr', () => {
  assert.throws(() => parsePackJson('built 86 modules into dist/\n', 'boom'), /built 86 modules[\s\S]*boom/);
});

test('packFileProblems refuses node_modules, a copy of core, and anything but data files in an artifact', async () => {
  const { packFileProblems } = await import('../scripts/package-audit.ts');
  assert.deepEqual(packFileProblems('extension', ['package.json', 'urlcode.json', 'dist/extension.js', 'README.md']), []);
  assert.deepEqual(packFileProblems('core', ['dist/cli.js', 'starters/default/package.json']), []);
  const leaks = packFileProblems('extension', ['dist/index.js', 'node_modules/ajv/package.json', 'vendor/@jimhoyd/urlcode/dist/index.js', 'dist/@jimhoyd/urlcode-audit/index.js']);
  assert.equal(leaks.length, 3);
  assert.match(leaks[0]!, /node_modules\/ must never ship/);
  assert.match(leaks[1]!, /copy of @jimhoyd\/urlcode/);
  assert.match(leaks[2]!, /copy of @jimhoyd\/urlcode/);
  assert.deepEqual(packFileProblems('artifact', ['package.json', 'urlcode.json', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'schemas/config.json', 'config/example.json']), []);
  // JSON, YAML and Markdown data anywhere under a plain path is an artifact's content (#844); code and dotfiles are not.
  const extra = packFileProblems('artifact', ['schemas/config.json', 'dist/index.js', 'schemas/nested/x.json', 'openapi/api.yaml', 'CHANGELOG.md', 'scripts/setup.sh', '.npmrc', 'data/.hidden.json', 'bin/tool']);
  assert.deepEqual(extra.map(line => line.split(':')[0]), ['dist/index.js', 'scripts/setup.sh', '.npmrc', 'data/.hidden.json', 'bin/tool']);
});

test('the audited package list is core plus every add-on, and every one has a budget', async () => {
  const { auditedPackages, budgets } = await import('../scripts/package-audit.ts');
  const { addons } = await import('../scripts/workspaces.ts');
  const list = await auditedPackages();
  assert.deepEqual(list[0], { directory: '.', kind: 'core' });
  const found = await addons();
  assert.deepEqual(list.slice(1).map(item => item.kind), found.map(addon => addon.kind));
  assert.ok(list.some(item => item.directory === join('artifacts', 'store-schema') && item.kind === 'artifact'));
  for (const addon of found) assert.ok(budgets[addon.packageName], `${addon.packageName} has no package audit budget`);
  assert.ok(budgets['@jimhoyd/urlcode']);
});

test('packedLinkProblems names every relative link a packed document cannot follow (#931)', async () => {
  const { packedLinkProblems, isPackedDocument } = await import('../scripts/package-audit.ts');
  const packed = new Set(['README.md', 'llms.txt', 'docs/AI-AUTHORING.md', 'docs/TOOLING.md', 'schemas/urlcode.schema.json', 'examples/cookbook/urlcode.yaml']);
  const source = [
    '[tooling](TOOLING.md#mcp) [schema](../schemas/urlcode.schema.json) [examples](../examples) [here](#top)',
    '[readiness](READINESS.md#coverage-rules) [pinned](https://github.com/jimhoyd-com/urlcode/blob/v1.2.3/docs/READINESS.md)',
    '`[code](NOT-A-LINK.md)` [ref]: ../ROADMAP.md',
    '[roadmap]: ../ROADMAP.md',
    '```md',
    '[fenced](FENCED.md)',
    '```',
  ].join('\n');
  assert.deepEqual(packedLinkProblems('docs/AI-AUTHORING.md', source, packed), [
    'docs/AI-AUTHORING.md:2 links `READINESS.md#coverage-rules`, but `docs/READINESS.md` is not in the package',
    'docs/AI-AUTHORING.md:4 links `../ROADMAP.md`, but `ROADMAP.md` is not in the package',
  ]);
  assert.deepEqual(packedLinkProblems('llms.txt', '[docs](docs/STORE.md) [ok](docs/TOOLING.md)', packed), ['llms.txt:1 links `docs/STORE.md`, but `docs/STORE.md` is not in the package']);
  assert.deepEqual(['README.md', 'llms.txt', 'llms-full.txt', 'dist/cli.js'].filter(isPackedDocument), ['README.md', 'llms.txt', 'llms-full.txt']);
  // This repository's main branch is refused anywhere outside a fence, as a link or a bare `Source:` line (#938).
  assert.deepEqual(packedLinkProblems('llms-full.txt', 'Source: https://github.com/jimhoyd-com/urlcode/blob/main/docs/HTTP.md\n[x](https://github.com/jimhoyd-com/urlcode/tree/main/packages/store) [y](https://github.com/jimhoyd-com/urlcode/blob/v1.2.3/docs/HTTP.md) [z](https://github.com/other/repo/blob/main/x.md)', packed), [
    "llms-full.txt:1 names `https://github.com/jimhoyd-com/urlcode/blob/main/docs/HTTP.md`, this repository's main branch; link blob/v<current version>/... instead",
    "llms-full.txt:2 names `https://github.com/jimhoyd-com/urlcode/tree/main/packages/store`, this repository's main branch; link blob/v<current version>/... instead",
  ]);
});

test('packedStringProblems names docs pages a packed script prints but the package does not ship (#938)', async () => {
  const { packedStringProblems, isPackedCode } = await import('../scripts/package-audit.ts');
  const packed = new Set(['dist/cli.js', 'docs/TOOLING.md']);
  const source = [
    '// See docs/HTTP.md: a comment addresses maintainers and is not read.',
    "/** docs/ASSETS.md */ const shipped = 'docs/TOOLING.md';",
    "const pinned = 'https://github.com/jimhoyd-com/urlcode/blob/v1.2.3/docs/HTTP.md#error-format';",
    "const reason = 'See docs/POLICIES.md#portability.';",
    'const help = `run it, see docs/STATIC.md`;',
    'const mixed = `${shipped} and docs/yaml/functions.md ${pinned} docs/OPERATIONS.md`;',
    "const other = 'mydocs/X.md packages/docs/Y.md';",
  ].join('\n');
  assert.deepEqual(packedStringProblems('dist/cli.js', source, packed), [
    'dist/cli.js:4 names `docs/POLICIES.md`, which the package does not ship',
    'dist/cli.js:5 names `docs/STATIC.md`, which the package does not ship',
    'dist/cli.js:6 names `docs/yaml/functions.md`, which the package does not ship',
    'dist/cli.js:6 names `docs/OPERATIONS.md`, which the package does not ship',
  ]);
  assert.deepEqual(['dist/cli.js', 'recipes/x/functions/a.mjs', 'dist/types/index.d.ts', 'README.md'].filter(isPackedCode), ['dist/cli.js', 'recipes/x/functions/a.mjs']);
});
