// One racer for the cross-connection proofs: its own thread, its own store activation and so its own SQLite
// connection to the shared database, exactly as a second process would have. It activates, reports ready, blocks
// until the test releases every racer at once, sends its requests and posts the answers back.
import { parentPort, workerData } from 'node:worker_threads';
import type { ExtensionActivation } from '@jimhoyd/urlcode/extensions';
import { createStore } from '../src/index.ts';
import { answer, requestFor } from './direct.ts';
import type { Call } from './direct.ts';

const { database, config, activation, requests, gate } = workerData as { database: string; config: Record<string, unknown>; activation: ExtensionActivation; requests: { method: string; path: string; init: Call }[]; gate: SharedArrayBuffer };
const store = createStore({ database, projectSha256: activation.projectSha256 });
const instance = await store.registration.activate(config, activation);
const flag = new Int32Array(gate);
Atomics.add(flag, 1, 1);
Atomics.wait(flag, 0, 0);
const results: { status: number; replayed: string | null; body: unknown }[] = [];
try {
  for (const request of requests) {
    const result = answer(await instance.handle!(requestFor(activation.mounts, request.method, request.path, request.init)));
    results.push({ status: result.status, replayed: result.header('idempotency-replayed') ?? null, body: result.body });
  }
} finally { await instance.close?.(); await store.close(); }
parentPort!.postMessage(results);
