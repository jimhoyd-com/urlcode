// A store activated directly (no HTTP server) for the #835 transition and retry proofs: requests are built by hand
// with the principal and network client a route policy would have set, and handed to the activation's handle().
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { ExtensionActivation, ExtensionRequest, HandlerResult } from '@jimhoyd/urlcode/extensions';
import { createStore } from '../src/index.ts';
import { cleanup } from './cleanup.ts';

export const origin = 'https://direct.example.test', pin = 'a'.repeat(64);
export interface Call { who?: string | null; body?: unknown; headers?: Record<string, string>; client?: string; raw?: string }
export interface Answer { status: number; body: Record<string, unknown> | undefined; header(name: string): string | undefined }

/** A request as core would hand it to the store's mount: `mount` is the longest declared mount the path is under. */
export function requestFor(mounts: readonly string[], method: string, target: string, init: Call = {}): ExtensionRequest {
  const split = target.indexOf('?'), path = split < 0 ? target : target.slice(0, split), query = new URLSearchParams(split < 0 ? '' : target.slice(split + 1));
  const mount = [...mounts].sort((a, b) => b.length - a.length).find(candidate => path === candidate || path.startsWith(`${candidate}/`)) ?? null;
  const text = init.raw ?? (init.body === undefined ? '' : JSON.stringify(init.body));
  const headers = new Headers({ ...(text ? { 'content-type': 'application/json' } : {}), ...init.headers });
  const headerCounts = Object.fromEntries([...headers.keys()].map(name => [name, 1]));
  const principal = init.who ? Object.freeze({ id: init.who, provider: 'badge' }) : null;
  return { method, target, path, query, headers, headerCounts, body: new TextEncoder().encode(text), origin, route: `${mount}/*`, mount, client: init.client ?? '203.0.113.9', requestId: 'direct', env: {}, principal };
}
export function answer(result: HandlerResult): Answer {
  const text = typeof result.body === 'string' ? result.body : result.body === undefined ? '' : new TextDecoder().decode(result.body as Uint8Array);
  return { status: result.status, body: text ? JSON.parse(text) as Record<string, unknown> : undefined, header: name => result.headers.find(([key]) => key.toLowerCase() === name)?.[1] };
}

/**
 * A temporary root and a store over `root/data/store.sqlite`, activated with `config`. `open()` activates it (again
 * after `close()`), so a test can restart it over the same database; `open(next)` activates it with the declaration
 * `next` instead, the way an operator redeploys a changed project. Every handle is closed by the test's cleanup
 * before the directory is removed.
 */
export async function direct(t: TestContext, config: Record<string, unknown>, options: { mounts: string[]; principalMounts?: string[] }) {
  const root = await mkdtemp(join(tmpdir(), 'store-direct-'));
  cleanup(t, () => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(join(root, 'app'));
  const database = join(root, 'data', 'store.sqlite');
  const activation: ExtensionActivation = { origin, target: 'node', projectSha256: pin, mounts: options.mounts, principalMounts: options.principalMounts ?? options.mounts, root: join(root, 'app') };
  let running: { store: ReturnType<typeof createStore>; instance: Awaited<ReturnType<ReturnType<typeof createStore>['registration']['activate']>> } | undefined;
  const close = async () => { const current = running; running = undefined; if (current) { await current.instance.close?.(); await current.store.close(); } };
  cleanup(t, close);
  const open = async (next: Record<string, unknown> = config) => {
    await close();
    const store = createStore({ database, projectSha256: pin });
    try { running = { store, instance: await store.registration.activate(next, activation) }; } catch (error) { await store.close(); throw error; }
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
 * Races request lists, each racer with its own store registration over `database` (its own SQLite connection; they
 * share this process's server lock, since one process serves a database): every racer activates first, then all run
 * at once, their requests interleaved on the event loop. Returns each racer's answers in order. Every registration is
 * closed by the test's cleanup before the directory goes.
 */
export async function race(t: TestContext, database: string, config: Record<string, unknown>, activation: ExtensionActivation, racers: { method: string; path: string; init?: Call }[][]): Promise<{ status: number; replayed: string | null; body: Record<string, unknown> | undefined }[][]> {
  const opened: { store: ReturnType<typeof createStore>; instance: Awaited<ReturnType<ReturnType<typeof createStore>['registration']['activate']>> }[] = [];
  for (let index = 0; index < racers.length; index++) {
    const store = createStore({ database, projectSha256: activation.projectSha256 });
    const instance = await store.registration.activate(config, activation);
    cleanup(t, async () => { await instance.close?.(); await store.close(); });
    opened.push({ store, instance });
  }
  return Promise.all(racers.map(async (requests, index) => {
    const { store, instance } = opened[index]!;
    const results: { status: number; replayed: string | null; body: Record<string, unknown> | undefined }[] = [];
    for (const request of requests) {
      await new Promise(resolve => setImmediate(resolve));
      const init = request.init ?? {};
      if (request.method === 'TRANSACTION') {
        // A host transaction (#902) instead of a request: `path` names the collection, the body the record and the key.
        const { values, key, fingerprint } = init.body as { values: Record<string, string | number | boolean>; key: string; fingerprint?: string };
        const principal = init.who ? { id: init.who } : null;
        let ran = false;
        try {
          const id = store.exports.transaction(tx => { ran = true; return tx.records(request.path).create(principal, values).record.id; }, { idempotencyKey: key, ...(fingerprint === undefined ? {} : { fingerprint }) });
          results.push({ status: 200, replayed: ran ? null : 'true', body: { id } });
        } catch (error) { results.push({ status: (error as { status?: number }).status ?? 500, replayed: null, body: { error: { code: (error as { code?: string }).code } } }); }
        continue;
      }
      const result = answer(await instance.handle!(requestFor(activation.mounts, request.method, request.path, init)));
      results.push({ status: result.status, replayed: result.header('idempotency-replayed') ?? null, body: result.body });
    }
    return results;
  }));
}
