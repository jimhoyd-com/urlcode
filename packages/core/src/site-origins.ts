import { ConfigError } from './errors.ts';

/** The most additional origins an operator may declare beside the canonical one. */
export const maxAliasOrigins = 16;
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
// Scheme and authority only: an optional trailing slash, never a path, query or fragment.
const originShape = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+\/?$/i;

function aliasOrigin(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 2048) throw new ConfigError('Each alias origin must be a non-empty origin string', { code: 'invalid-alias-origin' });
  const show = JSON.stringify(raw);
  if (raw.includes('*')) throw new ConfigError(`Alias origin ${show} is a wildcard; list each origin exactly`, { code: 'invalid-alias-origin' });
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConfigError(`Alias origin ${show} is not an absolute URL; use https://host[:port]`, { code: 'invalid-alias-origin' }); }
  if (!originShape.test(raw) || url.username || url.password) throw new ConfigError(`Alias origin ${show} must be a scheme and host (and port) only, with no path, query, fragment or credentials`, { code: 'invalid-alias-origin' });
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && loopbackHosts.has(url.hostname)))
    throw new ConfigError(`Alias origin ${show} must use https: (http: only for localhost, 127.0.0.1 or [::1])`, { code: 'invalid-alias-origin' });
  return url.origin;
}

/**
 * The site's origins: the canonical origin first, then the operator's validated
 * alias origins in their serialized form (scheme and host lower-cased, a default
 * port dropped), deduplicated, with an entry equal to the canonical origin
 * removed. Empty when there is no canonical origin and no alias.
 */
export function siteOrigins(canonical: string | undefined, aliases: readonly string[] | undefined): string[] {
  if (aliases === undefined || aliases.length === 0) return canonical ? [canonical] : [];
  if (!Array.isArray(aliases)) throw new ConfigError('Alias origins must be an array of origin strings', { code: 'invalid-alias-origin' });
  if (aliases.length > maxAliasOrigins) throw new ConfigError(`At most ${maxAliasOrigins} alias origins are allowed; got ${aliases.length}`, { code: 'invalid-alias-origin' });
  if (!canonical) throw new ConfigError('Alias origins need a canonical origin; pass --origin https://your.site as well', { code: 'invalid-alias-origin' });
  const result = [canonical];
  for (const raw of aliases) { const origin = aliasOrigin(raw); if (!result.includes(origin)) result.push(origin); }
  return result;
}

/**
 * Whether `value` (an `Origin` header, or an origin derived from a `Referer`)
 * names one of the site's origins. The value must be a bare origin; it is
 * compared after the same serialization the list uses, so scheme/host case and
 * an explicit default port do not matter. `origins` defaults to the canonical
 * origin alone when the activation does not carry the list. An absent value or
 * the opaque `null` origin never matches: what an extension does without an
 * `Origin` stays its own decision.
 */
export function isSiteOrigin(context: { readonly origin: string; readonly origins?: readonly string[] | undefined }, value: string | null | undefined): boolean {
  if (typeof value !== 'string' || !originShape.test(value)) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.username || url.password) return false;
  const origins = context.origins ?? [context.origin];
  return url.origin !== 'null' && origins.includes(url.origin);
}
