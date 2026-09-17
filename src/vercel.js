import { randomUUID } from 'node:crypto';
import { createRuntime } from './runtime.js';
import { validatePolicy } from './policy.js';
import { writeResponse, writeError } from './http-response.js';
import { assert, ConfigError, HttpError } from './errors.js';

// Handlers that need something a serverless invocation does not have. Functions
// and middleware need worker threads and the WASM engine on every cold start;
// stored links need a durable writable file. Both are refused at activation
// rather than failing per request, so a deployment cannot half-work.
const unsupported = { function:'isolated functions', link:'stored live links' };

function resolveOrigin(origin, environment) {
  if (origin) return origin;
  if (environment.URLCODE_ORIGIN) return environment.URLCODE_ORIGIN;
  // Platform-set, not client-supplied: forwarded headers stay untrusted.
  for (const name of ['VERCEL_PROJECT_PRODUCTION_URL','VERCEL_URL','VERCEL_BRANCH_URL']) {
    if (environment[name]) return `https://${environment[name]}`;
  }
  return undefined;
}

function readPolicy(environment) {
  if (!environment.URLCODE_POLICY) return undefined;
  let parsed;
  try { parsed = JSON.parse(environment.URLCODE_POLICY); }
  catch { throw new ConfigError('URLCODE_POLICY is not valid JSON'); }
  // The same grant document the self-hosted runtime reads from a file, carried
  // through the only channel a serverless deployment has. Still revision-pinned.
  return validatePolicy(parsed);
}

function readBody(req, limit) {
  if (req.headers['content-length'] && Number(req.headers['content-length']) > limit) return Promise.reject(new HttpError(413,'Request body too large'));
  return new Promise((resolve,reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { req.off('data',data); req.off('end',end); req.off('error',error); };
    const error = cause => { cleanup(); reject(cause); };
    const data = chunk => {
      size += chunk.length;
      if (size > limit) { req.pause(); error(new HttpError(413,'Request body too large')); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data',data); req.once('end',end); req.once('error',error);
  });
}

// Builds a Vercel Node function handler. The runtime is created once per
// instance and reused across warm invocations; a failed activation is not
// cached, so a fixed deployment recovers without a code change.
export function createVercelHandler({ project = process.cwd(), origin, environment = process.env,
  maxBodyBytes = 1048576 } = {}) {
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  let pending;
  const start = async () => {
    const runtime = await createRuntime(project, { permissions: readPolicy(environment), environment });
    const refused = runtime.testPlan().inventory
      .flatMap(route => [
        ...(unsupported[route.handler] ? [`${route.path} uses ${unsupported[route.handler]}`] : []),
        ...(route.middleware ? [`${route.path} declares middleware`] : []),
      ]);
    if (refused.length) {
      await runtime.close();
      throw new ConfigError(`This adapter serves native handlers only: ${refused.join('; ')}`);
    }
    return runtime;
  };
  const ready = () => (pending ??= start().catch(error => { pending = undefined; throw error; }));

  return async function handler(req,res) {
    const requestId = randomUUID();
    try {
      const runtime = await ready();
      const headers = new Headers(), headerCounts = Object.create(null);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i].toLowerCase();
        headers.append(key,req.rawHeaders[i+1]); headerCounts[key] = (headerCounts[key] || 0) + 1;
      }
      const limit = Math.min(maxBodyBytes, runtime.requestLimit(req.url) ?? maxBodyBytes);
      const body = await readBody(req,limit);
      const result = await runtime.handle({ target:req.url, method:req.method, headers, headerCounts, body,
        origin: resolveOrigin(origin,environment) ?? 'http://localhost' });
      writeResponse(res,result,{ requestId, method:req.method });
    } catch (error) {
      // An activation failure is the operator's to see; a request never learns why.
      writeError(res,error instanceof HttpError ? error : new HttpError(500,'Internal server error'),{ requestId, method:req.method });
      if (!(error instanceof HttpError)) throw error;
    }
  };
}
