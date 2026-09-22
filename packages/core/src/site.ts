import { stat, readdir, lstat, readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { assert, ConfigError } from './errors.ts';
import { safeFile } from './config.ts';
import { publishableAssetName } from './assets.ts';
import { lists as bundled } from '../../../data/agents/index.js';
import type { LoadedDocument, LogFn, ProjectDocument, RobotsConfig, RouteConfig, SecurityTxtConfig, SiteConfig, SitemapConfig } from './types.ts';

export interface SiteOptions { origin?: string | undefined; log?: LogFn; routes?: Record<string, RouteConfig> }
interface SiteContext { origin: string | undefined; log: LogFn }
type SiteKey = keyof SiteConfig;

// Site conventions: the optional top-level `site` block. Every key generates
// one ordinary native route (`respond` or `page`) that is merged into the
// route table before compilation, so policies, fixtures, the audit and every
// target see it as a route the project could have written by hand. A route
// the project declares at the same path always wins; the generated one is
// dropped and logged as shadowed. Nothing here is active unless declared.
export const generatedPaths: Readonly<Record<SiteKey, string>> = Object.freeze({
  robots: '/robots.txt', sitemap: '/sitemap.xml', favicon: '/favicon.ico',
  securityTxt: '/.well-known/security.txt', llms: '/llms.txt', notFound: '/404.html',
});
const MAX_SITEMAP_URLS = 50000;
const MAX_RESPONSE_BYTES = 1048576;
const helper = 'generate the file at build time and serve it as a static asset instead';

// A product token as crawlers use them in practice: RFC 9309 §2.2.1 permits
// letters, hyphen and underscore, and the lists carry digits and dots in
// names that every crawler matches case-insensitively. Anything else in a
// list (a pattern with spaces or metacharacters) cannot name a group.
const productToken = /^[A-Za-z0-9_.-]+$/;
const robotsPath = /^\/[^\s\x00-\x1f\x7f#]*$/u;
const isoUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const changefreqs: readonly string[] = ['always','hourly','daily','weekly','monthly','yearly','never'];

function checkOrigin(origin: string | undefined): string | undefined {
  if (origin === undefined) return undefined;
  let url: URL;
  try { url = new URL(origin); } catch { assert(false, 'site: origin must be an absolute HTTP(S) origin'); }
  assert(['http:','https:'].includes(url.protocol) && url.origin === origin, 'site: origin must be an HTTP(S) origin without path or credentials');
  return origin;
}
const xmlEscapes: Record<string, string> = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' };
const escapeXml = (value: string): string => value.replace(/[&<>"']/g, c => xmlEscapes[c]!);
const lines = (values: string[]): string => values.map(line => line + '\n').join('');

function robotsRoute(config: RobotsConfig | undefined, { origin, log }: SiteContext): RouteConfig {
  const where = 'site.robots';
  assert(config && typeof config === 'object', `${where} must be an object`);
  const groups: Record<'disallow' | 'allow', { names: string[]; paths: string[] }> = { disallow: { names: [], paths: [] }, allow: { names: [], paths: [] } };
  for (const side of ['disallow','allow'] as const) {
    for (const entry of config[side] ?? []) {
      assert(typeof entry === 'string' && entry.length, `${where}.${side} entries must be bundled list names or paths`);
      if (Object.hasOwn(bundled, entry)) {
        let skipped = 0;
        for (const [name] of bundled[entry]!.patterns) {
          if (!productToken.test(name)) { skipped++; continue; }
          if (!groups[side].names.some(n => n.toLowerCase() === name.toLowerCase())) groups[side].names.push(name);
        }
        if (skipped) log({ event:'site', key:'robots', severity:'info', list:entry, skipped, message:`${where}.${side} list ${JSON.stringify(entry)}: ${skipped} entries have no product-token name and were not listed` });
      } else {
        assert(robotsPath.test(entry) && entry.length <= 2048, `${where}.${side} entry ${JSON.stringify(entry)} is neither a bundled list (${Object.keys(bundled).join(', ')}) nor a path starting with /`);
        groups[side].paths.push(entry);
      }
    }
  }
  const out: string[] = [];
  if (groups.disallow.names.length) out.push(...groups.disallow.names.map(n => `User-agent: ${n}`), 'Disallow: /', '');
  if (groups.allow.names.length) out.push(...groups.allow.names.map(n => `User-agent: ${n}`), 'Allow: /', '');
  out.push('User-agent: *');
  if (groups.disallow.paths.length || groups.allow.paths.length) out.push(...groups.disallow.paths.map(p => `Disallow: ${p}`), ...groups.allow.paths.map(p => `Allow: ${p}`));
  else out.push('Allow: /');
  if (config.sitemap === true) {
    if (origin) out.push('', `Sitemap: ${origin}${generatedPaths.sitemap}`);
    else log({ event:'site', key:'robots', severity:'info', message:'site.robots.sitemap: no public origin is known (start with --origin), so the Sitemap line is omitted' });
  }
  for (const extra of config.extra ?? []) {
    assert(typeof extra === 'string' && !/[\x00-\x1f\x7f]/u.test(extra) && extra.length <= 2048, `${where}.extra lines must be single lines of text`);
  }
  if (config.extra?.length) out.push('', ...config.extra);
  return { respond: { text: lines(out) } };
}

function excluder(patterns: string[] | undefined): (path: string) => boolean {
  const rules = (patterns ?? []).map((pattern): { prefix?: string; exact?: string } => {
    assert(typeof pattern === 'string' && pattern.startsWith('/') && !/[\s\x00-\x1f\x7f]/u.test(pattern), `site.sitemap.exclude patterns must be paths, optionally ending in /*`);
    return pattern.endsWith('/*') ? { prefix: pattern.slice(0, -1) } : { exact: pattern };
  });
  return path => rules.some(rule => rule.exact !== undefined ? rule.exact === path : path.startsWith(rule.prefix!) || path === rule.prefix!.slice(0, -1));
}
const noindex = (route: RouteConfig): boolean => Object.entries(route.response?.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'x-robots-tag' && [value].flat().some(v => /\bnoindex\b/i.test(v)));
const htmlType = (value: unknown): boolean => typeof value === 'string' && /^text\/html(?:;|$)/i.test(value.trim());
const htmlFile = (file: string): boolean => ['.html','.htm'].includes(extname(file).toLowerCase());
const day = (date: number): string => new Date(date).toISOString().slice(0, 10);

async function walkHtml(root: string, directory: string, index: string | undefined): Promise<{ key: string; modified: number }[]> {
  const found: { key: string; modified: number }[] = [];
  async function walk(relative: string, key: string, depth: number): Promise<void> {
    assert(depth <= 20, 'Asset directory depth exceeded');
    for (const entry of (await readdir(join(root, relative), { withFileTypes:true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!publishableAssetName(entry.name)) continue;
      const next = relative + '/' + entry.name;
      if (entry.isDirectory()) await walk(next, key + entry.name + '/', depth + 1);
      else if (entry.isFile() && htmlFile(entry.name)) found.push({ key: entry.name === index ? key : key + entry.name, modified: (await lstat(join(root, next))).mtimeMs });
    }
  }
  await walk(directory, '', 0);
  return found;
}

async function sitemapRoute(config: true | SitemapConfig | undefined, routes: Record<string, RouteConfig>, root: string, { origin }: SiteContext): Promise<RouteConfig> {
  const where = 'site.sitemap';
  assert(config === true || (config && typeof config === 'object'), `${where} must be true or an object`);
  const options: SitemapConfig = config === true ? {} : config;
  assert(origin, `${where}: a sitemap needs absolute URLs; start with --origin https://your.host (or leave site.sitemap undeclared)`);
  if (options.changefreq !== undefined) assert(changefreqs.includes(options.changefreq), `${where}.changefreq must be one of ${changefreqs.join(', ')}`);
  if (options.priority !== undefined) assert(typeof options.priority === 'number' && options.priority >= 0 && options.priority <= 1, `${where}.priority must be between 0.0 and 1.0`);
  const excluded = excluder(options.exclude);
  const now = Date.now();
  const entries = new Map<string, number | undefined>();
  const add = (path: string, modified?: number): void => { if (!excluded(path) && !entries.has(path)) entries.set(path, modified); };
  for (const [pattern, route] of Object.entries(routes)) {
    if (pattern.includes('{') || route.enabled === false || (route.expires && Date.parse(route.expires) <= now)) continue;
    if ([generatedPaths.robots, generatedPaths.sitemap, generatedPaths.notFound].includes(pattern) || noindex(route)) continue;
    if (route.methods && !route.methods.includes('GET')) continue;
    if (route.page) {
      if (htmlFile(route.page.file) || htmlType(route.page.contentType)) add(pattern, (await stat(await safeFile(root, route.page.file))).mtimeMs);
    } else if (route.respond) {
      if (Object.entries(route.response?.headers ?? {}).some(([name, value]) => name.toLowerCase() === 'content-type' && htmlType(value))) add(pattern);
    } else if (route.static) {
      const prefix = pattern.slice(0, -1);
      for (const file of await walkHtml(root, route.static.directory, route.static.index)) add(prefix + file.key.split('/').map(encodeURIComponent).join('/'), file.modified);
    }
  }
  assert(entries.size <= MAX_SITEMAP_URLS, `${where}: ${entries.size} URLs exceed the ${MAX_SITEMAP_URLS} the protocol allows in one file; ${helper}`);
  const items = [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, modified]) =>
    `  <url><loc>${escapeXml(origin + path)}</loc>${modified === undefined ? '' : `<lastmod>${day(modified)}</lastmod>`}${options.changefreq ? `<changefreq>${options.changefreq}</changefreq>` : ''}${options.priority === undefined ? '' : `<priority>${options.priority.toFixed(1)}</priority>`}</url>`);
  const text = lines(['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...items, '</urlset>']);
  assert(Buffer.byteLength(text) <= MAX_RESPONSE_BYTES, `${where}: the sitemap exceeds the 1 MiB declared-response limit; ${helper}`);
  return { respond: { text }, response: { headers: { 'Content-Type': 'application/xml; charset=utf-8' } } };
}

const faviconTypes: Record<string, string> = { '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.png': 'image/png' };
function faviconRoute(file: unknown): RouteConfig {
  assert(typeof file === 'string' && file.length, 'site.favicon must be a project-relative file path');
  const type = faviconTypes[extname(file).toLowerCase()];
  assert(type, 'site.favicon must be an .ico, .svg or .png file');
  return { page: { file, contentType: type, cacheControl: 'public, max-age=3600' } };
}

function llmsRoute(file: unknown): RouteConfig {
  assert(typeof file === 'string' && file.length, 'site.llms must be a project-relative text file path');
  return { page: { file, contentType: 'text/plain' } };
}

// The page a request that matches no route is answered with. It is an ordinary
// page route at /404.html (the object name static hosts already use for this);
// the runtime and the Worker serve it with status 404 for an unmatched GET or
// HEAD, and a request for /404.html itself gets the page like any other.
function notFoundRoute(file: unknown): RouteConfig {
  assert(typeof file === 'string' && file.length, 'site.notFound must be a project-relative .html file path');
  assert(htmlFile(file), 'site.notFound must be an .html or .htm file; it is served as text/html');
  return { page: { file, contentType: 'text/html; charset=utf-8', cacheControl: 'no-store' } };
}

// RFC 9116 §2.5 field order. One value per line; Preferred-Languages is the
// one field whose single value is a comma-separated list.
const securityFields: readonly (readonly [keyof SecurityTxtConfig, string, RegExp?])[] = [
  ['acknowledgments','Acknowledgments', /^https:/],
  ['canonical','Canonical', /^https:/],
  ['contact','Contact', /^(?:mailto:|tel:|https:)/],
  ['encryption','Encryption', /^(?:https:|dns:|openpgp4fpr:)/],
  ['expires','Expires'],
  ['policy','Policy', /^https:/],
  ['preferredLanguages','Preferred-Languages'],
];
function securityTxtRoute(config: SecurityTxtConfig | undefined, { log }: SiteContext): RouteConfig {
  const where = 'site.securityTxt';
  assert(config && typeof config === 'object', `${where} must be an object`);
  assert(Array.isArray(config.contact) && config.contact.length, `${where}.contact must list at least one mailto:, tel: or https: URI`);
  assert(typeof config.expires === 'string' && isoUtc.test(config.expires) && Number.isFinite(Date.parse(config.expires)), `${where}.expires must be a UTC ISO timestamp such as 2027-01-01T00:00:00Z`);
  const expires = Date.parse(config.expires);
  assert(expires > Date.now(), `${where}.expires is in the past; RFC 9116 requires a future expiry`);
  if (expires > Date.now() + 366 * 86400000) log({ event:'site', key:'securityTxt', severity:'warning', message:`${where}.expires is more than a year away; RFC 9116 recommends less than a year` });
  const out: string[] = [];
  for (const [key, field, shape] of securityFields) {
    if (config[key] === undefined) continue;
    const values: unknown[] = key === 'preferredLanguages' ? [config.preferredLanguages] : [config[key]].flat();
    for (const value of values) {
      const text: unknown = key === 'preferredLanguages' ? [value].flat().join(', ') : value;
      assert(typeof text === 'string' && text.length && !/[\s\x00-\x1f\x7f]/u.test(key === 'preferredLanguages' ? text.replaceAll(', ', '') : text), `${where}.${key} values must be single tokens without whitespace`);
      if (shape) assert(shape.test(text), `${where}.${key} value ${JSON.stringify(text)} must be a ${key === 'contact' ? 'mailto:, tel: or https:' : key === 'encryption' ? 'https:, dns: or openpgp4fpr:' : 'https:'} URI`);
      if (key === 'preferredLanguages') assert(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*(?:, [A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*)*$/.test(text), `${where}.preferredLanguages must be language tags`);
      out.push(`${field}: ${text}`);
    }
  }
  return { respond: { text: lines(out) } };
}

// Returns the generated routes, keyed by path, that the project did not
// declare itself. `routes` is the merged route table (entry plus includes).
export async function expandSite(document: ProjectDocument, root: string, { origin, log = () => {}, routes = document.routes ?? {} }: SiteOptions = {}): Promise<Record<string, RouteConfig>> {
  const site = document.site;
  const generated: Record<string, RouteConfig> = Object.create(null) as Record<string, RouteConfig>;
  if (!site) return generated;
  assert(typeof site === 'object' && !Array.isArray(site), 'site must be an object');
  const publicOrigin = checkOrigin(origin);
  const context: SiteContext = { origin: publicOrigin, log };
  const builders: Record<SiteKey, () => RouteConfig | Promise<RouteConfig>> = {
    robots: () => robotsRoute(site.robots, context),
    sitemap: () => sitemapRoute(site.sitemap, routes, root, context),
    favicon: () => faviconRoute(site.favicon),
    securityTxt: () => securityTxtRoute(site.securityTxt, context),
    llms: () => llmsRoute(site.llms),
    notFound: () => notFoundRoute(site.notFound),
  };
  const isSiteKey = (key: string): key is SiteKey => Object.hasOwn(builders, key);
  for (const key of Object.keys(site)) {
    if (!isSiteKey(key)) throw new ConfigError(`site.${key} is not a known site convention (${Object.keys(builders).join(', ')})`);
    const declared: unknown = site[key]; // the schema admits no null or false here; an undeclared key still reads as off
    if (declared === undefined || declared === null || declared === false) continue;
    const path = generatedPaths[key];
    if (Object.hasOwn(routes, path)) { log({ event:'site', key, path, status:'shadowed' }); continue; }
    generated[path] = { ...await builders[key](), description: `generated by site.${key}`, generated: `site.${key}` };
    log({ event:'site', key, path, status:'generated' });
  }
  return generated;
}

// Merges the generated routes into a loaded project in place and returns them.
export async function applySite(loaded: LoadedDocument, options: SiteOptions = {}): Promise<Record<string, RouteConfig>> {
  const generated = await expandSite(loaded.document, loaded.root, { ...options, routes: loaded.routes });
  for (const [path, route] of Object.entries(generated)) loaded.routes[path] = route;
  return generated;
}

// The Worker has no filesystem and no asset binding, so the one not-found page
// is read here and carried inline as a respond route at /404.html. The page is
// bounded and static: no templating, no request data. It is text/html; the
// artifact is JSON, which does the escaping, and a body that is not valid
// UTF-8 is refused rather than silently altered.
export const notFoundInlineLimit = 65536;
export async function inlineNotFound(loaded: LoadedDocument): Promise<boolean> {
  const site = loaded.document.site, path = generatedPaths.notFound;
  const route = loaded.routes[path];
  if (!site?.notFound || route?.generated !== 'site.notFound') return false;
  const file = await safeFile(loaded.root, route.page?.file);
  assert((await stat(file)).size <= notFoundInlineLimit, `site.notFound exceeds ${notFoundInlineLimit} bytes; the Cloudflare Worker carries it inline, so keep the page under 64 KiB`);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)); } catch { throw new ConfigError('site.notFound must be valid UTF-8 to be carried inline in the Worker'); }
  loaded.routes[path] = { respond: { text }, response: { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }, description: route.description ?? 'generated by site.notFound', generated: 'site.notFound' };
  return true;
}
