import type { RuntimeExtension } from './extensions.ts';
import { randomUUID } from 'node:crypto';
import { activateNativeOnly, lazyRuntime, resolveAliasOrigins, resolveOrigin, resolvePasskeyRpId } from './adapters.ts';
import type { Environment } from './adapters.ts';
import type { HostPlugin, Runtime } from './runtime.ts';
import { cancelStream, prepareResponse, errorResponse } from './http-response.ts';
import type { HeaderPair } from './http-response.ts';
import { assert, ConfigError, HttpError } from './errors.ts';
import { isRecord } from './object-guards.ts';

export interface LambdaHandlerOptions { project?: string | undefined; origin?: string | undefined; aliasOrigins?: readonly string[] | undefined; passkeyRpId?: string | undefined; environment?: Environment | undefined; maxBodyBytes?: number | undefined; plugins?: HostPlugin[] | undefined; extensions?:RuntimeExtension[]|undefined }
/** A Lambda payload format 2.0 event, as far as this adapter reads it. */
export interface LambdaEvent {
  version?: string; httpMethod?: string; rawPath?: string; rawQueryString?: string;
  headers?: Record<string, string | undefined>; cookies?: string[]; body?: string | null; isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string; sourceIp?: string } };
}
export interface LambdaResponse { statusCode: number; headers: Record<string, string>; cookies: string[]; body: string; isBase64Encoded: true }
export type LambdaHandler = (event: unknown) => Promise<LambdaResponse>;

const platformOrigins = ['URLCODE_PUBLIC_HOST'];
// Payload format 2.0 joins every repeated header with a comma before this
// adapter ever sees it (there is no `multiValueHeaders` on this format), so a
// client that sent one occurrence with a comma in its value is
// indistinguishable, at this layer, from two occurrences API Gateway joined.
// Splitting unconditionally corrupts the former and inflates its count. Only
// the headers RFC 7230/9110 define as a comma-separated list are safe to
// split; every other header (including any project-declared one) is kept as
// the single value the platform handed over, whatever characters it holds.
const listValuedHeaders = new Set([
  'accept','accept-charset','accept-encoding','accept-language','access-control-allow-headers','access-control-allow-methods',
  'access-control-expose-headers','access-control-request-headers','allow','cache-control','connection','content-encoding',
  'content-language','expect','forwarded','if-match','if-none-match','pragma','te','trailer','transfer-encoding','upgrade',
  'vary','via','warning','www-authenticate','x-forwarded-for',
]);

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
    // API Gateway joins repeats of a *list-valued* header with a comma; the
    // count then reflects that a client sent more than one, which route
    // policy uses to reject ambiguous inputs. Any other header is scalar as
    // far as this adapter is concerned: splitting it on comma would mangle a
    // legitimate value and miscount a single occurrence as several.
    const parts = listValuedHeaders.has(key) ? String(value).split(',') : [String(value)];
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
export function createLambdaHandler({ project = process.cwd(), origin, aliasOrigins, passkeyRpId, environment = process.env,
  maxBodyBytes = 1048576, plugins, extensions }: LambdaHandlerOptions = {}): LambdaHandler {
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  const ready = lazyRuntime(() => activateNativeOnly(project, environment, { target: 'aws', plugins, extensions, origin:resolveOrigin(origin,environment,platformOrigins), aliasOrigins:resolveAliasOrigins(aliasOrigins,environment), passkeyRpId:resolvePasskeyRpId(passkeyRpId,environment) }));

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
      const result = await runtime.handle({ target:request.target, method, headers, headerCounts:counts, requestId,
        body: requestBody(event,limit),
        origin: resolveOrigin(origin,environment,platformOrigins) ?? 'http://localhost',
        // Set by the platform from the connection, not by the client.
        client: event.requestContext?.http?.sourceIp });
      // Streaming is refused before serving on this target; a stream reaching here anyway is stopped, never buffered.
      if (result.stream !== undefined) { cancelStream(result.stream); throw new HttpError(502, 'Invalid function response'); }
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
