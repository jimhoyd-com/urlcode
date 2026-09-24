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
  const leaks = packFileProblems('extension', ['dist/index.js', 'node_modules/ajv/package.json', 'vendor/@jimhoyd/urlcode/dist/index.js', 'dist/@jimhoyd/urlcode-ui/index.js']);
  assert.equal(leaks.length, 3);
  assert.match(leaks[0]!, /node_modules\/ must never ship/);
  assert.match(leaks[1]!, /copy of @jimhoyd\/urlcode/);
  assert.match(leaks[2]!, /copy of @jimhoyd\/urlcode/);
  assert.deepEqual(packFileProblems('artifact', ['package.json', 'urlcode.json', 'README.md', 'LICENSE', 'NOTICE', 'SECURITY.md', 'schemas/config.json', 'config/example.json']), []);
  const extra = packFileProblems('artifact', ['schemas/config.json', 'dist/index.js', 'schemas/nested/x.json', 'config/example.yaml', 'CHANGELOG.md']);
  assert.deepEqual(extra.map(line => line.split(':')[0]), ['dist/index.js', 'schemas/nested/x.json', 'config/example.yaml', 'CHANGELOG.md']);
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
