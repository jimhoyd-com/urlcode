// The public contract of @jimhoyd/urlcode-abuse: AbuseExports v1, shared through composeHost with every extension
// that `requires` or `uses` abuse. Consumers import these types only; the values come from ctx.get('abuse').
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';

export interface AbuseExports {
  readonly version: 1;
  /** True once the runtime activated extensions.abuse. */
  readonly active: boolean;
  /**
   * A handle whose keys are namespaced. `name` matches /^[a-z][a-z0-9-]{0,31}$/ (the caller's extension name; at most
   * 32 characters so it is also a valid challenge action). Throws AbuseError(503,'abuse_inactive') until active.
   */
  namespace(name: string): AbuseNamespace;
  /** Present iff the operator passed abuse({challenge}) in host.mjs. */
  readonly challenge: AbuseChallenge | undefined;
  readonly honeypot: AbuseHoneypot;
}
export interface AbuseNamespace {
  readonly name: string;
  /**
   * Validates once (throws AbuseError 400 invalid_abuse_spec): scope /^[a-z][a-z0-9-]{0,31}$/, limit 1..100000,
   * windowMs 1000..86400000, challengeAfter 1..limit-1. A scope is either a budget or a backoff within a namespace.
   */
  budget(spec: AbuseBudgetSpec): AbuseBudget;
  /**
   * threshold 1..20 (default 5), initialDelayMs 100..60000 (1000), maxDelayMs initialDelayMs..86400000 (900000),
   * resetAfterMs maxDelayMs..604800000 (86400000).
   */
  backoff(spec: AbuseBackoffSpec): AbuseBackoff;
  /**
   * 1..8 entries, each a budget made by this namespace with a value of 1..1024 characters, no two alike. One SQLite
   * transaction: if any live counter is at its limit the answer is 429 and nothing increments; otherwise new rows are
   * capacity-checked (503 abuse_capacity when full), every counter increments (a fixed window from its first hit) and
   * challengeRequired is true when any count exceeds its budget's challengeAfter. Rejects
   * AbuseError(503,'abuse_unavailable') when storage fails: answer 503, never admit on a throw.
   */
  admit(entries: readonly AbuseAdmitEntry[]): Promise<AbuseAdmission>;
}
export interface AbuseBudgetSpec { scope: string; limit: number; windowMs: number; challengeAfter?: number }
export interface AbuseBudget {
  readonly namespace: string; readonly scope: string; readonly limit: number; readonly windowMs: number;
  readonly challengeAfter?: number;
}
export interface AbuseAdmitEntry { readonly budget: AbuseBudget; readonly value: string }
export type AbuseAdmission =
  | { readonly allowed: true; readonly challengeRequired: boolean }
  | { readonly allowed: false; readonly status: 429; readonly code: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly allowed: false; readonly status: 503; readonly code: 'abuse_capacity' };
export interface AbuseBackoffSpec { scope: string; threshold?: number; initialDelayMs?: number; maxDelayMs?: number; resetAfterMs?: number }
export interface AbuseBackoff {
  readonly scope: string;
  readonly threshold: number; readonly initialDelayMs: number; readonly maxDelayMs: number; readonly resetAfterMs: number;
  check(value: string): Promise<{ readonly blocked: boolean; readonly retryAfterSeconds: number }>;
  /**
   * count = min(64, count+1); delay = count < threshold ? 0 : min(maxDelayMs, initialDelayMs * 2^min(30, count-threshold));
   * expires = now+resetAfterMs; blocked_until = now+delay. Rejects AbuseError(503,'abuse_capacity') when a new row
   * would exceed maxKeys.
   */
  failure(value: string): Promise<void>;
  clear(value: string): Promise<void>;
}
export interface AbuseChallengeWidget {
  /** Trusted fixed markup to place inside the <form>; posts its token as field `challengeToken`. <= 2048 bytes. */
  readonly markup: string;
  readonly csp: { readonly script: readonly string[]; readonly frame: readonly string[]; readonly connect: readonly string[] };
  /** Absolute https URLs whose origin is listed in csp.script; the shape of ui's ExtensionScript. */
  readonly scripts: readonly { readonly src: string; readonly async: boolean }[];
}
export interface AbuseChallenge {
  /** The provider's widget for `action` (/^[a-z][a-z0-9-]{0,31}$/), validated. Throws on an invalid action or widget. */
  widget(action: string): AbuseChallengeWidget;
  /**
   * Never throws. false unless: token is a string of 1..2048 characters without control characters, client is an IP
   * address (pass request.client, not a clientKey), fewer than 32 verifications are in flight, and the provider
   * answers true within 5000 ms (after which it is aborted). Never caches a verdict.
   */
  verify(input: { token: unknown; client: string | null; action: string }): Promise<boolean>;
}
/**
 * Operator-supplied (host.mjs); abuse wraps it with the bounds above and validates widget() output (https origins,
 * script src within csp.script, markup size).
 */
export interface AbuseChallengeProvider {
  widget(action: string): AbuseChallengeWidget;
  verify(input: { token: string; client: string; action: string; signal: AbortSignal }): Promise<boolean>;
}
export interface AbuseHoneypot {
  /**
   * `<div hidden><label>Leave this field empty<input name="{field}" tabindex="-1" autocomplete="off"></label></div>`;
   * field /^[a-z][A-Za-z0-9_]{0,63}$/, else throws AbuseError 400.
   */
  markup(field: string): string;
  /** value !== undefined && value !== '' */
  filled(value: unknown): boolean;
}
export type AbuseErrorCode = 'invalid_abuse_spec' | 'abuse_inactive' | 'abuse_unavailable' | 'abuse_capacity';
const messages: Readonly<Record<AbuseErrorCode, string>> = {
  invalid_abuse_spec: 'Invalid abuse budget, backoff or entry',
  abuse_inactive: 'The abuse extension is not active',
  abuse_unavailable: 'Abuse protection is unavailable',
  abuse_capacity: 'Abuse counter capacity reached',
};
export class AbuseError extends Error {
  readonly status: 400 | 503;
  readonly code: AbuseErrorCode;
  constructor(status: 400 | 503, code: AbuseErrorCode) { super(messages[code]); this.name = 'AbuseError'; this.status = status; this.code = code; }
}
export interface AbuseOptions {
  /** Exact project revision the operator reviewed. */
  projectSha256: string;
  /** Absolute or cwd-relative path of the SQLite counter database. */
  database: string;
  /** Exactly 32 bytes; the HMAC key that makes counter keys pseudonymous. */
  key: Uint8Array;
  /** Row bound used until activation; extensions.abuse.config.maxKeys (default 100000) replaces it. */
  maxKeys?: number;
  challenge?: AbuseChallengeProvider;
  now?: () => number;
}
export interface AbuseInstance { readonly registration: RuntimeExtension; readonly exports: AbuseExports; close(): Promise<void> }
