// Spec validation for budgets and backoffs: the bounds auth's password and velocity policy held, now owned here so
// every consumer (auth, forms) is re-validated at its own activation.
import { AbuseError } from './types.ts';
import type { AbuseBackoffSpec, AbuseBudgetSpec } from './types.ts';
import { SCOPE } from './keys.ts';

const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const invalid = (): never => { throw new AbuseError(400, 'invalid_abuse_spec'); };
const plain = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

export interface NormalBudget { scope: string; limit: number; windowMs: number; challengeAfter?: number }
export interface NormalBackoff { scope: string; threshold: number; initialDelayMs: number; maxDelayMs: number; resetAfterMs: number }

export function normalizeBudget(spec: AbuseBudgetSpec): NormalBudget {
  if (!plain(spec, ['scope', 'limit', 'windowMs', 'challengeAfter']) || typeof spec.scope !== 'string' || !SCOPE.test(spec.scope) || !integer(spec.limit, 1, 100000) || !integer(spec.windowMs, 1000, 86400000)) return invalid();
  if (spec.challengeAfter !== undefined && !integer(spec.challengeAfter, 1, spec.limit - 1)) return invalid();
  return { scope: spec.scope, limit: spec.limit, windowMs: spec.windowMs, ...(spec.challengeAfter !== undefined ? { challengeAfter: spec.challengeAfter } : {}) };
}
export function normalizeBackoff(spec: AbuseBackoffSpec): NormalBackoff {
  if (!plain(spec, ['scope', 'threshold', 'initialDelayMs', 'maxDelayMs', 'resetAfterMs']) || typeof spec.scope !== 'string' || !SCOPE.test(spec.scope)) return invalid();
  const value = { scope: spec.scope, threshold: spec.threshold ?? 5, initialDelayMs: spec.initialDelayMs ?? 1000, maxDelayMs: spec.maxDelayMs ?? 900000, resetAfterMs: spec.resetAfterMs ?? 86400000 };
  if (!integer(value.threshold, 1, 20) || !integer(value.initialDelayMs, 100, 60000) || !integer(value.maxDelayMs, value.initialDelayMs, 86400000) || !integer(value.resetAfterMs, value.maxDelayMs, 604800000)) return invalid();
  return value;
}
/** The block after the count-th consecutive failure. */
export function backoffDelay(count: number, spec: NormalBackoff): number {
  return count < spec.threshold ? 0 : Math.min(spec.maxDelayMs, spec.initialDelayMs * 2 ** Math.min(30, count - spec.threshold));
}
/** A counted value: a non-empty string of at most 1024 characters. */
export function validValue(value: unknown): value is string { return typeof value === 'string' && value.length >= 1 && value.length <= 1024; }
