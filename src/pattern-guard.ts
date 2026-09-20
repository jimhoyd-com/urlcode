import { assert } from './errors.ts';

export const maxPatternLength = 128;
export const maxPatternInputLength = 256;
const maxUnboundedQuantifiers = 3;

/**
 * Accepts an author regex only when it is conservatively safe to run on every
 * request in the host process. Node has no linear-time engine, so this refuses
 * the constructs that make backtracking blow up — repeated groups, lookaround
 * and backreferences — and caps unbounded quantifiers. It is a restriction, not
 * a proof: callers must also bound the input length to `maxPatternInputLength`.
 */
export function assertSafePattern(pattern: string): void {
  assert(pattern.length > 0 && pattern.length <= maxPatternLength, `Pattern must be 1 to ${maxPatternLength} characters`);
  try { new RegExp(pattern, 'u'); } catch { assert(false, 'Invalid pattern'); }
  let unbounded = 0, inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      const next = pattern[i + 1] ?? '';
      assert(inClass || !/[1-9k]/.test(next), 'Pattern backreferences are not supported');
      i++; continue;
    }
    if (inClass) { if (char === ']') inClass = false; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === '(') assert(!/^\(\?<?[=!]/.test(pattern.slice(i, i + 4)), 'Pattern lookaround is not supported');
    if (char === ')') assert(!/^(?:[*+]|\{\d+,\})/.test(pattern.slice(i + 1)), 'Pattern cannot repeat a group without a bound');
    if (char === '*' || char === '+' || (char === '{' && /^\{\d+,\}/.test(pattern.slice(i)))) unbounded++;
  }
  assert(unbounded <= maxUnboundedQuantifiers, `Pattern allows at most ${maxUnboundedQuantifiers} unbounded quantifiers`);
}
