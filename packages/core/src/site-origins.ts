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

/**
 * Multi-label public suffixes a shared passkey relying-party ID may never be.
 * Node exposes no Public Suffix List (neither `node:url` nor its ICU build
 * carries one) and the runtime ships no copy of it, so this is a short list of
 * the country-code second levels and hosting platforms operators most often
 * serve from. Single-label names (`com`, `uk`, `dev`) are refused separately.
 * It is a startup convenience, not the security boundary: browsers check the
 * RP ID against the full list and refuse a ceremony on a public suffix, so a
 * suffix missing here fails closed in the browser instead.
 */
export const passkeyPublicSuffixes: readonly string[] = Object.freeze([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'sch.uk', 'nhs.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz', 'geek.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
  'com.hk', 'org.hk', 'net.hk', 'com.tw', 'org.tw', 'net.tw', 'com.sg', 'org.sg', 'edu.sg', 'com.my', 'net.my', 'org.my',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'co.id', 'or.id', 'web.id', 'com.ph', 'net.ph', 'org.ph',
  'co.za', 'org.za', 'net.za', 'gov.za', 'co.il', 'org.il', 'com.tr', 'net.tr', 'org.tr',
  'com.mx', 'org.mx', 'net.mx', 'com.ar', 'net.ar', 'org.ar', 'com.co', 'net.co', 'com.pe', 'com.ua', 'co.ua',
  'com.es', 'nom.es', 'org.es', 'com.pl', 'net.pl', 'org.pl', 'co.at', 'or.at', 'com.pt', 'com.ru', 'co.th', 'in.th', 'com.vn', 'com.eg', 'com.sa', 'co.ke', 'com.ng',
  'github.io', 'gitlab.io', 'vercel.app', 'now.sh', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com',
  'herokuapp.com', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'amazonaws.com', 'on.aws', 'fly.dev', 'onrender.com', 'railway.app', 'deno.dev', 'glitch.me',
]);
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates the operator's shared passkey relying-party ID (`--passkey-rp-id`,
 * `passkeyRpId`, `URLCODE_PASSKEY_RP_ID`) against the site's serialized
 * origins (canonical first, from `siteOrigins`), and returns it, or
 * `undefined` when it is not set. It must be a lowercase ASCII DNS name
 * (punycode for international names), not an IP address, not a single label
 * (except `localhost` when the canonical host is `localhost`), not a listed
 * public suffix, and equal to, or a label-boundary parent domain of, the host
 * of the canonical origin and of every alias origin.
 */
export function passkeyRpId(raw: unknown, origins: readonly string[]): string | undefined {
  if (raw === undefined) return undefined;
  const fail = (message: string): never => { throw new ConfigError(message, { code: 'invalid-passkey-rp-id' }); };
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 253) return fail('The passkey RP ID must be a non-empty domain name of at most 253 characters');
  const show = JSON.stringify(raw);
  if (origins.length === 0) return fail('The passkey RP ID needs a canonical origin; pass --origin https://your.site as well');
  const labels = raw.split('.');
  if (!labels.every(label => dnsLabel.test(label))) return fail(`Passkey RP ID ${show} must be a lowercase DNS name (letters, digits and hyphens; punycode for international names) with no scheme, port, path or trailing dot`);
  if (/^[0-9]+$/.test(labels.at(-1)!)) return fail(`Passkey RP ID ${show} is an IP address; use a domain name`);
  if (raw === 'localhost') {
    if (new URL(origins[0]!).hostname !== 'localhost') fail('Passkey RP ID "localhost" is allowed only when the canonical origin\'s host is localhost');
  } else if (labels.length < 2) fail(`Passkey RP ID ${show} is a single label (a top-level domain); use a registrable domain such as example.com`);
  if (passkeyPublicSuffixes.includes(raw)) fail(`Passkey RP ID ${show} is a public suffix; use a registrable domain beneath it`);
  for (const origin of origins) {
    const host = new URL(origin).hostname;
    if (host !== raw && !host.endsWith('.' + raw)) fail(`Passkey RP ID ${show} is neither the host of ${origin} nor a parent domain of it; the canonical origin and every alias origin must be on the RP ID or a subdomain of it`);
  }
  return raw;
}
