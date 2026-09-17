import {parentPort,workerData} from 'node:worker_threads';
import {loadDocumentInWorker} from './config.js';
import {ConfigError} from './errors.js';
try { parentPort.postMessage({value:await loadDocumentInWorker(workerData.project)}); }
catch(error) { parentPort.postMessage({error:error instanceof ConfigError?error.message:'Configuration loading failed'}); }
