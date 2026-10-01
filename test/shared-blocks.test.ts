import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { validateDocument, loadDocument, parseYaml } from '../packages/core/src/config.ts';
import { runProjectTests } from '../packages/core/src/project-tests.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { startServer } from '../packages/core/src/server.ts';
import { explainRoute } from '../packages/core/src/tooling.ts';
import { project, approveBindings, request } from './helpers.ts';

const redirectRoute = { redirect: { url: 'https://example.com/' } };
const copy = <T>(value: T): T => structuredClone(value);
const shared = {
  api: { request: { body: { GET: { maxBytes: 100 } } }, response: { headers: { 'Cache-Control': 'no-store' } } },
  page: { response: { headers: { 'X-Page': 'yes' } } },
};

test('use copies the shared blocks and is removed from the resolved route', () => {
  const document = validateDocument({ version: '1', shared, routes: { '/a': { use: 'api', respond: { text: 'x' } } } });
  assert.deepEqual(document.routes['/a'], { request: { body: { GET: { maxBytes: 100 } } }, response: { headers: { 'Cache-Control': 'no-store' } }, respond: { text: 'x' } });
});
test("a route's own request or response wins as a whole block, with no deep merge", () => {
  const document = validateDocument({ version: '1', shared, routes: {
    '/a': { use: 'api', request: { body: { GET: { maxBytes: 0 } } }, respond: { text: 'x' } },
    '/b': { use: 'api', response: { headers: { 'X-Own': '1' } }, respond: { text: 'x' } },
  } });
  assert.deepEqual(document.routes['/a']?.request, { body: { GET: { maxBytes: 0 } } });
  assert.deepEqual(document.routes['/a']?.response, { headers: { 'Cache-Control': 'no-store' } });
  assert.deepEqual(document.routes['/b']?.response, { headers: { 'X-Own': '1' } });
  assert.deepEqual(document.routes['/b']?.request, { body: { GET: { maxBytes: 100 } } });
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

// #1133 (reverses #576): shared blocks carry env and secrets, resolved into each route so every route's
// requested authority stays visible and pinned per route.
const bindingBlocks = {
  skills: { env: { SKILLS: { env: 'MCP_ENABLED_SKILLS' }, REGION: { value: 'eu-west-1' } }, secrets: { KEY: { secret: 'api_key' } } },
};
test('use merges shared env and secrets name by name; the route-level entry wins', () => {
  const document = validateDocument({ version: '1', shared: bindingBlocks, routes: {
    '/a': { use: 'skills', respond: { text: 'x' } },
    '/b': { use: 'skills', env: { REGION: { value: 'us-east-1' }, OWN: { env: 'OWN_VAR' } }, secrets: { KEY: { secret: 'other_key' } }, respond: { text: 'x' } },
    '/c': { respond: { text: 'x' } },
  } });
  assert.deepEqual(document.routes['/a']?.env, { SKILLS: { env: 'MCP_ENABLED_SKILLS' }, REGION: { value: 'eu-west-1' } });
  assert.deepEqual(document.routes['/a']?.secrets, { KEY: { secret: 'api_key' } });
  assert.deepEqual(document.routes['/b']?.env, { SKILLS: { env: 'MCP_ENABLED_SKILLS' }, REGION: { value: 'us-east-1' }, OWN: { env: 'OWN_VAR' } });
  assert.deepEqual(document.routes['/b']?.secrets, { KEY: { secret: 'other_key' } });
  assert.equal(document.routes['/c']?.env, undefined);
  assert.equal(document.routes['/c']?.secrets, undefined);
  // The shared block itself is untouched and never aliased by a resolved route.
  assert.deepEqual(bindingBlocks.skills.env.REGION, { value: 'eu-west-1' });
  assert.notEqual(document.routes['/a']?.env?.SKILLS, document.shared?.skills?.env?.SKILLS);
  // A block without bindings adds no empty env/secrets key.
  assert.equal(validateDocument({ version: '1', shared, routes: { '/d': { use: 'page', respond: { text: 'x' } } } }).routes['/d']?.env, undefined);
});
test('a route names at most one shared block, so two blocks can never conflict over a binding', () => {
  assert.throws(() => validateDocument({ version: '1', shared: { ...bindingBlocks, other: { env: { SKILLS: { value: 'x' } } } }, routes: { '/a': { use: ['skills', 'other'], respond: { text: 'x' } } } }), /Invalid configuration/);
});
test('shared env and secrets use the route-level shapes and refuse anything else', () => {
  const bad = (block: unknown) => () => validateDocument({ version: '1', shared: { x: block }, routes: {} });
  assert.throws(bad({ env: { A: { env: 'X', extra: '1' } } }), /Invalid configuration/);
  assert.throws(bad({ env: { 'bad-name': { value: 'x' } } }), /Invalid configuration/);
  assert.throws(bad({ env: { A: { value: 'x', env: 'X' } } }), /Invalid configuration/);
  assert.throws(bad({ secrets: { K: { value: 'inline-secret' } } }), /Invalid configuration/);
  assert.throws(bad({ secrets: { K: { secret: 'n', default: 'd' } } }), /Invalid configuration/);
  assert.throws(bad({ grants: { env: ['X'] } }), /Invalid configuration/);
  assert.doesNotThrow(bad({ env: { A: { env: 'X', default: 'd' }, B: { value: 'v' } }, secrets: { K: { secret: 'n' } } }));
});
test('urlcode permissions lists inherited grants per route; adding a route to a block changes its grants and the revision', async t => {
  const settings = { shared: copy(bindingBlocks) };
  const root = await project(t, { '/a': { use: 'skills', ...copy(redirectRoute) }, '/b': { ...copy(redirectRoute) } }, {}, settings);
  const before = await approveBindings(root);
  assert.deepEqual(before.routes, { '/a': { env: ['MCP_ENABLED_SKILLS'], secrets: ['api_key'] } });
  const environment = { MCP_ENABLED_SKILLS: 'alpha', api_key: 'TEST_SECRET' };
  await (await startServer({ project: root, port: 0, log: () => {}, environment, permissions: before })).close();
  // The same project with /b now selecting the block.
  await writeFile(join(root, 'urlcode.yaml'), stringify({ version: '1', ...settings, routes: { '/a': { use: 'skills', ...copy(redirectRoute) }, '/b': { use: 'skills', ...copy(redirectRoute) } } }));
  const after = await approveBindings(root);
  assert.deepEqual(after.routes, { '/a': { env: ['MCP_ENABLED_SKILLS'], secrets: ['api_key'] }, '/b': { env: ['MCP_ENABLED_SKILLS'], secrets: ['api_key'] } });
  assert.notEqual(after.projectSha256, before.projectSha256);
  // The old pin is refused and names the revision; nothing about the grant became project-wide.
  await assert.rejects(createRuntime(root, { environment, permissions: before }), (error: Error) => /denied by operator policy/.test(error.message) && error.message.includes(before.projectSha256.slice(0, 12)));
  // A policy for the new revision that grants only /a still refuses /b: grants stay per route.
  await assert.rejects(createRuntime(root, { environment, permissions: { ...after, routes: { '/a': after.routes['/a']! } } }), /binding denied by operator policy: (SKILLS reads MCP_ENABLED_SKILLS|KEY reads api_key)/);
  await (await startServer({ project: root, port: 0, log: () => {}, environment, permissions: after })).close();
});
test('inline and inherited bindings resolve to the same route, revision and requested grants', async t => {
  const inline = await project(t, { '/a': { ...copy(redirectRoute), ...copy(bindingBlocks.skills) } });
  const via = await project(t, { '/a': { use: 'skills', ...copy(redirectRoute) } }, {}, { shared: copy(bindingBlocks) });
  assert.equal((await loadDocument(inline)).version, (await loadDocument(via)).version);
  assert.deepEqual((await approveBindings(inline)).routes, (await approveBindings(via)).routes);
});
test('explain shows inherited bindings by name and never their values', async t => {
  const root = await project(t, { '/a': { use: 'skills', ...copy(redirectRoute) } }, { '.env.local': 'MCP_ENABLED_SKILLS=leaked-value\napi_key=leaked-secret\n' }, { shared: copy(bindingBlocks) });
  const hit = await explainRoute(root, '/a'); assert.ok(hit.matched);
  assert.deepEqual(hit.bindings, { env: { SKILLS: { env: 'MCP_ENABLED_SKILLS' }, REGION: { literal: true } }, secrets: { KEY: { secret: 'api_key' } } });
  assert.equal(JSON.stringify(hit).includes('leaked'), false);
  assert.equal(JSON.stringify(hit).includes('eu-west-1'), false);
});
test('the published shared-bindings example passes its fixtures and requests its grant per route', async () => {
  const root = fileURLToPath(new URL('../examples/shared-bindings', import.meta.url));
  assert.deepEqual(await runProjectTests(root, {}), { total: 4, failed: 0 });
  const routes = { env: ['MCP_ENABLED_SKILLS'], secrets: [] };
  assert.deepEqual((await approveBindings(root)).routes, { '/skills': routes, '/skills/{name}': routes, '/status': routes });
});
test('a sandbox route receives inherited bindings exactly as declared ones, under the same grants', async t => {
  const fn = 'export default (_request, context) => Response.json({env: context.env, secretKeys: Object.keys(context.secrets), secretLength: context.secrets.KEY.length});';
  const root = await project(t, {
    '/inherited': { sandbox: true, use: 'skills', function: { source: 'f.mjs' } },
    '/inline': { sandbox: true, function: { source: 'f.mjs' }, ...copy(bindingBlocks.skills) },
  }, { 'f.mjs': fn }, { shared: copy(bindingBlocks) });
  const environment = { MCP_ENABLED_SKILLS: 'alpha,beta', api_key: 'TEST_SECRET' };
  await assert.rejects(createRuntime(root, { environment }), /denied by operator policy/);
  const permissions = await approveBindings(root);
  assert.deepEqual(permissions.routes['/inherited'], permissions.routes['/inline']);
  const server = await startServer({ project: root, port: 0, log: () => {}, environment, permissions, workers: 1 });
  t.after(() => server.close());
  const inherited = await request(server, '/inherited'), inline = await request(server, '/inline');
  assert.equal(inherited.status, 200);
  assert.deepEqual(JSON.parse(inherited.body), { env: { SKILLS: 'alpha,beta', REGION: 'eu-west-1' }, secretKeys: ['KEY'], secretLength: 11 });
  assert.equal(inherited.body, inline.body);
});
