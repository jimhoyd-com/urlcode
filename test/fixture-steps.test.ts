import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { project, request } from './helpers.ts';
import { startServer } from '../src/server.ts';
import { runProjectTests } from '../src/project-tests.ts';
import { readFixtures } from '../src/readiness.ts';
import { auditProject } from '../src/readiness.ts';
import { startRestartable } from '../src/project-tests.ts';
import { verifyDeployment } from '../src/verify-deployment.ts';

const example = fileURLToPath(new URL('../examples/lifecycle/', import.meta.url));
const json = { 'content-type': 'application/json' };

// A tiny stateful project: files under the data directory survive a restart, memory does not.
const routes = {
  '/items': { methods: ['POST'], sandboxReason: 'test', function: { source: 'items.mjs', export: 'create' }, env: { DIR: { env: 'URLCODE_DATA_DIR' } } },
  '/items/{id}': { methods: ['GET'], sandboxReason: 'test', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1, maxLength: 16 } }],
    function: { source: 'items.mjs', export: 'read', args: { id: { from: 'path', name: 'id' } } }, env: { DIR: { env: 'URLCODE_DATA_DIR' } } },
  '/secret': { respond: { text: 'top-secret-value' } },
  '/token': { respond: { json: { token: 'tok-SECRET-123' } } },
};
const files = {
  'items.mjs': `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
let memory = 0;
export async function create(req,{env}){const id='i'+(++memory)+Math.random().toString(16).slice(2,6);await writeFile(join(env.DIR,id),'stored');return new Response(JSON.stringify({id}),{status:201,headers:{'content-type':'application/json',location:'/items/'+id}});}
export async function read(req,{args,env}){try{return new Response(await readFile(join(env.DIR,args.id),'utf8'));}catch{return new Response('missing',{status:404});}}`,
};
async function withFixtures(t: TestContext, fixtures: unknown, extra: Record<string, string> = {}) {
  return project(t, routes, { ...files, ...extra, 'tests/requests.json': JSON.stringify(fixtures) });
}
// Deployment verification builds its own local runtime without a data directory, so its projects declare no env binding.
async function withoutBindings(t: TestContext, fixtures: unknown) {
  const { '/secret': secret, '/token': token } = routes;
  return project(t, { '/secret': secret, '/token': token }, { 'tests/requests.json': JSON.stringify(fixtures) });
}
const create = { path: '/items', method: 'POST', headers: json, body: '{}', status: 201, capture: { id: { json: 'id' }, where: { header: 'location' } } };

test('captured values feed later steps and a restart keeps the data directory', async t => {
  const root = await withFixtures(t, [{ steps: [create, { path: '{{where}}', status: 200, expectBody: 'stored' }, { restart: true }, { path: '/items/{{id}}', status: 200, expectBody: 'stored' }] }, { path: '/items/nope', status: 404 }]);
  const events: object[] = [];
  const result = await runProjectTests(root, { log: e => events.push(e) });
  assert.deepEqual(result, { total: 4, failed: 0 });
});

test('a step after a failed step is reported failed and never sent', async t => {
  const root = await withFixtures(t, [{ steps: [{ ...create, status: 200 }, { path: '{{where}}', status: 200 }, { restart: true }, { path: '/items/x', status: 404 }] }]);
  const events: { event: string; pass?: boolean; status?: number }[] = [];
  const result = await runProjectTests(root, { log: e => events.push(e as never) });
  assert.deepEqual(result, { total: 3, failed: 3 });
  assert.deepEqual(events.filter(e => e.event === 'test').map(e => [e.pass, e.status]), [[false, 201], [false, 0], [false, 0]]);
});

test('a missing capture fails the step and names nothing from the response', async t => {
  const root = await withFixtures(t, [{ steps: [{ path: '/token', status: 200, capture: { t: { json: 'absent' } } }, { path: '/secret', status: 200 }] }]);
  const events: object[] = [];
  const result = await runProjectTests(root, { log: e => events.push(e) });
  assert.deepEqual(result, { total: 2, failed: 2 });
  assert.doesNotMatch(JSON.stringify(events), /tok-SECRET|top-secret/);
});

test('captured values never reach output, including the audit and deployment reports', async t => {
  const fixtures = [{ steps: [{ path: '/token', status: 200, capture: { tok: { json: 'token' } } }, { path: '/secret?x={{tok}}', status: 500, headers: { 'x-t': '{{tok}}' } }] }];
  const root = await withoutBindings(t, fixtures);
  const events: object[] = [];
  const result = await runProjectTests(root, { log: e => events.push(e) });
  assert.equal(result.failed, 1);
  const app = await startRestartable({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => app.close());
  const report = await auditProject(app, { log: e => events.push(e) });
  const target = await startServer({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => target.close());
  const verified = await verifyDeployment(root, { target: `http://127.0.0.1:${target.address.port}`, log: e => events.push(e) });
  const all = JSON.stringify([events, report, verified]);
  assert.doesNotMatch(all, /tok-SECRET/);
  assert.equal(report.failed, 1);
  assert.ok(verified.findings.some(f => f.check === 'fixtures' && f.message.includes('{{tok}}')), 'labels print the fixture as written');
});

test('audit counts every step as a check and covers routes by the substituted path', async t => {
  const root = await withFixtures(t, [{ steps: [{ ...create, expectHeaders: { 'content-type': 'application/json' } }, { path: '{{where}}', status: 200, expectBody: 'stored' }, { restart: true }, { path: '/items/{{id}}', status: 200, expectBody: 'stored' }] }]);
  const app = await startRestartable({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => app.close());
  const report = await auditProject(app);
  const generated = app.testPlan().cases.length;
  assert.equal(report.checks, generated + 3);
  assert.equal(report.failed, 0);
  assert.deepEqual(report.uncovered.map(u => `${u.method} ${u.route}`), []);
  assert.equal(report.ready, true);
});

test('audit refuses a restart step on an app that cannot restart, instead of skipping it', async t => {
  const root = await withoutBindings(t, [{ steps: [{ path: '/secret', status: 200 }, { restart: true }] }]);
  const app = await startServer({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => app.close());
  await assert.rejects(auditProject(app), /restart step/);
});

test('deployment verification skips a fixture with a restart step, explicitly, and runs the rest', async t => {
  const root = await withoutBindings(t, [
    { steps: [{ path: '/secret', status: 404 }, { restart: true }] },
    { steps: [{ path: '/token', status: 200, capture: { tok: { json: 'token' } } }, { path: '/secret', status: 200, expectBody: 'top-secret-value' }] },
  ]);
  const app = await startServer({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => app.close());
  const events: { event: string }[] = [];
  const report = await verifyDeployment(root, { target: `http://127.0.0.1:${app.address.port}`, log: e => events.push(e as never) });
  assert.equal(report.findings.filter(f => f.check === 'fixtures').length, 0);
  assert.equal(report.notes.filter(n => /^fixture 1 .*restart step.*not verified/.test(n)).length, 1);
  assert.equal(events.filter(e => e.event === 'skipped').length, 1);
  assert.equal(report.notes.filter(n => /^fixture 2 /.test(n)).length, 0);
});

test('fixture files are validated with bounds', async t => {
  const bad = async (fixtures: unknown, pattern: RegExp) => { const root = await withFixtures(t, fixtures); await assert.rejects(readFixtures(root), pattern); };
  const step = { path: '/secret', status: 200 };
  await bad([{ steps: [{ path: '/secret/{{nope}}', status: 200 }] }], /earlier step/);
  await bad([{ steps: [{ path: '/a/{{id}}', status: 200 }, { ...step, capture: { id: { json: 'id' } } }] }], /earlier step/);
  await bad([{ ...step, capture: { id: { json: 'id' } } }], /only valid inside steps/);
  await bad([{ steps: [] }], /steps/);
  await bad([{ steps: Array.from({ length: 51 }, () => step) }], /steps/);
  await bad([{ steps: [step], name: 'x' }], /only key/);
  await bad([{ steps: Array.from({ length: 6 }, () => ({ restart: true })) }], /restarts/);
  await bad([{ steps: [{ restart: true, extra: 1 }] }], /exactly/);
  await bad([{ steps: [{ ...step, capture: { 'bad name': { json: 'a' } } }] }], /Capture names/);
  await bad([{ steps: [{ ...step, capture: { a: { json: 'a', header: 'b' } } }] }], /exactly one/);
  await bad([{ steps: [{ ...step, capture: { a: { json: '__proto__..x' } } }] }], /json path/);
  await bad([{ steps: [{ path: '{{a}}', status: 200 }] }], /earlier step/);
  const ok = await withFixtures(t, [{ steps: [{ ...step, capture: { a: { header: 'location' } } }, { path: '{{a}}', status: 200 }] }]);
  assert.equal((await readFixtures(ok)).length, 1);
});

test('a captured value that would break the request line fails the step without sending it', async t => {
  const root = await withFixtures(t, [{ steps: [{ path: '/token', status: 200, capture: { bad: { header: 'x-missing' } } }, { path: '{{bad}}', status: 200 }] }]);
  const result = await runProjectTests(root);
  assert.deepEqual(result, { total: 2, failed: 2 });
});

test('startServer isolateData gives a fresh directory that close() removes; dataDir persists', async t => {
  const root = await project(t, routes, files);
  const first = await startServer({ project: root, port: 0, local: true, log: () => {}, isolateData: true });
  const created = await request(first, '/items', { method: 'POST', headers: json, body: '{}' });
  assert.equal(created.status, 201);
  const id = (JSON.parse(created.body) as { id: string }).id;
  assert.equal((await request(first, `/items/${id}`)).body, 'stored');
  await first.close();
  const second = await startServer({ project: root, port: 0, local: true, log: () => {}, isolateData: true });
  t.after(() => second.close());
  assert.equal((await request(second, `/items/${id}`)).status, 404);
  await assert.rejects(startServer({ project: root, port: 0, local: true, log: () => {}, isolateData: true, dataDir: '/tmp/x' }), /not both/);
});

test('startServer dataDir is never deleted and is shared across servers', async t => {
  const root = await project(t, routes, files);
  const dir = (await project(t, {}, {})) + '/data';
  const first = await startServer({ project: root, port: 0, local: true, log: () => {}, dataDir: dir });
  const id = (JSON.parse((await request(first, '/items', { method: 'POST', headers: json, body: '{}' })).body) as { id: string }).id;
  await first.close();
  assert.ok((await readdir(dir)).includes(id));
  const second = await startServer({ project: root, port: 0, local: true, log: () => {}, dataDir: dir });
  t.after(() => second.close());
  assert.equal((await request(second, `/items/${id}`)).body, 'stored');
});

test('the data directory grant covers only URLCODE_DATA_DIR', async t => {
  const other = { '/x': { sandboxReason: 'test', function: { source: 'items.mjs', export: 'read' }, env: { A: { env: 'AMBIENT' } } } };
  const root = await project(t, other, files);
  await assert.rejects(startServer({ project: root, port: 0, local: true, log: () => {}, isolateData: true, environment: { AMBIENT: 'v' } }), /denied by operator policy/);
});

test('the lifecycle example passes as written and its fixture uses every step feature', async () => {
  const result = await runProjectTests(example);
  assert.deepEqual(result, { total: 5, failed: 0 });
  const text = await readFile(example + 'tests/requests.json', 'utf8');
  for (const feature of ['"steps"', '"capture"', '"restart"', '{{id}}']) assert.ok(text.includes(feature), feature);
});
