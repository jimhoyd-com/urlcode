import { assert } from './errors.ts';
import { resolveClient } from './client-address.ts';
import type { Cidr } from './client-address.ts';
import type { ErrorFormat, HandlerResult, HeaderPair } from './http-response.ts';
import type { RequestTrace, Runtime } from './runtime.ts';

// The request half every self-hosted host shares: the Node server (server.ts) and the embedded fetch handler
// (embed.ts) turn what their transport gives them into one runtime request here, so neither can read headers,
// bodies or the client address differently from the other (RIM-EMBED-001).

import type { HeaderCounts } from './header-counts.ts';
export type { HeaderCounts } from './header-counts.ts';
export { joinedHeaderCounts } from './header-counts.ts';

/** Headers and per-name occurrence counts from Node-style raw header lines (name, value, name, value, ...). */
export function readHeaderLines(rawHeaders: readonly string[]): { headers: Headers; headerCounts: HeaderCounts } {
  const headers = new Headers(), headerCounts: HeaderCounts = Object.create(null) as HeaderCounts;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = (rawHeaders[i] ?? '').toLowerCase();
    headers.append(key, rawHeaders[i + 1] ?? ''); headerCounts[key] = (headerCounts[key] || 0) + 1;
  }
  return { headers, headerCounts };
}


// A server must accept absolute-form targets (RFC 9112 §3.2.2). The scheme and authority are removed textually,
// never re-encoded, so the path keeps the exact bytes the runtime's encoding checks inspect.
export function originForm(target: string): string {
  const match = /^https?:\/\/[^/?#]*(.*)$/i.exec(target);
  const rest = match?.[1];
  if (rest === undefined) return target;
  return rest === '' || rest.startsWith('?') ? '/' + rest : rest;
}

/**
 * The client a request is attributed to: the peer the host vouches for, unless it is one of the operator's trusted
 * proxies and sent exactly one X-Forwarded-For header, which is then walked from the right (client-address.ts).
 */
export function requestClient(peer: string | undefined, headers: Headers, headerCounts: HeaderCounts, trusted: Cidr[]): string | undefined {
  return resolveClient(peer, headerCounts['x-forwarded-for'] === 1 ? headers.get('x-forwarded-for') ?? undefined : undefined, trusted);
}

/** A mount prefix: empty, or `/segment[/segment...]` without a trailing slash, dot segments, `//`, query or fragment. */
export function normalizeBasePath(basePath: string | undefined): string {
  if (basePath === undefined || basePath === '' || basePath === '/') return '';
  assert(typeof basePath === 'string' && /^(?:\/[A-Za-z0-9\-._~!$&'()*+,;=:@%]+)+$/.test(basePath)
    && !basePath.split('/').some(segment => segment === '.' || segment === '..'), 'Base path must be /segment[/segment...] without a trailing slash');
  return basePath;
}

/** What one host hands the shared pipeline for one request. */
export interface HostRequest {
  target: string; method: string; headers: Headers; headerCounts: HeaderCounts; peer: string | undefined;
  /** Reads the whole request body, refusing (413) past `limit` bytes. */
  readBody(limit: number): Promise<Uint8Array>;
  requestId: string; signal: AbortSignal; trace: RequestTrace; origin: string; basePath?: string | undefined;
}
export interface HostLimits { maxBodyBytes: number; trustedProxies: Cidr[] }

/** Reads the body under the route's own limit, resolves the client and runs the request through `runtime`. */
export async function handleHostRequest(runtime: Runtime, request: HostRequest, { maxBodyBytes, trustedProxies }: HostLimits): Promise<HandlerResult> {
  const { target, method, headers, headerCounts, requestId, signal, trace, origin, basePath } = request;
  const body = await request.readBody(Math.min(maxBodyBytes, runtime.requestLimit(target, method) ?? maxBodyBytes));
  return await runtime.handle({ target, method, headers, headerCounts, body, trace, requestId, signal, origin,
    ...(basePath ? { basePath } : {}), client: requestClient(request.peer, headers, headerCounts, trustedProxies) });
}

/** The error answer's policy headers and format: operational probes keep text, project paths get their declared format. */
export function hostErrorOptions(runtime: Runtime, error: unknown, { origin, target, probe }: { origin: string; target: string; probe?: boolean | undefined }): { headers: HeaderPair[]; format: ErrorFormat } {
  return { headers: runtime.errorHeaders(error, origin), format: probe ? 'text' : runtime.errorFormat(error, originForm(target)) };
}

/**
 * A path-absolute `Location` names a path of the site, and the site lives under `basePath`, so the prefix is added.
 * An absolute URL, a scheme-relative (`//host`) or a relative reference is left as it is.
 */
export function mountLocation(result: HandlerResult, basePath: string): HandlerResult {
  if (!basePath) return result;
  let changed = false;
  const headers = result.headers.map(([key, value]): HeaderPair => {
    if (key.toLowerCase() !== 'location' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return [key, value];
    changed = true; return [key, basePath + value];
  });
  return changed ? { ...result, headers } : result;
}
