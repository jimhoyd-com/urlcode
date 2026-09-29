import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Agent } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignalRecorder, unmetSignals } from '../packages/core/src/signal-recorder.ts';
import { SignalBroker } from '../packages/core/src/signals.ts';
import { startServer } from '../packages/core/src/server.ts';
import { readFixtures, runFixtures } from '../packages/core/src/readiness.ts';
import { runProjectTests } from '../packages/core/src/project-tests.ts';
import type { EgressDependencies } from '../packages/core/src/egress.ts';
import { project, request, approveBindings } from './helpers.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
const signalRoutes = {
  '/contact': { methods: ['POST'], respond: { status: 202, json: { accepted: true } }, signals: [{ url: 'https://hooks.example.com/contact?token=synthetic-secret' }, { url: 'https://audit.example.com/in' }] },
  '/quiet': { respond: { text: 'quiet' } },
};
/** An egress transport that counts every DNS lookup and request it is asked for. */
function spy(): { calls: number; dependencies: EgressDependencies } {
  const counter = { calls: 0 } as { calls: number; dependencies: EgressDependencies };
  counter.dependencies = {
    resolve: async () => { counter.calls++; return [{ address: '8.8.8.8', family: 4 }]; },
    request: (() => { counter.calls++; throw new Error('network attempted'); }) as unknown as typeof import('node:https').request,
  };
  return counter;
}

test('the recorder keeps the destination origin and the fixed payload, never the URL path, query or headers', () => {
  const lines: string[] = [];
  const recorder = new SignalRecorder({ write: line => { lines.push(line); } });
  const record = recorder.record('https://hooks.example.com/contact?token=synthetic-secret', { route: '/contact', status: 202, method: 'POST' });
  assert.deepEqual(record, { event: 'signal', outcome: 'captured', destination: 'https://hooks.example.com', payload: { version: 1, route: '/contact', status: 202, method: 'POST' } });
  assert.equal(lines.length, 1); assert.ok(!lines[0]!.includes('synthetic-secret')); assert.deepEqual(JSON.parse(lines[0]!), record);
  assert.deepEqual(recorder.take(), [record]); assert.deepEqual(recorder.take(), []);
});

test('expectSignals entries count matches exactly with count, at least one without, and [] expects none', () => {
  const recorder = new SignalRecorder();
  recorder.record('https://a.example/x', { route: '/r', status: 202, method: 'POST' });
  recorder.record('https://a.example/y', { route: '/r', status: 202, method: 'POST' });
  recorder.record('https://b.example/z', { route: '/r', status: 202, method: 'POST' });
  const records = recorder.take();
  assert.deepEqual(unmetSignals([{ destination: 'https://a.example', count: 2 }, { destination: 'https://b.example' }, { match: { '/status': 202, '/method': 'POST' }, count: 3 }], records), []);
  assert.deepEqual(unmetSignals([{ destination: 'https://a.example', count: 1 }], records).map(item => item.matched), [2]);
  assert.deepEqual(unmetSignals([{ match: { '/status': '202' } }], records).map(item => item.matched), [0], 'values compare exactly, so a string never equals a number');
  assert.deepEqual(unmetSignals([{ destination: 'https://c.example', count: 0 }], records), []);
  assert.equal(unmetSignals([], records).length, 1); assert.deepEqual(unmetSignals([], []), []);
});

test('a broker given a recorder captures synchronously and never calls its transport', async () => {
  let calls = 0; const recorder = new SignalRecorder();
  const broker = new SignalBroker({ request: async () => { calls++; return { status: 204, headers: {}, body: Buffer.alloc(0) }; } }, 1, undefined, recorder);
  assert.equal(broker.emit({ url: 'https://example.com/hook' }, { route: '/x', status: 200, method: 'GET' }), true);
  assert.equal(broker.emit({ url: 'https://example.com/hook' }, { route: '/x', status: 200, method: 'GET' }), true, 'captures are not bounded by delivery concurrency');
  assert.equal(recorder.take().length, 2); await broker.close();
  assert.equal(calls, 0); assert.deepEqual(broker.stats, { accepted: 2, delivered: 0, failed: 0, dropped: 0, captured: 2 });
});

test('fixture expectSignals pass and fail against captured signals, with no network attempted', async t => {
  const fixtures = [
    { path: '/contact', method: 'POST', status: 202, expectSignals: [{ destination: 'https://hooks.example.com', count: 1, match: { '/route': '/contact', '/status': 202, '/method': 'POST' } }, { destination: 'https://audit.example.com' }] },
    { path: '/quiet', status: 200, expectSignals: [] },
    { path: '/contact', method: 'POST', status: 202, expectSignals: [{ destination: 'https://hooks.example.com', count: 2 }] },
    { path: '/contact', method: 'POST', status: 202, expectSignals: [] },
    { steps: [{ path: '/contact', method: 'POST', status: 202, expectSignals: [{ match: { '/status': 500 } }] }, { path: '/quiet', status: 200 }] },
  ];
  const root = await project(t, signalRoutes, { 'tests/requests.json': JSON.stringify(fixtures) });
  const network = spy(), signals = new SignalRecorder();
  const app = await startServer({ project: root, port: 0, local: true, log: () => {}, permissions: await approveBindings(root), egressDependencies: network.dependencies, signalRecorder: signals });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => { agent.destroy(); await app.close(); });
  const results: { pass: boolean; error?: string | undefined; failures?: unknown }[] = [];
  await runFixtures(await readFixtures(root), { app, agent, signals }, step => { results.push({ pass: step.result.pass, error: step.result.error, failures: step.result.mismatches }); });
  assert.deepEqual(results.map(result => result.pass), [true, true, false, false, false, false]);
  assert.deepEqual(results[2]!.failures, [{ check: 'signals', name: 'expectSignals.0', expected: '{"destination":"https://hooks.example.com","count":2}',
    actual: '1 matched; captured: POST /contact 202 to https://hooks.example.com; POST /contact 202 to https://audit.example.com' }]);
  assert.equal((results[3]!.failures as { name: string; expected: string }[])[0]!.expected, 'no signal');
  assert.equal(results[5]!.error, 'skipped', 'a step after a failed signal assertion is not sent');
  assert.ok(!JSON.stringify(results).includes('synthetic-secret'), 'a failure never prints the destination path or query');
  // Without a recorder (a deployment), expectSignals is not checked.
  const plain = await runFixtures([{ path: '/quiet', status: 200, expectSignals: [{ count: 5 }] }], { app, agent }, step => { assert.equal(step.result.pass, true); });
  assert.equal(plain, undefined);
  assert.equal(network.calls, 0);
  assert.equal(app.metrics().signals.captured, 8);
  assert.equal(app.metrics().signals.delivered, 0);
});

test('urlcode test records signals instead of delivering them and reports a failed expectSignals', async t => {
  const pass = [{ path: '/contact', method: 'POST', status: 202, expectBody: '{"accepted":true}', expectSignals: [{ destination: 'https://audit.example.com', count: 1 }] }];
  const root = await project(t, signalRoutes, { 'tests/requests.json': JSON.stringify(pass) });
  const permissions = await approveBindings(root), events: Record<string, unknown>[] = [];
  assert.deepEqual(await runProjectTests(root, { permissions, log: event => { events.push(event as Record<string, unknown>); } }), { total: 1, failed: 0 });
  assert.ok(events.some(event => event.event === 'signal' && event.outcome === 'captured' && event.count === 1));
  assert.ok(!events.some(event => event.event === 'signal' && ['delivered', 'failed'].includes(String(event.outcome))), 'nothing was delivered or attempted');
  await writeFile(join(root, 'tests/requests.json'), JSON.stringify([{ ...pass[0], expectSignals: [{ destination: 'https://audit.example.com', count: 3 }] }]));
  assert.deepEqual(await runProjectTests(root, { permissions: await approveBindings(root), log: () => {} }), { total: 1, failed: 1 });
});

test('expectSignals has a bounded shape', async t => {
  for (const [bad, message] of [
    [[{ event: 'contact' }], /unknown key "event"/],
    [[{ count: -1 }], /must be >= 0/],
    [[{ destination: 'https://hooks.example.com/path' }], /must match pattern/],
    [[{ match: { status: 202 } }], /must match pattern|property name/],
    [Array.from({ length: 9 }, () => ({})), /must NOT have more than 8 items/],
  ] as const) {
    const root = await project(t, signalRoutes, { 'tests/requests.json': JSON.stringify([{ path: '/quiet', status: 200, expectSignals: bad }]) });
    await assert.rejects(readFixtures(root), message);
  }
});

test('dev --signal-sink writes captured deliveries as JSON lines; serve and other commands refuse the flag', async t => {
  const root = await project(t, signalRoutes);
  const operator = await mkdtemp(join(tmpdir(), 'urlcode-operator-')); t.after(() => rm(operator, { recursive: true, force: true }));
  const policy = join(operator, 'policy.json'), sink = join(operator, 'signals.jsonl');
  await writeFile(policy, JSON.stringify(await approveBindings(root)));
  for (const args of [['serve', '--signal-sink', 'stdout'], ['test', '--signal-sink', sink], ['dev', '--signal-sink', join(root, 'signals.jsonl')], ['dev', '--signal-sink', join(operator, 'signals.txt')], ['dev', '--signal-sink', join(operator, 'missing', 'signals.jsonl')]]) {
    const refused = spawnSync(process.execPath, [cli, ...args, '--project', root, '--policy', policy, '--port', '0'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(refused.status, 1, args.join(' '));
    assert.match(JSON.parse(refused.stderr).message, /--signal-sink/);
  }
  const child = spawn(process.execPath, [cli, 'dev', '--project', root, '--policy', policy, '--port', '0', '--json', '--signal-sink', sink], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const port = await new Promise<number>((resolve, reject) => {
    let out = ''; child.stdout.on('data', chunk => { out += chunk; const line = out.split('\n').find(item => item.includes('"listening"')); if (line) resolve(Number(JSON.parse(line).port)); });
    child.on('close', status => reject(new Error(`dev exited ${status}`)));
  });
  assert.equal((await request({ address: { port } }, '/contact', { method: 'POST' })).status, 202);
  assert.equal((await request({ address: { port } }, '/contact', { method: 'HEAD' })).status, 405);
  const lines = (await readFile(sink, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown);
  assert.deepEqual(lines, [
    { event: 'signal', outcome: 'captured', destination: 'https://hooks.example.com', payload: { version: 1, route: '/contact', status: 202, method: 'POST' } },
    { event: 'signal', outcome: 'captured', destination: 'https://audit.example.com', payload: { version: 1, route: '/contact', status: 202, method: 'POST' } },
  ]);
  await new Promise<void>(resolve => { child.once('close', () => resolve()); child.kill('SIGTERM'); });
});
