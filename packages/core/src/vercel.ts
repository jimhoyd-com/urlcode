import type { RuntimeExtension } from './extensions.ts';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { activateNativeOnly, lazyRuntime, resolveOrigin } from './adapters.ts';
import type { Environment } from './adapters.ts';
import type { HostPlugin, Runtime } from './runtime.ts';
import { writeResponse, writeError } from './http-response.ts';
import { assert, HttpError } from './errors.ts';

export interface VercelHandlerOptions { project?: string | undefined; origin?: string | undefined; environment?: Environment | undefined; maxBodyBytes?: number | undefined; plugins?: HostPlugin[] | undefined; extensions?:RuntimeExtension[]|undefined }
export type VercelHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const platformOrigins = ['VERCEL_PROJECT_PRODUCTION_URL','VERCEL_URL','VERCEL_BRANCH_URL'];

// `x-forwarded-for` is documented as overwritten (not appended to) by
// Vercel's edge, but only when Vercel itself is the client-facing proxy; a
// project's own proxy in front of Vercel can still set it before Vercel ever
// sees the request. `x-vercel-forwarded-for` is Vercel's own copy of the same
// value and is the header Vercel's docs say to prefer for exactly that reason
// (https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for).
// Exported so the adapter's client-IP resolution can be verified directly.
export function forwardedClient(headers: Headers, headerCounts: Record<string, number>): string | undefined {
  return headerCounts['x-vercel-forwarded-for'] === 1 ? (headers.get('x-vercel-forwarded-for') ?? '').split(',')[0]?.trim() || undefined : undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (req.headers['content-length'] && Number(req.headers['content-length']) > limit) return Promise.reject(new HttpError(413,'Request body too large'));
  return new Promise((resolve,reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { req.off('data',data); req.off('end',end); req.off('error',error); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const data = (chunk: Buffer) => {
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
  maxBodyBytes = 1048576, plugins, extensions }: VercelHandlerOptions = {}): VercelHandler {
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  const ready = lazyRuntime(() => activateNativeOnly(project, environment, { target: 'vercel', plugins, extensions, origin:resolveOrigin(origin,environment,platformOrigins) }));

  return async function handler(req,res) {
    const requestId = randomUUID();
    const target = req.url ?? '', method = req.method ?? 'GET';
    let runtime: Runtime | undefined;
    try {
      runtime = await ready();
      const headers = new Headers(), headerCounts: Record<string, number> = Object.create(null) as Record<string, number>;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = (req.rawHeaders[i] ?? '').toLowerCase();
        headers.append(key,req.rawHeaders[i+1] ?? ''); headerCounts[key] = (headerCounts[key] || 0) + 1;
      }
      const limit = Math.min(maxBodyBytes, runtime.requestLimit(target) ?? maxBodyBytes);
      const body = await readBody(req,limit);
      const forwarded = forwardedClient(headers, headerCounts);
      const publicOrigin = resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost';
      const result = await runtime.handle({ target, method, headers, headerCounts, body,
        origin: publicOrigin, client: forwarded || req.socket?.remoteAddress });
      writeResponse(res,result,{ requestId, method });
    } catch (error) {
      // An activation failure is the operator's to see; a request never learns why.
      writeError(res,error instanceof HttpError ? error : new HttpError(500,'Internal server error'),{ requestId, method,
        headers: runtime?.errorHeaders(error, resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost') ?? [] });
      if (!(error instanceof HttpError)) throw error;
    }
  };
}
