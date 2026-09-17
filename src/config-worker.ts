import {parentPort,workerData} from 'node:worker_threads';
import {loadDocumentInWorker} from './config.ts';
import type {ConfigWorkerData,ConfigWorkerResult} from './config.ts';
import {ConfigError} from './errors.ts';
if (!parentPort) throw new Error('config-worker.ts must run as a worker thread');
const data = workerData as ConfigWorkerData; // trust boundary: config.ts is the only spawner
const post = (result: ConfigWorkerResult): void => parentPort!.postMessage(result);
try { post({value:await loadDocumentInWorker(data.project)}); }
catch(error) { post({error:error instanceof ConfigError?error.message:'Configuration loading failed'}); }
