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
const instance = await Promise.resolve().then(() => store.registration.activate(config, activation)).catch(async (error: unknown) => {
  await store.close();
  // Exit only once the line is written: a pipe write can still be pending (asynchronous on some platforms).
  process.stdout.write(`${JSON.stringify({ error: (error as Error).message })}\n`, () => process.exit(0));
  return new Promise<never>(() => {});
});
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
