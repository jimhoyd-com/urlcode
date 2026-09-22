import { assert } from './errors.ts';

const maxPatternLength = 128;
export const maxPatternInputLength = 128;
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
  // One entry per currently open group, true once its body has shown a
  // quantifier (`*+?{n,m}`) or a top-level alternation `|`. A *bounded*
  // repeat of such a group (`(a+){2,3}`, `(a|b){2,3}`) still lets the
  // backtracker retry each of the `n` copies against every inner
  // possibility, which is super-linear even though the outer bound is
  // finite; only a group with a genuinely flat body may be bound-repeated.
  const groups: boolean[] = [];
  const markQuantifier = (): void => { if (groups.length) groups[groups.length - 1] = true; };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '\\') {
      const next = pattern[i + 1] ?? '';
      assert(inClass || !/[1-9k]/.test(next), 'Pattern backreferences are not supported');
      i++; continue;
    }
    if (inClass) { if (char === ']') inClass = false; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === '|') { markQuantifier(); continue; }
    if (char === '(') {
      assert(!/^\(\?<?[=!]/.test(pattern.slice(i, i + 4)), 'Pattern lookaround is not supported');
      groups.push(false);
      // Skip past `(?:` and `(?<name>` group syntax so its `?` (and the
      // name's own characters) are never mistaken for a body quantifier.
      if (pattern[i + 1] === '?') {
        if (pattern[i + 2] === ':') i += 2;
        else if (pattern[i + 2] === '<') { const end = pattern.indexOf('>', i + 3); i = end === -1 ? i + 2 : end; }
        else i += 1;
      }
      continue;
    }
    if (char === ')') {
      const hadInnerQuantifier = groups.pop() ?? false;
      const rest = pattern.slice(i + 1);
      const unboundedRepeat = /^(?:[*+]|\{\d+,\})/.test(rest);
      const boundedRepeat = !unboundedRepeat && /^\{\d+(,\d+)?\}/.test(rest);
      assert(!unboundedRepeat, 'Pattern cannot repeat a group without a bound');
      assert(!(boundedRepeat && hadInnerQuantifier), 'Pattern cannot bound-repeat a group that contains a quantifier or alternation');
      if (boundedRepeat) markQuantifier();
      continue;
    }
    if (char === '*' || char === '+' || char === '?' || (char === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)))) markQuantifier();
    if (char === '*' || char === '+' || (char === '{' && /^\{\d+,\}/.test(pattern.slice(i)))) unbounded++;
  }
  assert(unbounded <= maxUnboundedQuantifiers, `Pattern allows at most ${maxUnboundedQuantifiers} unbounded quantifiers`);
}
