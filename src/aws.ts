import { randomUUID } from 'node:crypto';
import { activateNativeOnly, lazyRuntime, resolveOrigin } from './adapters.ts';
import type { Environment } from './adapters.ts';
import type { HostPlugin, Runtime } from './runtime.ts';
import { prepareResponse, errorResponse } from './http-response.ts';
import type { HeaderPair } from './http-response.ts';
import { assert, ConfigError, HttpError } from './errors.ts';

export interface LambdaHandlerOptions { project?: string | undefined; origin?: string | undefined; environment?: Environment | undefined; maxBodyBytes?: number | undefined; plugins?: HostPlugin[] | undefined }
/** A Lambda payload format 2.0 event, as far as this adapter reads it. */
export interface LambdaEvent {
  version?: string; httpMethod?: string; rawPath?: string; rawQueryString?: string;
  headers?: Record<string, string | undefined>; cookies?: string[]; body?: string | null; isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; sourceIp?: string } };
}
export interface LambdaResponse { statusCode: number; headers: Record<string, string>; cookies: string[]; body: string; isBase64Encoded: true }
export type LambdaHandler = (event: unknown) => Promise<LambdaResponse>;

const platformOrigins = ['URLCODE_PUBLIC_HOST'];
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';

// Payload format 2.0 only, as used by Lambda Function URLs and API Gateway
// HTTP APIs. Format 1.0 supplies the path and query already decoded, so the
// original bytes cannot be recovered; this runtime rejects ambiguous encoding
// deliberately, and rebuilding a target from decoded parts would either
// re-encode differently or quietly accept what the runtime refuses. Front a
// REST API with an HTTP API, or run the container image with `urlcode serve`.
function target(event: LambdaEvent): { method: string; target: string } {
  if (event.version !== '2.0') {
    throw new ConfigError(event.httpMethod
      ? 'Payload format 1.0 is unsupported because it cannot preserve the original request encoding; use a Function URL or HTTP API'
      : 'Unsupported Lambda event: this adapter expects payload format 2.0');
  }
  const method = event.requestContext?.http?.method;
  assert(typeof method === 'string' && method.length, 'Lambda event has no request method');
  const path = typeof event.rawPath === 'string' && event.rawPath.length ? event.rawPath : '/';
  const query = typeof event.rawQueryString === 'string' ? event.rawQueryString : '';
  return { method, target: query ? `${path}?${query}` : path };
}

function requestHeaders(event: LambdaEvent): { headers: Headers; counts: Record<string, number> } {
  const headers = new Headers(), counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [name,value] of Object.entries(event.headers || {})) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    // API Gateway joins repeats with a comma; the count reflects that a client
    // sent more than one, which route policy uses to reject ambiguous inputs.
    const parts = key === 'cookie' ? [value] : String(value).split(',');
    for (const part of parts) headers.append(key, part.trim());
    counts[key] = parts.length;
  }
  for (const cookie of event.cookies || []) headers.append('cookie', cookie);
  if (event.cookies?.length) counts.cookie = (counts.cookie || 0) + event.cookies.length;
  return { headers, counts };
}

function requestBody(event: LambdaEvent, limit: number): Buffer {
  if (event.body === undefined || event.body === null) return Buffer.alloc(0);
  const body = event.isBase64Encoded ? Buffer.from(event.body,'base64') : Buffer.from(event.body,'utf8');
  if (body.length > limit) throw new HttpError(413,'Request body too large');
  return body;
}

// Builds a Lambda handler for payload format 2.0. The runtime is created once
// per execution environment and reused across warm invocations.
export function createLambdaHandler({ project = process.cwd(), origin, environment = process.env,
  maxBodyBytes = 1048576, plugins }: LambdaHandlerOptions = {}): LambdaHandler {
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  const ready = lazyRuntime(() => activateNativeOnly(project, environment, { target: 'aws', plugins }));

  return async function handler(raw) {
    const requestId = randomUUID();
    let method = 'GET', runtime: Runtime | undefined;
    try {
      runtime = await ready();
      assert(isRecord(raw), 'Lambda event must be an object');
      const event = raw as LambdaEvent; // trust boundary: the platform's event, checked field by field below
      const request = target(event);
      method = request.method;
      const { headers, counts } = requestHeaders(event);
      const limit = Math.min(maxBodyBytes, runtime.requestLimit(request.target) ?? maxBodyBytes);
      const result = await runtime.handle({ target:request.target, method, headers, headerCounts:counts,
        body: requestBody(event,limit),
        origin: resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost',
        // Set by the platform from the connection, not by the client.
        client: event.requestContext?.http?.sourceIp });
      return respond(prepareResponse(result,{ requestId, method }));
    } catch (error) {
      // An activation or configuration failure is the operator's to read in the
      // function log; a request only ever learns the status.
      if (!(error instanceof HttpError)) console.error(error);
      const prepared = errorResponse(error, { requestId, method,
        headers: runtime?.errorHeaders(error, resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost') ?? [] });
      return respond({ ...prepared, cookies: [], body: prepared.body === undefined ? undefined : Buffer.from(prepared.body) });
    }
  };
}

function respond({ status, headers, cookies, body }: { status: number; headers: HeaderPair[]; cookies: string[]; body: string | Uint8Array | null | undefined }): LambdaResponse {
  const merged: Record<string, string> = {};
  for (const [key,value] of headers) {
    const name = key.toLowerCase();
    const previous = merged[name];
    merged[name] = previous === undefined ? value : `${previous}, ${value}`;
  }
  // Always base64: a response may carry image or archive bytes, and guessing
  // whether a body is text is how binary assets get corrupted in transit.
  return { statusCode: status, headers: merged, cookies,
    body: Buffer.from(body ?? Buffer.alloc(0)).toString('base64'), isBase64Encoded: true };
}
