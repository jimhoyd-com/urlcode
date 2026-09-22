import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { validateDocument, loadDocument, parseYaml } from '../packages/core/src/config.ts';
import { runProjectTests } from '../packages/core/src/project-tests.ts';
import { project } from './helpers.ts';

const shared = {
  api: { request: { body: { maxBytes: 100 } }, response: { headers: { 'Cache-Control': 'no-store' } } },
  page: { response: { headers: { 'X-Page': 'yes' } } },
};

test('use copies the shared blocks and is removed from the resolved route', () => {
  const document = validateDocument({ version: '1', shared, routes: { '/a': { use: 'api', respond: { text: 'x' } } } });
  assert.deepEqual(document.routes['/a'], { request: { body: { maxBytes: 100 } }, response: { headers: { 'Cache-Control': 'no-store' } }, respond: { text: 'x' } });
});
test("a route's own request or response wins as a whole block, with no deep merge", () => {
  const document = validateDocument({ version: '1', shared, routes: {
    '/a': { use: 'api', request: { body: { required: true } }, respond: { text: 'x' } },
    '/b': { use: 'api', response: { headers: { 'X-Own': '1' } }, respond: { text: 'x' } },
  } });
  assert.deepEqual(document.routes['/a']?.request, { body: { required: true } });
  assert.deepEqual(document.routes['/a']?.response, { headers: { 'Cache-Control': 'no-store' } });
  assert.deepEqual(document.routes['/b']?.response, { headers: { 'X-Own': '1' } });
  assert.deepEqual(document.routes['/b']?.request, { body: { maxBytes: 100 } });
});
test('resolved routes do not alias the shared block', () => {
  const document = validateDocument({ version: '1', shared, routes: { '/a': { use: 'page', respond: { text: 'x' } }, '/b': { use: 'page', respond: { text: 'y' } } } });
  assert.notEqual(document.routes['/a']?.response, document.routes['/b']?.response);
});
test('an unknown name, a bad name, an unsupported key and a reserved header fail validation', () => {
  const route = { respond: { text: 'x' } };
  assert.throws(() => validateDocument({ version: '1', shared, routes: { '/a': { use: 'nope', ...route } } }), /unknown shared block nope/);
  assert.throws(() => validateDocument({ version: '1', routes: { '/a': { use: 'api', ...route } } }), /unknown shared block/);
  assert.throws(() => validateDocument({ version: '1', shared, routes: { '/a': { use: 'Bad Name', ...route } } }), /Invalid configuration/);
  assert.throws(() => validateDocument({ version: '1', shared: { x: { sandboxReason: 'no' } }, routes: {} }), /Invalid configuration/);
  assert.throws(() => validateDocument({ version: '1', shared: { x: { response: { headers: { ETag: '"a"' } } } }, routes: {} }), /shared\.x: response header ETag/);
  assert.throws(() => validateDocument({ version: '1', shared: { x: { response: { headers: { 'content-LENGTH': '1' } } } }, routes: {} }), /owned by the runtime/);
});
test('YAML anchors, aliases and merge keys stay rejected', () => {
  assert.throws(() => parseYaml('version: "1"\nshared:\n  a: &a {}\nroutes:\n  /x: *a'));
  assert.throws(() => parseYaml('version: "1"\nroutes:\n  /x:\n    <<: {respond: {text: x}}'));
});
test('the loader resolves included routes against the entry shared map and refuses shared in includes', async t => {
  const root = await project(t, {}, {}, { shared, includes: ['more.yaml'] });
  await writeFile(join(root, 'more.yaml'), stringify({ version: '1', routes: { '/inc': { use: 'api', respond: { text: 'x' } } } }));
  const loaded = await loadDocument(root);
  assert.deepEqual(loaded.routes['/inc']?.response, { headers: { 'Cache-Control': 'no-store' } });
  assert.equal(loaded.routes['/inc']?.use, undefined);
  await writeFile(join(root, 'more.yaml'), stringify({ version: '1', shared, routes: {} }));
  await assert.rejects(loadDocument(root), /shared may only be set in the entry/);
  await writeFile(join(root, 'more.yaml'), stringify({ version: '1', routes: { '/inc': { use: 'nope', respond: { text: 'x' } } } }));
  await assert.rejects(loadDocument(root), /Configuration|unknown shared block/);
});
test('the route hash follows the resolved result: equal routes hash equally, changed blocks change it', async t => {
  const version = async (settings: Record<string, unknown>, route: object): Promise<string> => (await loadDocument(await project(t, { '/a': route }, {}, settings))).version;
  const via = await version({ shared }, { use: 'api', respond: { text: 'x' } });
  const inline = await version({}, { respond: { text: 'x' }, ...shared.api });
  assert.equal(via, inline);
  const changed = await version({ shared: { api: { ...shared.api, response: { headers: { 'Cache-Control': 'no-cache' } } } } }, { use: 'api', respond: { text: 'x' } });
  assert.notEqual(via, changed);
});
test('the published shared-blocks example passes its fixtures', async () => {
  const result = await runProjectTests(fileURLToPath(new URL('../examples/shared-blocks', import.meta.url)), {});
  assert.deepEqual(result, { total: 5, failed: 0 });
});
