import {parentPort,workerData} from 'node:worker_threads';
import {loadDocumentInWorker} from './config.ts';
import type {ConfigWorkerData,ConfigWorkerResult} from './config.ts';
import {ConfigError} from './errors.ts';
if (!parentPort) throw new Error('config-worker.ts must run as a worker thread');
const data = workerData as ConfigWorkerData; // trust boundary: config.ts is the only spawner
const post = (result: ConfigWorkerResult): void => parentPort!.postMessage(result);
// No top-level await here: the load starts from a later macrotask, so this module's evaluation (and config.ts's own
// top-level await) has fully settled before any result is posted. The worker then holds no handle and exits by
// itself; loadDocument waits for that exit rather than terminating a thread mid module evaluation (#708).
setImmediate(() => {
  loadDocumentInWorker(data.project,{sources:data.sources===true}).then(
    value => post({value}),
    (error: unknown) => post(error instanceof ConfigError ? {error:error.message,details:error.details} : {error:'Configuration loading failed',details:{}}));
});
