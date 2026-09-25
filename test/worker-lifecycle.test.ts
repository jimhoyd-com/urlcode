import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { Worker } from 'node:worker_threads';
import { loadDocument } from '../packages/core/src/config.ts';
import { FunctionPool } from '../packages/core/src/functions.ts';
import type { FunctionRoute } from '../packages/core/src/function-sources.ts';
import { project, redirect } from './helpers.ts';

// #708: V8 can abort (`Check failed: !is_null()` in Builtin_CallAsyncModuleFulfilled) when a worker is terminated
// while its top-level-await module evaluation is still settling. These stress loops pin the lifecycle that avoids
// that race: configuration workers exit by themselves after posting, and close() never terminates a sandbox worker
// still in startup. They cannot prove the V8 crash is gone; they prove the teardown order and that nothing leaks.

interface Tracked { worker: Worker; exit: Promise<number>; code?: number }
/** Records every worker thread this process creates while `run` executes, via Node's `worker_threads` channel. */
async function trackWorkers<T>(run: (created: Tracked[]) => Promise<T>): Promise<{ result: T; created: Tracked[] }> {
  const created: Tracked[] = [];
  const onWorker = (message: unknown): void => {
    const worker = (message as { worker: Worker }).worker;
    const entry: Tracked = { worker, exit: new Promise(resolve => worker.once('exit', code => { entry.code = code; resolve(code); })) };
    created.push(entry);
  };
  subscribe('worker_threads', onWorker);
  try { return { result: await run(created), created }; } finally { unsubscribe('worker_threads', onWorker); }
}

test('repeated configuration loads let every worker exit by itself and leak none', async t => {
  const root = await project(t, { '/a': redirect(), '/b': redirect() });
  const { created } = await trackWorkers(async () => {
    for (let i = 0; i < 12; i++) assert.equal(Object.keys((await loadDocument(root)).routes).length, 2);
    // Two at a time is the load capacity; pairs exercise concurrent spawns and exits.
    for (let i = 0; i < 6; i++) await Promise.all([loadDocument(root), loadDocument(root, { sources: true })]);
  });
  assert.equal(created.length, 24);
  // loadDocument resolves only after 'exit', so every code is already recorded; 0 is a natural exit, whereas
  // terminate() reports 1.
  assert.deepEqual(created.map(entry => entry.code), created.map(() => 0));
  // A configuration error is a posted result too: the worker still exits by itself and the capacity slot frees.
  const broken = await project(t, { '/a': redirect() }, { 'urlcode.yaml': 'version: "1"\nroutes: {}\nunknown: 1\n' });
  const failed = await trackWorkers(async () => {
    for (let i = 0; i < 3; i++) await assert.rejects(loadDocument(broken), /Invalid configuration|unknown/i);
  });
  assert.deepEqual(failed.created.map(entry => entry.code), [0, 0, 0]);
  assert.equal(Object.keys((await loadDocument(root)).routes).length, 2);
});

const ROOT = '/project';
const modules = { '/f.mjs': 'export default () => new Response("x")' };
const routes: FunctionRoute[] = [{ function: { source: ROOT + '/f.mjs', export: 'default' }, middleware: [] }];
const snapshot = () => ({ sources: modules, dependencies: { '/f.mjs': [] }, entries: [['/f.mjs', 'default']] as [string, string][], names: new Map([[ROOT + '/f.mjs', '/f.mjs']]) });

test('closing sandbox pools with spawns in flight waits for startup and leaks no worker', async () => {
  const { created } = await trackWorkers(async () => {
    for (let i = 0; i < 6; i++) {
      const events: Record<string, unknown>[] = [];
      const pool = new FunctionPool(routes, { snapshot: snapshot(), workers: 2, log: event => { events.push(event); } });
      const started = pool.start(); // with a prepared snapshot, both spawns begin synchronously
      assert.equal(pool.slots.filter(slot => slot && !slot.ready).length, 2);
      await pool.close();
      // close() let both workers finish startup (each reported 'started') before terminating them.
      assert.equal(events.filter(event => event['status'] === 'started').length, 2);
      await started;
      assert.equal(pool.closed, true);
    }
  });
  assert.equal(created.length, 12);
  assert.equal((await Promise.all(created.map(entry => entry.exit))).length, 12);
});

test('closing a pool while a replacement worker is starting waits for it', async () => {
  const events: Record<string, unknown>[] = [];
  const pool = await new FunctionPool(routes, { snapshot: snapshot(), workers: 1, log: event => { events.push(event); } }).start();
  const { created } = await trackWorkers(async () => {
    // Close on the very turn the replacement is spawned, so it is certainly still inside startup.
    const closed = new Promise<void>((resolve, reject) => {
      const onWorker = (): void => { unsubscribe('worker_threads', onWorker); queueMicrotask(() => { pool.close().then(resolve, reject); }); };
      subscribe('worker_threads', onWorker);
    });
    await pool.slots[0]?.worker.terminate(); // schedules a replacement after the 250 ms backoff
    await closed;
  });
  assert.equal(created.length, 1);
  assert.equal(events.filter(event => event['status'] === 'started').length, 2);
  await Promise.all(created.map(entry => entry.exit));
  assert.equal(pool.healthy, false);
});
