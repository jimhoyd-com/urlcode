// One serving process for the server lock proofs: a real `node` child, not a worker thread, so it has its own SQLite
// connection and takes the database's server lock as its own process. It activates the store with
// the declaration it was given, prints {"ready":true} (or {"error":...} when activation refuses), then answers one JSON
// line per command on stdin: {"method","path","body"?,"who"?} is a request to the activation, {"op":"close"} closes it.
import { createInterface } from 'node:readline';
import type { ExtensionActivation } from '@jimhoyd/urlcode/extensions';
import { createStore } from '../src/index.ts';
import { answer, requestFor } from './direct.ts';

const { database, config, activation } = JSON.parse(process.argv[2]!) as { database: string; config: Record<string, unknown>; activation: ExtensionActivation };
const reply = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const store = createStore({ database, projectSha256: activation.projectSha256 });
let instance: Awaited<ReturnType<typeof store.registration.activate>>;
try { instance = await store.registration.activate(config, activation); }
catch (error) { reply({ error: (error as Error).message }); await store.close(); process.exit(0); }
reply({ ready: true });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line) as { op?: string; method?: string; path?: string; body?: unknown; who?: string };
  if (command.op === 'close') break;
  const result = answer(await instance.handle!(requestFor(activation.mounts, command.method!, command.path!, { ...(command.body === undefined ? {} : { body: command.body }), ...(command.who ? { who: command.who } : {}) })));
  reply({ status: result.status, body: result.body });
}
await instance.close?.();
await store.close();
reply({ closed: true });
process.stdin.destroy();
