import { assert } from './errors.ts';

const maxPatternLength = 128;
export const maxPatternInputLength = 128;
const maxUnboundedQuantifiers = 3;
/**
 * Backtracking-path budget for an admitted pattern on a `maxPatternInputLength`
 * input (see `backtrackingPaths`). Three unbounded quantifiers in an anchored
 * pattern, the largest shape the guard has always admitted, cost about 3.7e5
 * paths; the budget leaves room for an optional atom beside them and refuses
 * the flat runs of optional, bounded or alternative atoms that counting only
 * `*`, `+` and `{n,}` used to miss. An unanchored pattern is charged one more
 * unbounded width for its start positions.
 */
const maxBacktrackingPaths = 2 ** 20;

/**
 * A conservative bound on the ways a backtracking engine can split an input of
 * `inputLength` characters between a pattern's variable-width quantifiers,
 * from one start position. `widths` holds each quantifier's slack (`max - min`,
 * `Infinity` for `*`, `+` and `{n,}`), so the count is the number of tuples
 * with `c_i <= widths[i]` and `sum(c_i) <= inputLength`, multiplied by
 * `choices` (the product of alternation branch counts). Once the count passes
 * `limit` the function stops early and returns a value above `limit`.
 *
 * Shared by the route/body pattern guard below and the agents policy subset.
 * It is a cost model for refusing patterns, not a proof of linear time.
 */
export function backtrackingPaths(widths: readonly number[], inputLength: number, choices = 1, limit = Infinity): number {
  if (choices > limit) return choices;
  // ways[s]: tuples over the quantifiers seen so far whose counts sum to s.
  let ways: number[] = new Array<number>(inputLength + 1).fill(0);
  ways[0] = 1;
  let total = 1;
  for (const width of widths) {
    const w = Math.min(width, inputLength);
    if (!(w > 0)) continue;
    const next = new Array<number>(inputLength + 1).fill(0);
    let window = 0; // ways[s - w .. s]: a sliding box convolution
    total = 0;
    for (let s = 0; s <= inputLength; s++) {
      window += ways[s]!;
      if (s > w) window -= ways[s - w - 1]!;
      next[s] = window;
      total += window;
    }
    ways = next;
    if (total * choices > limit) return total * choices;
  }
  return total * choices;
}

/**
 * Accepts an author regex only when it is conservatively safe to run on every
 * request in the host process. Node has no linear-time engine, so this refuses
 * the constructs that make backtracking blow up — repeated groups, lookaround
 * and backreferences — caps unbounded quantifiers, and charges every
 * variable-width quantifier (`*`, `+`, `?`, `{n,}`, `{n,m}` with `m > n`) and
 * every alternation against one backtracking-path budget, so a flat run of
 * optional or bounded atoms is refused like its grouped form. It is a
 * restriction, not a proof: callers must also bound the input length to
 * `maxPatternInputLength`.
 */
export function assertSafePattern(pattern: string): void {
  assert(pattern.length > 0 && pattern.length <= maxPatternLength, `Pattern must be 1 to ${maxPatternLength} characters`);
  try { new RegExp(pattern, 'u'); } catch { assert(false, 'Invalid pattern'); }
  let unbounded = 0, inClass = false, afterQuantifier = false, choices = 1;
  const widths: number[] = [];
  // One entry per currently open group, true once its body has shown a
  // quantifier (`*+?{n,m}`) or a top-level alternation `|`. A *bounded*
  // repeat of such a group (`(a+){2,3}`, `(a|b){2,3}`) still lets the
  // backtracker retry each of the `n` copies against every inner
  // possibility, which is super-linear even though the outer bound is
  // finite; only a group with a genuinely flat body may be bound-repeated.
  const groups: boolean[] = [];
  // Alternation branches per open group; index 0 is the whole pattern.
  const branches: number[] = [1];
  const markQuantifier = (): void => { if (groups.length) groups[groups.length - 1] = true; };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    const lazy = afterQuantifier && char === '?';
    afterQuantifier = false;
    if (lazy) continue; // `*?`, `+?`, `??`, `{n,m}?`: a modifier, not another quantifier
    if (char === '\\') {
      const next = pattern[i + 1] ?? '';
      assert(inClass || !/[1-9k]/.test(next), 'Pattern backreferences are not supported');
      i++; continue;
    }
    if (inClass) { if (char === ']') inClass = false; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === '|') { markQuantifier(); branches[branches.length - 1]!++; continue; }
    if (char === '(') {
      assert(!/^\(\?<?[=!]/.test(pattern.slice(i, i + 4)), 'Pattern lookaround is not supported');
      groups.push(false);
      branches.push(1);
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
      choices *= branches.pop() ?? 1;
      const rest = pattern.slice(i + 1);
      const unboundedRepeat = /^(?:[*+]|\{\d+,\})/.test(rest);
      const boundedRepeat = !unboundedRepeat && /^\{\d+(,\d+)?\}/.test(rest);
      assert(!unboundedRepeat, 'Pattern cannot repeat a group without a bound');
      assert(!(boundedRepeat && hadInnerQuantifier), 'Pattern cannot bound-repeat a group that contains a quantifier or alternation');
      if (boundedRepeat) markQuantifier();
      continue;
    }
    if (char === '*' || char === '+') { markQuantifier(); unbounded++; widths.push(Infinity); afterQuantifier = true; continue; }
    if (char === '?') { markQuantifier(); widths.push(1); afterQuantifier = true; continue; }
    const counted = char === '{' ? /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i)) : null;
    if (counted) {
      markQuantifier();
      if (counted[2] === undefined) widths.push(0);
      else if (counted[2] === '') { unbounded++; widths.push(Infinity); }
      else widths.push(Math.max(0, Number(counted[2]) - Number(counted[1])));
      i += counted[0].length - 1; afterQuantifier = true;
    }
  }
  // An unanchored pattern is retried from every start position, which costs
  // like one more unbounded quantifier in front of it.
  if (!(pattern.startsWith('^') && branches[0] === 1)) widths.push(Infinity);
  choices *= branches[0]!;
  assert(unbounded <= maxUnboundedQuantifiers, `Pattern allows at most ${maxUnboundedQuantifiers} unbounded quantifiers`);
  assert(backtrackingPaths(widths, maxPatternInputLength, choices, maxBacktrackingPaths) <= maxBacktrackingPaths,
    'Pattern has too many optional, bounded or alternative parts to bound its matching cost; anchor it with ^, or use fewer quantifiers, format or enum');
}
