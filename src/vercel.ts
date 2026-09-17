import { randomUUID } from 'node:crypto';
import { activateNativeOnly, lazyRuntime, resolveOrigin } from './adapters.ts';
import { writeResponse, writeError } from './http-response.ts';
import { assert, HttpError } from './errors.ts';

const platformOrigins = ['VERCEL_PROJECT_PRODUCTION_URL','VERCEL_URL','VERCEL_BRANCH_URL'];

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
  maxBodyBytes = 1048576, plugins } = {}) {
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  const ready = lazyRuntime(() => activateNativeOnly(project, environment, { target: 'vercel', plugins }));

  return async function handler(req,res) {
    const requestId = randomUUID();
    let runtime;
    try {
      runtime = await ready();
      const headers = new Headers(), headerCounts = Object.create(null);
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i].toLowerCase();
        headers.append(key,req.rawHeaders[i+1]); headerCounts[key] = (headerCounts[key] || 0) + 1;
      }
      const limit = Math.min(maxBodyBytes, runtime.requestLimit(req.url) ?? maxBodyBytes);
      const body = await readBody(req,limit);
      // The platform terminates TLS and sets the forwarded header itself, so
      // its leftmost entry is the client; the socket peer is the platform.
      const forwarded = headerCounts['x-forwarded-for'] === 1 ? headers.get('x-forwarded-for').split(',')[0].trim() : undefined;
      const publicOrigin = resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost';
      const result = await runtime.handle({ target:req.url, method:req.method, headers, headerCounts, body,
        origin: publicOrigin, client: forwarded || req.socket?.remoteAddress });
      writeResponse(res,result,{ requestId, method:req.method });
    } catch (error) {
      // An activation failure is the operator's to see; a request never learns why.
      writeError(res,error instanceof HttpError ? error : new HttpError(500,'Internal server error'),{ requestId, method:req.method,
        headers: runtime?.errorHeaders(error, resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost') ?? [] });
      if (!(error instanceof HttpError)) throw error;
    }
  };
}
