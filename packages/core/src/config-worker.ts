import {parentPort,workerData} from 'node:worker_threads';
import {loadDocumentInWorker} from './config.ts';
import type {ConfigWorkerData,ConfigWorkerResult} from './config.ts';
import {ConfigError} from './errors.ts';
if (!parentPort) throw new Error('config-worker.ts must run as a worker thread');
const data = workerData as ConfigWorkerData; // trust boundary: config.ts is the only spawner
const post = (result: ConfigWorkerResult): void => parentPort!.postMessage(result);
try { post({value:await loadDocumentInWorker(data.project,{sources:data.sources===true})}); }
catch(error) { post(error instanceof ConfigError ? {error:error.message,details:error.details} : {error:'Configuration loading failed',details:{}}); }
