// A store activated directly (no HTTP server) for the #835 transition and retry proofs: requests are built by hand
// with the principal and network client a route policy would have set, and handed to the activation's handle().
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ExtensionActivation, ExtensionRequest, HandlerResult } from '@jimhoyd/urlcode/extensions';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import { createStore } from '../src/index.ts';
import { cleanup } from './cleanup.ts';

export const origin = 'https://direct.example.test', pin = 'a'.repeat(64);
export interface Call { who?: string | null; body?: unknown; headers?: Record<string, string>; client?: string; raw?: string }
export interface Answer { status: number; body: Record<string, unknown> | undefined; header(name: string): string | undefined }

/** A request as core would hand it to the store's mount: `mount` is the longest declared mount the path is under. */
export function requestFor(mounts: readonly string[], method: string, path: string, init: Call = {}): ExtensionRequest {
  const mount = [...mounts].sort((a, b) => b.length - a.length).find(candidate => path === candidate || path.startsWith(`${candidate}/`)) ?? null;
  const text = init.raw ?? (init.body === undefined ? '' : JSON.stringify(init.body));
  const headers = new Headers({ ...(text ? { 'content-type': 'application/json' } : {}), ...init.headers });
  const headerCounts = Object.fromEntries([...headers.keys()].map(name => [name, 1]));
  const principal = init.who ? Object.freeze({ id: init.who, provider: 'badge' }) : null;
  return { method, target: path, path, query: new URLSearchParams(), headers, headerCounts, body: new TextEncoder().encode(text), origin, route: `${mount}/*`, mount, client: init.client ?? '203.0.113.9', requestId: 'direct', env: {}, principal };
}
export function answer(result: HandlerResult): Answer {
  const text = typeof result.body === 'string' ? result.body : result.body === undefined ? '' : new TextDecoder().decode(result.body as Uint8Array);
  return { status: result.status, body: text ? JSON.parse(text) as Record<string, unknown> : undefined, header: name => result.headers.find(([key]) => key.toLowerCase() === name)?.[1] };
}

/**
 * A temporary root and a store over `root/data/store.sqlite`, activated with `config`. `open()` activates it (again
 * after `close()`), so a test can restart it over the same database. Every handle is closed by the test's cleanup
 * before the directory is removed.
 */
export async function direct(t: TestContext, config: Record<string, unknown>, options: { mounts: string[]; principalMounts?: string[]; audit?: AuditExports }) {
  const root = await mkdtemp(join(tmpdir(), 'store-direct-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(root, 'app'));
  const database = join(root, 'data', 'store.sqlite');
  const activation: ExtensionActivation = { origin, target: 'node', projectSha256: pin, mounts: options.mounts, principalMounts: options.principalMounts ?? options.mounts, root: join(root, 'app') };
  let running: { store: ReturnType<typeof createStore>; instance: Awaited<ReturnType<ReturnType<typeof createStore>['registration']['activate']>> } | undefined;
  const close = async () => { const current = running; running = undefined; if (current) { await current.instance.close?.(); await current.store.close(); } };
  cleanup(t, close);
  const open = async () => {
    await close();
    const store = createStore({ database, projectSha256: pin, ...(options.audit ? { audit: options.audit } : {}) });
    running = { store, instance: await store.registration.activate(config, activation) };
    return running.store.exports;
  };
  const exports = await open();
  const call = async (method: string, path: string, init: Call = {}): Promise<Answer> => {
    if (!running) throw new Error('the store is closed');
    return answer(await running.instance.handle!(requestFor(options.mounts, method, path, init)));
  };
  return { root, database, activation, call, open, close, get exports() { if (!running) throw new Error('the store is closed'); return running.store.exports; }, first: exports };
}

/**
 * Races request lists from several threads, each with its own store activation over `database` (so its own SQLite
 * connection, as a second process would have): every racer activates first, then all are released at once. Returns
 * each racer's answers in order. Workers are terminated by the test's cleanup before the directory goes.
 */
export async function race(t: TestContext, database: string, config: Record<string, unknown>, activation: ExtensionActivation, racers: { method: string; path: string; init?: Call }[][]): Promise<{ status: number; replayed: string | null; body: Record<string, unknown> | undefined }[][]> {
  const { Worker } = await import('node:worker_threads');
  const gate = new SharedArrayBuffer(8), flag = new Int32Array(gate);
  let failed: unknown;
  const workers = racers.map(requests => new Worker(new URL('./race-worker.ts', import.meta.url), { workerData: { database, config, activation, requests: requests.map(request => ({ ...request, init: request.init ?? {} })), gate }, execArgv: ['--conditions=development'] }));
  cleanup(t, () => Promise.all(workers.map(worker => worker.terminate())));
  const answers = workers.map(worker => new Promise<{ status: number; replayed: string | null; body: Record<string, unknown> | undefined }[]>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', error => { failed = error; reject(error); });
  }));
  for (const pending of answers) pending.catch(() => undefined);
  while (Atomics.load(flag, 1) < workers.length) { if (failed) throw failed; await new Promise(resolve => setTimeout(resolve, 5)); }
  Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
  return Promise.all(answers);
}
