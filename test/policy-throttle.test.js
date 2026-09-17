import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.js';
import { createRuntime } from '../src/runtime.js';
import * as throttle from '../src/policies/throttle.js';

import { project, redirect, request } from './helpers.js';

async function serve(t, root, options = {}) {
  const app = await startServer({ project: root, port: 0, log: () => {}, ...options }); t.after(() => app.close()); return app;
}

// A compiled state with a controllable clock, for tests that must not wait.
async function compiled(config, { route = '/a', shared = {} } = {}) {
  let now = 0;
  const clock = { shared: { now: () => now, ...shared }, tick(ms) { now += ms; } };
  clock.state = await throttle.compile(config, { route: { pattern: route }, shared: clock.shared });
  clock.hit = (client = '1.1.1.1', pattern = route) => throttle.onRequest(clock.state, { client, route: pattern });
  return clock;
}

test('quota reached answers 429 with Retry-After and RateLimit headers', async t => {
  const root = await project(t, { '/go': redirect() }, {}, { policies: { throttle: { quota: 2, window: 60 } } });
  const app = await serve(t, root);
  const first = await request(app, '/go');
  assert.equal(first.status, 302);
  assert.equal(first.headers['ratelimit-policy'], '"default";q=2;w=60');
  assert.match(first.headers['ratelimit'], /^"default";r=1;t=\d+$/);
  await request(app, '/go');
  const refused = await request(app, '/go');
  assert.equal(refused.status, 429);
  assert.equal(refused.body, 'Too many requests\n');
  assert.equal(refused.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(refused.headers['cache-control'], 'no-store');
  assert.match(refused.headers['retry-after'], /^[1-9]\d*$/);
  assert.ok(Number(refused.headers['retry-after']) <= 60);
  assert.match(refused.headers['ratelimit'], /^"default";r=0;t=\d+$/);
  assert.equal(refused.headers['ratelimit-policy'], '"default";q=2;w=60');
});

test('window slides: the previous window fades out instead of resetting at once', async t => {
  const clock = await compiled({ quota: 4, window: 10 });
  for (let i = 0; i < 4; i++) assert.equal(await clock.hit(), undefined);
  const refused = await clock.hit();
  assert.equal(refused.status, 429);
  assert.deepEqual(refused.headers.find(([n]) => n === 'retry-after'), ['retry-after', '10']);
  // Halfway through the next window the old four count as two.
  clock.tick(15000);
  assert.equal(await clock.hit(), undefined);
  assert.equal(await clock.hit(), undefined);
  assert.equal((await clock.hit()).status, 429);
  // Two windows later nothing lingers.
  clock.tick(20000);
  for (let i = 0; i < 4; i++) assert.equal(await clock.hit(), undefined);
  t.diagnostic('sliding window verified with a fake clock');
});

test('route partition pools clients; client partition separates them; client-route does both', async () => {
  const byRoute = await compiled({ quota: 2, window: 60, partition: 'route' });
  await byRoute.hit('1.1.1.1'); await byRoute.hit('2.2.2.2');
  assert.equal((await byRoute.hit('3.3.3.3')).status, 429);
  const byClient = await compiled({ quota: 1, window: 60, partition: 'client' });
  assert.equal(await byClient.hit('1.1.1.1'), undefined);
  assert.equal(await byClient.hit('2.2.2.2'), undefined);
  assert.equal((await byClient.hit('1.1.1.1')).status, 429);
  // Unresolved clients share one bucket rather than escaping the budget.
  assert.equal(await byClient.hit(null), undefined);
  assert.equal((await byClient.hit(null)).status, 429);
  assert.equal(throttle.describe(byClient.state).unresolvedClient, 'shared key');
  assert.equal(throttle.describe(byRoute.state).unresolvedClient, undefined);
  const both = await compiled({ quota: 1, window: 60, partition: 'client-route' });
  assert.equal(await both.hit('1.1.1.1', '/a'), undefined);
  assert.equal(await both.hit('1.1.1.1', '/b'), undefined);
  assert.equal((await both.hit('1.1.1.1', '/a')).status, 429);
});

test('report mode counts and logs but never refuses', async t => {
  const events = [];
  const root = await project(t, { '/go': redirect() }, {}, { policies: { throttle: { quota: 1, window: 60, mode: 'report' } } });
  const app = await serve(t, root, { log: e => events.push(e) });
  await request(app, '/go');
  const second = await request(app, '/go');
  assert.equal(second.status, 302);
  assert.match(second.headers['ratelimit'], /^"default";r=0;t=\d+$/);
  const seen = events.filter(e => e.event === 'throttle');
  assert.deepEqual(seen.map(e => e.outcome), ['allowed', 'exceeded']);
  assert.ok(seen.every(e => e.route === '/go' && !('client' in e)));
});

test('maxKeys bounds the table with LRU eviction', async () => {
  const clock = await compiled({ quota: 1, window: 60, maxKeys: 2 });
  await clock.hit('a'); await clock.hit('b');
  await clock.hit('a'); // a is now the most recent
  await clock.hit('c'); // evicts b
  assert.deepEqual([...clock.shared.throttle.keys.keys()].map(k => k.split('|').pop()), ['a', 'c']);
  assert.equal((await clock.hit('c')).status, 429, 'kept key remembers');
  assert.equal(await clock.hit('b'), undefined, 'evicted key starts fresh');
  await throttle.close(clock.shared);
  assert.equal(clock.shared.throttle, undefined);
});

test('status other than 429 gets a matching short body', async () => {
  const clock = await compiled({ quota: 1, window: 60, status: 503 });
  await clock.hit();
  const refused = await clock.hit();
  assert.equal(refused.status, 503);
  assert.equal(refused.body.toString(), 'Service unavailable\n');
});

test('profile merge: route quota overrides the project setting end to end', async t => {
  // The schema requires quota and window together on a route override.
  const root = await project(t, { '/loose': redirect(), '/tight': { ...redirect(), policies: { throttle: { quota: 1, window: 60 } } } }, {},
    { policies: { throttle: { quota: 5, window: 60 } } });
  const runtime = await createRuntime(root, { log: () => {} });
  t.after(() => runtime.close());
  const plan = runtime.testPlan();
  assert.equal(plan.policies['/tight'].throttle.quota, 1);
  assert.equal(plan.policies['/loose'].throttle.quota, 5);
  assert.equal(plan.policies['/tight'].throttle.target, 'native');
  const app = await serve(t, root);
  assert.equal((await request(app, '/loose')).headers['ratelimit-policy'], '"default";q=5;w=60');
  assert.equal((await request(app, '/tight')).status, 302);
  assert.equal((await request(app, '/tight')).status, 429);
  // The override has its own counter; the project budget only saw /loose.
  assert.equal((await request(app, '/loose')).headers['ratelimit'].split(';')[1], 'r=3');
});

test('client partition is refused on serverless targets, route partition is native', async t => {
  const root = await project(t, { '/go': { ...redirect(), policies: { throttle: { quota: 1, window: 1 } } } });
  await assert.rejects(createRuntime(root, { log: () => {}, target: 'vercel' }), /\/go declares policies\.throttle, which the vercel target cannot enforce/);
  const perRoute = await project(t, { '/go': { ...redirect(), policies: { throttle: { quota: 1, window: 1, partition: 'route' } } } });
  const runtime = await createRuntime(perRoute, { log: () => {}, target: 'aws' });
  t.after(() => runtime.close());
  assert.equal(runtime.testPlan().policies['/go'].throttle.target, 'native');
  assert.deepEqual(throttle.targets({ partition: 'client-route' }), { node: 'native', vercel: 'refused', aws: 'refused', cloudflare: 'refused' });
});
