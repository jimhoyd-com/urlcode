import { assert } from '../errors.ts';
import { validateHeaderName, validateHeaderValue } from '../header-validation.ts';
import type { HandlerResult, HeaderPair } from '../http-response.ts';

export interface SecurityConfig { headers?: string; unset?: string[]; set?: Record<string, string> }
export interface SecurityState {
  profileName: string; profile: readonly HeaderPair[]; overrides: readonly HeaderPair[]; size: number;
  unset: readonly string[]; overrideKeys: Set<string>;
}
export interface SecurityDescription { headers: string; emits: string[]; set: string[]; unset: string[]; bytes: number }

// Response security headers. The profile values are the OWASP Secure Headers
// Project "best practices" recommendations, copied verbatim so "what does
// `oshp` set" is answerable from a public source; `set` and `unset` adjust one
// header at a time. This module has no Node dependency: the Cloudflare Worker
// imports it directly and calls compile() synchronously.
export const name = 'security';
export const phases: readonly string[] = ['response'];

// The tables below are the OSHP 2024 best practices values; note the revision
// here when they change. Header order is the OSHP order. X-Content-Type-Options is missing on
// purpose: the runtime sets `nosniff` on every response already, and Cache-
// Control belongs to the cache policy. Strict-Transport-Security is listed
// here but only emitted on an https origin (see onResponse).
const oshp = Object.freeze(([
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['x-frame-options', 'deny'],
  ['x-permitted-cross-domain-policies', 'none'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['content-security-policy', "default-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests; block-all-mixed-content"],
  ['cross-origin-embedder-policy', 'require-corp'],
  ['cross-origin-opener-policy', 'same-origin'],
  ['cross-origin-resource-policy', 'same-origin'],
  ['permissions-policy', 'accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(self), usb=(), web-share=(), xr-spatial-tracking=(), clipboard-read=(), clipboard-write=(), gamepad=(), hid=(), idle-detection=(), interest-cohort=(), serial=(), unload=()'],
] as HeaderPair[]).map(pair => Object.freeze(pair)));

// The profile tables, exported so the reference doc is generated from code
// rather than copied. Keys are lower-case header names; values are exact.
export const profiles: Readonly<Record<string, readonly (readonly [string, string])[]>> = Object.freeze({
  oshp,
  'oshp-no-csp': Object.freeze(oshp.filter(([key]) => key !== 'content-security-policy')),
  off: Object.freeze([] as HeaderPair[]),
});

// Headers the runtime or a handler owns; `set` may not claim them. Mirrors
// the set in packages/core/src/http-policy.ts (that file uses the Node Buffer global, so the
// list is reproduced rather than imported).
export const reservedHeaders = Object.freeze(new Set(['connection','keep-alive','transfer-encoding','content-length','upgrade','trailer','proxy-authenticate','proxy-authorization','te','location','allow','content-range','accept-ranges','etag','last-modified','content-encoding','x-request-id','x-content-type-options','content-type','set-cookie','cache-control','vary','ratelimit','ratelimit-policy','retry-after','age']));

// A compiled profile must leave room for the response it decorates: the
// runtime caps a response at 16 KiB / 256 headers, so static headers are
// bounded at half of that.
const maxStaticBytes = 8192;
const encoder = new TextEncoder();
const byteLength = (value: string): number => encoder.encode(value).length;

export function targets(): Record<string, 'native' | 'compiled'> { return { node:'native', vercel:'native', aws:'native', cloudflare:'compiled' }; }

// Synchronous by contract: the Worker cannot await it.
export function compile(config: unknown, { route }: { route: { pattern: string } }): SecurityState {
  const where = `policies.${name} on ${route.pattern}`;
  assert(config && typeof config === 'object' && !Array.isArray(config), `${where} must be an object`);
  const options = config as SecurityConfig;
  const profileName = options.headers ?? 'oshp';
  assert(Object.hasOwn(profiles, profileName), `${where}: unknown headers profile "${profileName}"`);
  const table = new Map<string, string>(profiles[profileName]!);

  for (const raw of options.unset ?? []) {
    assert(typeof raw === 'string', `${where}: unset entries must be header names`);
    const key = raw.toLowerCase();
    assert(table.has(key), `${where}: unset names "${raw}", which the ${profileName} profile does not emit`);
    table.delete(key);
  }

  // `set` wins over the profile and over whatever the response already
  // carries: an operator who writes the header out means it.
  const set = new Map<string, string>();
  for (const [raw, value] of Object.entries(options.set ?? {})) {
    const key = raw.toLowerCase();
    try { validateHeaderName(raw); validateHeaderValue(raw, value); } catch { assert(false, `${where}: invalid set header "${raw}"`); }
    assert(typeof value === 'string' && !/[\x00-\x1f\x7f]/u.test(value), `${where}: invalid set header "${raw}"`);
    assert(!reservedHeaders.has(key), `${where}: set header "${raw}" is owned by the runtime or handler`);
    assert(!set.has(key), `${where}: duplicate set header "${raw}" (case insensitive)`);
    table.delete(key);
    set.set(key, value);
  }

  const profile = Object.freeze([...table]);
  const overrides = Object.freeze([...set]);
  const size = [...profile, ...overrides].reduce((n, [key, value]) => n + byteLength(key + value), 0);
  assert(size <= maxStaticBytes, `${where}: static headers exceed ${maxStaticBytes} bytes`);
  return Object.freeze({
    profileName, profile, overrides, size,
    unset: Object.freeze((options.unset ?? []).map(key => key.toLowerCase())),
    overrideKeys: new Set(set.keys()),
  });
}

// Runs on every result the runtime finishes, including early denials and
// cache hits, so nothing here reads a body. Profile headers fill gaps only;
// YAML response.headers, function and asset headers are already present and
// keep their value. HSTS is skipped off https: a browser ignores it on a
// plain-text response, and emitting it through a TLS-terminating proxy is a
// decision the operator states with --origin, not one the runtime guesses.
export function onResponse(state: SecurityState, request: { origin?: unknown } | null | undefined, result: HandlerResult): HandlerResult {
  if (!state.profile.length && !state.overrides.length) return result;
  const https = typeof request?.origin === 'string' && request.origin.startsWith('https:');
  const present = new Set<string>();
  const headers: HeaderPair[] = [];
  for (const pair of result.headers) {
    const key = pair[0].toLowerCase();
    if (state.overrideKeys.has(key)) continue;
    present.add(key);
    headers.push(pair);
  }
  for (const [key, value] of state.profile) {
    if (present.has(key)) continue;
    if (key === 'strict-transport-security' && !https) continue;
    headers.push([key, value]);
  }
  for (const pair of state.overrides) headers.push(pair);
  return { ...result, headers };
}

export function describe(state: SecurityState): SecurityDescription {
  return {
    headers: state.profileName,
    emits: state.profile.map(([key]) => key),
    set: state.overrides.map(([key]) => key),
    unset: [...state.unset],
    bytes: state.size,
  };
}

export function close(): void {}
