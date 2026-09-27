import { isLoopbackAddress } from './client-address.ts';

/**
 * The client a `steps` fixture plays: the host name its cookies are scoped to, and whether that origin is a secure
 * context (https, or loopback, which browsers also treat as secure), so `Secure` cookies are kept and sent.
 */
export interface JarScope { host: string; secure: boolean }

/** The scope of a client of `origin` (an absolute http(s) URL). */
export function jarScope(origin: string): JarScope {
  const url = new URL(origin), host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return { host, secure: url.protocol === 'https:' || host === 'localhost' || host.endsWith('.localhost') || isLoopbackAddress(host) };
}

interface Cookie { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; expiresAt: number; created: number }

// Bounds for one fixture's jar: what a browser keeps for one host, and the size one cookie may have.
const MAX_COOKIES = 50, MAX_COOKIE_BYTES = 4096;
const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, control = /[\x00-\x1f\x7f]/;
const isIp = (host: string): boolean => host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host);

/** RFC 6265 section 5.1.3: the host is the domain, or a subdomain of it (never for an IP address). */
const domainMatches = (host: string, domain: string): boolean => host === domain || (!isIp(host) && host.endsWith(`.${domain}`));
/** RFC 6265 section 5.1.4. `path` is a request target; its query is not part of the path. */
const uriPath = (target: string): string => target.split(/[?#]/, 1)[0] || '/';
function defaultPath(target: string): string {
  const path = uriPath(target);
  if (!path.startsWith('/')) return '/';
  const last = path.lastIndexOf('/');
  return last <= 0 ? '/' : path.slice(0, last);
}
function pathMatches(target: string, cookiePath: string): boolean {
  const path = uriPath(target);
  return path === cookiePath || (path.startsWith(cookiePath) && (cookiePath.endsWith('/') || path[cookiePath.length] === '/'));
}

/**
 * One `steps` fixture's cookie jar: the RFC 6265 storage model, trimmed to one client of one origin. A response's
 * `Set-Cookie` lines are stored with their Domain, Path, Secure, Expires and Max-Age (Max-Age wins; zero, negative or
 * a past date deletes); `__Secure-` and `__Host-` prefixes are enforced. HttpOnly and SameSite do not apply: every
 * fixture request is a same-site request by the client itself. There is no public-suffix list: the only host is the
 * test origin, so a broad Domain reaches nothing else. A cookie the jar refuses is dropped, as a browser drops it.
 *
 * Values are secrets the run must never print: `values()` lists every value the jar was handed, kept or not, for
 * redaction.
 */
export class CookieJar {
  readonly #scope: JarScope; readonly #now: () => number;
  readonly #cookies = new Map<string, Cookie>(); readonly #seen = new Map<string, string>();
  #created = 0;
  constructor(scope: JarScope, now: () => number = Date.now) { this.#scope = scope; this.#now = now; }

  /** Stores the `Set-Cookie` lines of the response to a request for `target`. */
  store(lines: readonly string[], target: string): void { for (const line of lines) this.#storeOne(line, target); }

  #storeOne(line: string, target: string): void {
    const [pair = '', ...attributes] = line.split(';'), at = pair.indexOf('=');
    if (at < 0) return;
    const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
    if (value) this.#seen.set(value, name);
    if (!name || !token.test(name) || control.test(value) || Buffer.byteLength(name + value) > MAX_COOKIE_BYTES) return;
    let domain: string | undefined, path: string | undefined, secure = false, maxAge: number | undefined, expires: number | undefined;
    for (const attribute of attributes) {
      const split = attribute.indexOf('='), key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase(), text = split < 0 ? '' : attribute.slice(split + 1).trim();
      if (key === 'domain' && text) domain = text.replace(/^\./, '').toLowerCase();
      else if (key === 'path') path = text.startsWith('/') ? text : undefined;
      else if (key === 'secure') secure = true;
      else if (key === 'max-age' && /^-?\d+$/.test(text)) maxAge = Number(text);
      else if (key === 'expires') { const date = Date.parse(text); if (Number.isFinite(date)) expires = date; }
    }
    const host = this.#scope.host;
    if (domain !== undefined && !domainMatches(host, domain)) return;
    if (secure && !this.#scope.secure) return;
    const lower = name.toLowerCase();
    if ((lower.startsWith('__secure-') || lower.startsWith('__host-')) && !secure) return;
    if (lower.startsWith('__host-') && (domain !== undefined || path !== '/')) return;
    const now = this.#now();
    const cookie: Cookie = { name, value, domain: domain ?? host, hostOnly: domain === undefined, path: path ?? defaultPath(target), secure,
      expiresAt: maxAge !== undefined ? (maxAge <= 0 ? -Infinity : now + maxAge * 1000) : expires ?? Infinity, created: this.#created++ };
    const key = `${cookie.name}\n${cookie.domain}\n${cookie.path}`, old = this.#cookies.get(key);
    if (cookie.expiresAt <= now) { this.#cookies.delete(key); return; }
    if (old) cookie.created = old.created;
    else { this.#expire(now); if (this.#cookies.size >= MAX_COOKIES) return; }
    this.#cookies.set(key, cookie);
  }

  #expire(now: number): void { for (const [key, cookie] of this.#cookies) if (cookie.expiresAt <= now) this.#cookies.delete(key); }

  /** The cookies a request for `target` carries, longest path first, then oldest; none whose name is in `except`. */
  send(target: string, except: ReadonlySet<string> = new Set()): { name: string; value: string }[] {
    this.#expire(this.#now());
    const host = this.#scope.host;
    return [...this.#cookies.values()]
      .filter(c => !except.has(c.name) && (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) && pathMatches(target, c.path) && (!c.secure || this.#scope.secure))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
      .map(({ name, value }) => ({ name, value }));
  }

  /** Every cookie value this jar was handed, with its name, for redacting output. */
  values(): ReadonlyMap<string, string> { return this.#seen; }
}

/** The names an explicit `Cookie` request header already sends. */
export const cookieNames = (header: string): Set<string> =>
  new Set(header.split(';').map(part => part.slice(0, part.indexOf('=') < 0 ? undefined : part.indexOf('=')).trim()).filter(Boolean));
