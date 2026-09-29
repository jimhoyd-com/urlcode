// jimhoyd-com/urlcode#930: `expectJson` asserts some values of a JSON body by JSON Pointer, and a failing step prints
// the request as sent, with captured values filled in, except the secret ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { project } from './helpers.ts';
import { runProjectTests, startRestartable } from '../packages/core/src/project-tests.ts';
import { auditProject, readFixtures } from '../packages/core/src/readiness.ts';

const account = { id: 'acct-7f3a', balance: 100, owner: { name: 'Ada', tags: ['a', 'b'] }, 'a/b': 1, 'm~n': 2, createdAt: '2026-09-29T00:00:00.000Z' };
const routes = {
  '/account': { methods: ['GET'], respond: { json: account } },
  '/probe/{id}/{balance}': { methods: ['GET'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', maxLength: 32 } }, { name: 'balance', in: 'path', required: true, schema: { type: 'string', maxLength: 32 } }],
    sandboxReason: 'test', function: { source: 'probe.mjs' } },
  '/text': { methods: ['GET'], respond: { text: 'not json' } },
};
const files = { 'probe.mjs': 'export default () => Response.json({ probed: true })' };
async function run(t: TestContext, fixtures: unknown[]) {
  const root = await project(t, routes, { ...files, 'tests/requests.json': JSON.stringify(fixtures) });
  const events: Record<string, unknown>[] = [];
  const result = await runProjectTests(root, { log: event => events.push(event as Record<string, unknown>) });
  return { root, result, failed: events.filter(event => event.event === 'test' && event.pass === false) };
}

test('expectJson matches JSON Pointers by value and ignores everything it does not name', async t => {
  const { result, failed } = await run(t, [
    { path: '/account', status: 200, expectJson: { '/balance': 100, '/owner': { tags: ['a', 'b'], name: 'Ada' }, '/owner/tags/1': 'b', '/a~1b': 1, '/m~0n': 2 } },
    { path: '/account', status: 200, expectJson: { '': account } },
  ]);
  assert.deepEqual(result, { total: 2, failed: 0 }, JSON.stringify(failed));
});

test('an expectJson mismatch names the pointer, the expected and the actual value', async t => {
  const { result, failed } = await run(t, [
    { path: '/account', status: 200, expectJson: { '/balance': 99, '/missing': null, '/owner/tags': ['b', 'a'] } },
    { path: '/text', status: 200, expectJson: { '/x': 1 } },
  ]);
  assert.deepEqual(result, { total: 2, failed: 2 });
  assert.deepEqual(failed[0]!.failures, [
    { check: 'json', name: '/balance', expected: '99', actual: '100', firstDifference: 0 },
    { check: 'json', name: '/missing', expected: 'null', actual: null },
    { check: 'json', name: '/owner/tags', expected: '["b","a"]', actual: '["a","b"]', firstDifference: 2 },
  ]);
  assert.deepEqual(failed[1]!.failures, [{ check: 'json', name: '/x', expected: '1', actual: 'the response body is not JSON (or is over 1 MiB)', firstDifference: 0 }]);
});

test('a whole {{name}} reference in expectJson stands for the number a json capture kept', async t => {
  const { result, failed } = await run(t, [{ steps: [
    { path: '/account', status: 200, capture: { bal: { json: 'balance' }, id: { json: 'id' } } },
    { path: '/account', status: 200, expectJson: { '/balance': '{{bal}}', '/id': '{{id}}', '/owner/name': 'Ada' } },
  ] }]);
  assert.deepEqual(result, { total: 2, failed: 0 }, JSON.stringify(failed));
});

test('a failing step prints the path as sent, with captured values filled in, and the path as written', async t => {
  const { failed } = await run(t, [{ steps: [
    { path: '/account', status: 200, capture: { bal: { json: 'balance' }, id: { json: 'id' } } },
    { path: '/probe/{{id}}/{{bal}}', status: 201, expectJson: { '/probed': '{{id}}' } },
  ] }]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.path, '/probe/acct-7f3a/100');
  assert.equal(failed[0]!.fixturePath, '/probe/{{id}}/{{bal}}');
  assert.deepEqual((failed[0]!.failures as { check: string; expected: unknown }[]).map(failure => [failure.check, failure.expected]), [['status', 201], ['json', '"acct-7f3a"']]);
});

test('a secret capture stays {{name}} in the printed path and in every assertion', async t => {
  const { failed } = await run(t, [{ steps: [
    { path: '/account', status: 200, capture: { id: { json: 'id', secret: true }, bal: { json: 'balance' } } },
    { path: '/probe/{{id}}/{{bal}}', status: 200, expectJson: { '/probed': '{{id}}' } },
  ] }]);
  assert.equal(failed[0]!.path, '/probe/{{id}}/100');
  assert.doesNotMatch(JSON.stringify(failed), /acct-7f3a/);
});

test('expectJson covers a route in the audit, and bad pointers or secret flags are refused when read', async t => {
  const root = await project(t, routes, { ...files, 'tests/requests.json': JSON.stringify([
    { path: '/account', status: 200, expectJson: { '/balance': 100 } },
    { path: '/probe/a/1', status: 200, expectJson: { '/probed': true } },
    { path: '/text', status: 200, expectBody: 'not json' },
  ]) });
  const app = await startRestartable({ project: root, port: 0, local: true, log: () => {} });
  t.after(() => app.close());
  const report = await auditProject(app);
  assert.deepEqual([report.failed, report.unassertedCases, report.uncovered], [0, [], []], JSON.stringify(report));
  for (const [fixtures, message] of [
    [[{ path: '/account', status: 200, expectJson: { balance: 100 } }], /is not a JSON Pointer/],
    [[{ path: '/account', status: 200, expectJson: { '/a~2': 1 } }], /is not a JSON Pointer/],
    [[{ path: '/account', status: 200, expectJson: {} }], /expectJson must map 1-16/],
    [[{ steps: [{ path: '/account', status: 200, capture: { c: { cookie: 'sid', secret: true } } }] }], /a cookie value is always secret/],
    [[{ steps: [{ path: '/account', status: 200, capture: { c: { json: 'id', secret: false } } }] }], /may add secret: true/],
  ] as const) {
    const bad = await project(t, routes, { ...files, 'tests/requests.json': JSON.stringify(fixtures) });
    await assert.rejects(readFixtures(bad), message);
  }
});
