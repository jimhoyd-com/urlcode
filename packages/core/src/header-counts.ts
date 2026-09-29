// Header occurrence counts when a host has already joined repeated lines. Kept free of Node imports: the
// Cloudflare Worker (cloudflare.ts) and the self-hosted hosts (host-request.ts, runtime.ts) share this one rule.

export type HeaderCounts = Record<string, number>;

/**
 * Occurrence counts for headers a host has already joined (a fetch `Headers` combines repeats with ", "), when the
 * original lines are gone. A joined value containing a comma may have been two lines, so it counts as two: every
 * check that refuses a repeated header then refuses it, rather than reading a lost repeat as one. A single line
 * whose value legitimately contains a comma is refused by those checks too; that is the price of not knowing.
 */
export function joinedHeaderCounts(headers: Headers): HeaderCounts {
  const counts: HeaderCounts = Object.create(null) as HeaderCounts;
  for (const [key, value] of headers) if (key !== 'set-cookie') counts[key] = value.includes(',') ? 2 : 1;
  return counts;
}
