import type { RuntimeExtension } from './extensions.ts';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { activateNativeOnly, lazyRuntime, resolveAliasOrigins, resolveOrigin } from './adapters.ts';
import type { Environment } from './adapters.ts';
import type { HostPlugin, Runtime } from './runtime.ts';
import { writeResponse, writeError } from './http-response.ts';
import { StreamHost } from './http-stream.ts';
import type { StreamLimits } from './http-stream.ts';
import { contentLengthEnforcementIsSafe } from './server.ts';
import { readHeaderLines, readIncomingBody } from './host-request.ts';
import { assert, HttpError } from './errors.ts';

// See server.ts's contentLengthEnforcementIsSafe: this handler also writes
// through node:http's ServerResponse, so it is exposed to the same Node
// 22.13.0-22.14.x false-positive ERR_HTTP_CONTENT_LENGTH_MISMATCH crash.
const enforceContentLength = contentLengthEnforcementIsSafe();

export interface VercelHandlerOptions { project?: string | undefined; origin?: string | undefined; aliasOrigins?: readonly string[] | undefined; environment?: Environment | undefined; maxBodyBytes?: number | undefined; plugins?: HostPlugin[] | undefined; extensions?:RuntimeExtension[]|undefined;
  /** Limits for streamed extension responses on this function instance (docs/OPERATIONS.md#streamed-responses); each
   * given value replaces its default. The provider's own function duration limit still applies on top. */
  streams?: Partial<StreamLimits> | undefined }
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

// Builds a Vercel Node function handler. The runtime is created once per
// instance and reused across warm invocations; a failed activation is not
// cached, so a fixed deployment recovers without a code change.
export function createVercelHandler({ project = process.cwd(), origin, aliasOrigins, environment = process.env,
  maxBodyBytes = 1048576, plugins, extensions, streams: streamLimits }: VercelHandlerOptions = {}): VercelHandler {
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  const streams = new StreamHost(streamLimits);
  const ready = lazyRuntime(() => activateNativeOnly(project, environment, { target: 'vercel', plugins, extensions, origin:resolveOrigin(origin,environment,platformOrigins), aliasOrigins:resolveAliasOrigins(aliasOrigins,environment) }));

  return async function handler(req,res) {
    const requestId = randomUUID();
    const target = req.url ?? '', method = req.method ?? 'GET';
    let runtime: Runtime | undefined;
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableFinished && !controller.signal.aborted) controller.abort('client-closed'); });
    try {
      runtime = await ready();
      const { headers, headerCounts } = readHeaderLines(req.rawHeaders);
      const limit = Math.min(maxBodyBytes, runtime.requestLimit(target, method) ?? maxBodyBytes);
      const body = await readIncomingBody(req,limit);
      const forwarded = forwardedClient(headers, headerCounts);
      const publicOrigin = resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost';
      const result = await runtime.handle({ target, method, headers, headerCounts, body, requestId, signal: controller.signal,
        origin: publicOrigin, client: forwarded || req.socket?.remoteAddress });
      // A streamed extension response is written as produced; the invocation settles when the stream ends.
      if (result.stream !== undefined) await (await streams.start(res, result, { requestId, method, controller })).finished;
      else writeResponse(res,result,{ requestId, method, enforceContentLength });
    } catch (error) {
      // An activation failure is the operator's to see; a request never learns why.
      writeError(res,error instanceof HttpError ? error : new HttpError(500,'Internal server error'),{ requestId, method, enforceContentLength,
        headers: runtime?.errorHeaders(error, resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost') ?? [],
        format: runtime?.errorFormat(error, target) ?? 'text' });
      if (!(error instanceof HttpError)) throw error;
    }
  };
}
