import { docsUrl } from './release.ts';

// The migration hint for the route-wide `request.body` shape that #870 replaced with one policy per HTTP method
// (#1132). config.ts finds each place that still writes it and throws one ConfigError carrying this text;
// explainError (agent-context.ts) hands the same text back, so the CLI, MCP `validate` and `explain_error` agree.
// No alias: the old shape is refused, and nothing rewrites the YAML.

/** The keys the route-wide shape held directly under `request.body`; each now sits under a method key. */
export const legacyBodyKeys: readonly string[] = ['required', 'maxBytes', 'contentTypes', 'format', 'schema'];
/** The ErrorDetails code, also the marker explainError matches. */
export const LEGACY_REQUEST_BODY = 'legacy-request-body';
const allMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
/** RFC 9110 gives these no body semantics, so their entry takes only `maxBytes` (http-policy.ts bodylessMethods). */
const bodyless = ['GET', 'HEAD', 'DELETE'];
const defaultMethods = ['GET', 'HEAD'];
const MAX_LISTED_SITES = 8;

/** One place that writes the route-wide shape: a route or a shared block. */
export interface LegacyBodySite {
  /** How the hint names it: `route /contact` or `shared block "forms"`. */
  label: string;
  /** The legacy keys it holds, in schema order. */
  keys: string[];
  /** The methods it serves: a route's declared ones, or those every route using a shared block answers; undefined: the GET/HEAD default. */
  methods: string[] | undefined;
  /** A shared block is copied whole into each route that uses it, so its method keys must suit all of them. */
  shared?: boolean;
  /** `(line 9, column 7)` for every site after the first, which the file:line:column prefix already places. */
  position?: { line: number; column: number } | undefined;
}

/** The uppercase known methods in an authored `methods` value, or undefined when it names none. */
export function knownMethods(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const methods = allMethods.filter(method => value.includes(method));
  return methods.length ? methods : undefined;
}

const list = (words: string[]): string => words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
const flow = (keys: string[]): string => `{${keys.map(key => `${key}: ...`).join(', ')}}`;

/** One site's instruction: which keys go under which method key, and the YAML before and after (keys only, never values). */
function siteHint(site: LegacyBodySite): string {
  const methods = site.methods ?? defaultMethods;
  const named = `${site.label}${site.position ? ` (line ${site.position.line}, column ${site.position.column})` : ''}`;
  const others = site.keys.filter(key => key !== 'maxBytes'), sizeOnly = !others.length;
  const withBody = methods.filter(method => !bodyless.includes(method)), without = methods.filter(method => bodyless.includes(method));
  const before = `request.body: ${flow(site.keys)}`;
  const answers = site.shared
    ? site.methods ? `every route that uses it answers ${list(methods)}` : 'the routes in this file that use it share no method (or none uses it), so it suits the default GET and HEAD'
    : site.methods ? `it answers only ${list(methods)}` : 'it declares no methods, so it answers the default GET and HEAD';
  if (!withBody.length && !sizeOnly) {
    // GET, HEAD and DELETE entries take only maxBytes: a policy that types or requires a body belongs to a method
    // that carries one. Suggest declaring POST, keeping any methods the route already lists.
    const declared = [...(site.methods ?? []), 'POST'], declare = `methods: [${declared.join(', ')}]`;
    const where = site.shared ? `declare ${declare} on the routes that use it` : `declare ${declare}`;
    return `${named}: ${answers}, whose body entries take only maxBytes; if it accepts a body, ${where} and move ${list(site.keys)} under POST, so ${before} becomes ${site.shared ? '' : `${declare} with `}request.body: {POST: ${flow(site.keys)}}`;
  }
  // The route-wide policy applied to every method the route answered; each now gets the part its method may hold.
  const entries: [string, string[]][] = withBody.length ? withBody.map(method => [method, site.keys]) : [];
  if (site.keys.includes('maxBytes')) for (const method of without) entries.push([method, ['maxBytes']]);
  const full = entries.filter(([, keys]) => keys === site.keys).map(([method]) => method);
  const sized = entries.filter(([, keys]) => keys !== site.keys).map(([method]) => method);
  const moves = [full.length ? `${list(site.keys)} under ${list(full)}` : '', sized.length ? `${full.length ? 'maxBytes alone' : 'maxBytes'} under ${list(sized)}` : ''].filter(Boolean);
  const context = site.methods && !site.shared ? '' : `${answers}: `;
  return `${named}: ${context}move ${moves.join(', and ')}, so ${before} becomes request.body: {${entries.map(([method, keys]) => `${method}: ${flow(keys)}`).join(', ')}}`;
}

/**
 * The hint for every site, in document order: the rule, one instruction per site and the upgrade notes. The same
 * text is the tail of the ConfigError message (after `(legacy-request-body): `) and explainError's guidance.
 */
export function legacyRequestBodyHint(sites: LegacyBodySite[]): string {
  const shown = sites.slice(0, MAX_LISTED_SITES).map(siteHint);
  const more = sites.length > MAX_LISTED_SITES ? `; and ${sites.length - MAX_LISTED_SITES} more` : '';
  return `request.body now holds one policy per HTTP method, under a method key such as POST:, and the route-wide shape is refused. ${shown.join('; ')}${more}. See ${docsUrl('HTTP.md#moving-from-the-route-wide-body-shape')}`;
}

/** The hint inside a ConfigError message, or undefined when the text is not one. */
export function legacyRequestBodyHintIn(text: string): string | undefined {
  const marker = `(${LEGACY_REQUEST_BODY}): `, at = text.indexOf(marker);
  return at === -1 ? undefined : text.slice(at + marker.length).trim() || undefined;
}
