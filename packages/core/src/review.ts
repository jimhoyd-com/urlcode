import type {TrustedDependencyInventory} from './trusted-dependencies.ts';
import {readFile, realpath, stat} from 'node:fs/promises';
import {dirname, extname, isAbsolute, relative, resolve, sep} from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {init as lexerReady, parse as parseImports} from 'es-module-lexer';
import {functionFile} from './config.ts';
import {routeFunctions, MODULE_BYTE_LIMIT} from './function-sources.ts';
import {prepare} from './tooling.ts';
import type {InspectOptions} from './tooling.ts';
import {effectivePolicies} from './policies.ts';
import type {RuntimeExtension} from './extensions.ts';
import {normalizeCapabilityTarget} from './capabilities.ts';
import type {CapabilityTarget} from './capabilities.ts';
import {principalProvidersOf} from './addon-manifest.ts';

// Read-only static review; see docs/TOOLING.md#project-review.
export type ReviewCategory = 'native-alternative' | 'extension-alternative' | 'gap' | 'manual-review';
export type ReviewSignal = 'manual-body-validation' | 'manual-cookie-session' | 'global-mutable-state' | 'outbound-network-call'
  | 'manual-rate-limit' | 'manual-security-headers' | 'constant-response';

export interface ReviewObservation {
  category: ReviewCategory; signal: ReviewSignal; routes: string[];
  source: string; line: number; confidence: 'low' | 'medium'; reason: string; excerpt: string;
  capability?: 'request.body' | 'respond' | 'proxy' | 'policies.throttle' | 'policies.security'; extension?: string; note: string;
  /** Set only for an extension-alternative observation when the caller supplied operator registrations (InspectOptions.extensions): whether that extension is actually registered, and, if so, whether the registration is pinned to this project's current revision. Absent when registration state could not be determined (no registrations supplied), in which case `note` stays with the conservative "declared, setup unconfirmed" wording. */
  registered?: boolean; revisionPinned?: boolean;
  /** Set when `--target` names a target the declared extension does not run on (its registration's targets, or without registrations its urlcode.json descriptor's, #875): the finding falls back to what it would be without the extension. */
  refusedOn?: CapabilityTarget;
  /** Set when `source` is not a route's own module but one it statically imports (#1141): the route modules that import it, directly or through other project modules. */
  importedFrom?: string[];
}
export interface ProjectReview {
  format: 1; projectSha256: string; routeCount: number; moduleCount: number;
  /** Project modules reached through static relative imports of route modules (#1141): how many were read, and how many the depth or file-count cap left unread. `note` is set only when some were not read. */
  imports: {read: number; notRead: number; note?: string};
  trustedDependencies: TrustedDependencyInventory;
  observations: ReviewObservation[]; summary: Record<ReviewCategory, number>;
}

const reviewModuleByteLimit = MODULE_BYTE_LIMIT;
const reviewExcerptLimit = 240;
// Static relative imports are followed this many hops from a route module, and at most this many imported files are read (#1141).
export const REVIEW_IMPORT_DEPTH_LIMIT = 6;
export const REVIEW_IMPORT_FILE_LIMIT = 128;
const followedExtensions = new Set(['.js', '.mjs', '.ts', '.mts']);

/** The project files a module statically imports through a relative specifier (`./`, `../`), static `import`/`export … from` only:
 * never a dynamic import, a package, `node_modules`, a symlink out of the project or another extension. Nothing is executed. */
async function relativeImports(root: string, file: string, code: string): Promise<string[]> {
  await lexerReady;
  let imports: ReturnType<typeof parseImports>[0];
  try { [imports] = parseImports(/\.m?ts$/.test(file) ? stripTypeScriptTypes(code, {mode: 'strip'}) : code); } catch { return []; }
  const found: string[] = [];
  for (const item of imports) {
    if ((item.type !== 'static' && item.type !== 'reexport-star') || !/^\.\.?\//.test(item.specifier) || /[?#]/.test(item.specifier)) continue;
    let target: string;
    try { target = await realpath(resolve(dirname(file), item.specifier)); } catch { continue; }
    const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || rel.split(sep).includes('node_modules') || !followedExtensions.has(extname(target))) continue;
    try { if (!(await stat(target)).isFile()) continue; } catch { continue; }
    if (!found.includes(target)) found.push(target);
  }
  return found;
}

interface Match { line: number; excerpt: string }
function locate(source: string, at: number): Match {
  const start = Math.max(0, at - 40), end = Math.min(source.length, at + 200);
  return {line: source.slice(0, at).split('\n').length, excerpt: source.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, reviewExcerptLimit)};
}
// Field checks after a parse: a type test, a length bound, an array/integer
// guard, a 422 answer or an error word. At least two must follow the parse.
const bodyHints = [/typeof\s+[\w$.]+\s*[!=]==/, /\.length\s*[<>]=?/, /Array\.isArray\s*\(/, /Number\.isInteger\s*\(/, /\b422\b/,
  /\brequired\b/i, /\bmissing\b/i, /\binvalid\b/i, /throw\s+new\s+(Error|TypeError)/];
const identifier = /^[A-Za-z_$][\w$]*$/;
const escapeName = (name: string) => name.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
/** The parse anchor: JSON.parse(, or a no-argument .json() on the incoming request (request, req or the handler's first parameter), never on a response. */
function parseAnchor(source: string): RegExpExecArray | undefined {
  const param = /function\s*[\w$]*\s*\(\s*([A-Za-z_$][\w$]*)|\(\s*([A-Za-z_$][\w$]*)[^()]*\)\s*=>/.exec(source);
  const first = param ? param[1] ?? param[2] : undefined;
  const receivers = [...new Set(['request', 'req', ...(first && identifier.test(first) ? [first] : [])])]
    .filter(name => !/^(?:res|response|upstream)$/i.test(name)).map(escapeName).join('|');
  const anchors = [/JSON\.parse\s*\(/.exec(source), new RegExp(`\\b(?:${receivers})\\s*\\.\\s*json\\s*\\(\\s*\\)`).exec(source)]
    .filter((match): match is RegExpExecArray => match !== null);
  return anchors.sort((a, b) => a.index - b.index)[0];
}
function detectBodyValidation(source: string): Match | undefined {
  const parse = parseAnchor(source);
  if (!parse) return undefined;
  const after = source.slice(parse.index);
  return bodyHints.filter(re => re.test(after)).length >= 2 ? locate(source, parse.index) : undefined;
}
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}
// A handler that builds the same answer for every request: one function, one
// return, no branching or await, nothing read from the request or its context
// except literal YAML args. Middleware (it calls next) never qualifies.
const dynamicHints = /\bawait\b|\bnext\s*\(|\bimport\b|\brequire\s*\(|\bfetch\b|\bDate\b|\bMath\.random\b|\bcrypto\b|\bprocess\b|\bthrow\b|\bif\s*\(|\?|\bswitch\b|\bfor\s*\(|\bwhile\s*\(|\bthis\b|\blet\b|\bvar\b/;
// state/env/secrets/inputs read as an identifier (a property access like
// `context.state`, or a bare reference) are dynamic; the same word as an
// object-literal key (`{state: 'ok'}`) or inside a string is just data and
// must not trip the heuristic (#638).
const contextualHint = /\b(?:state|env|secrets|inputs)\b/g;
function maskLiterals(code: string): string {
  return code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, m => m[0] + ' '.repeat(m.length - 2) + m[0]);
}
function hasDynamicReference(code: string): boolean {
  if (dynamicHints.test(code)) return true;
  const masked = maskLiterals(code);
  for (const match of masked.matchAll(contextualHint)) {
    const after = masked.slice(match.index + match[0].length);
    if (!/^\s*:(?!:)/.test(after)) return true; // not a bare `word:` object-literal key
  }
  return false;
}
function detectConstantResponse(source: string, literalArgs: boolean): Match | undefined {
  const code = stripComments(source);
  if (code.length > 2000 || hasDynamicReference(code)) return undefined;
  const header = /export\s+default\s+function\s*[\w$]*\s*\(([^)]*)\)\s*\{/.exec(code);
  if (!header || (code.match(/\bfunction\b|=>/g) ?? []).length !== 1) return undefined;
  const body = code.slice(header.index + header[0].length);
  const first = header[1]!.split(',')[0]!.trim();
  if (first && identifier.test(first) && new RegExp(`\\b${escapeName(first)}\\b`).test(body)) return undefined;
  if (/\b(?:request|req|context)\b/.test(body) || (/\bargs\b/.test(body) && !literalArgs)) return undefined;
  if ((body.match(/\breturn\b/g) ?? []).length !== 1 || !/\breturn\s+(?:Response\.json\s*\(|new\s+Response\s*\()/.test(body)) return undefined;
  const at = /\breturn\s+(?:Response\.json|new\s+Response)/.exec(source);
  return locate(source, at ? at.index : 0);
}
const cookieHints = [/randomUUID\s*\(/, /randomBytes\s*\(/, /\bsession\b/i, /\btoken\b/i, /expires=/i, /httponly/i];
function detectCookieSession(source: string): Match | undefined {
  const cookie = /set-cookie/i.exec(source);
  return cookie && cookieHints.filter(re => re.test(source)).length >= 2 ? locate(source, cookie.index) : undefined;
}
function detectGlobalState(source: string): Match | undefined {
  const decl = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\[\s*\]|\{\s*\}|new\s+Map\s*\(\s*\)|new\s+Set\s*\(\s*\)|0)\s*;?\s*$/m.exec(source);
  if (!decl) return undefined;
  const name = decl[1]!, mutated = new RegExp(`\\b${name}\\s*(?:\\+\\+|--|\\+=|-=|\\.push\\s*\\(|\\.set\\s*\\(|\\.add\\s*\\(|\\.delete\\s*\\(|\\[[^\\]]*\\]\\s*=)`);
  return mutated.test(source.slice(decl.index + decl[0].length)) ? locate(source, decl.index) : undefined;
}
// Outbound calls (#889 item 7). A global `fetch(...)` (bare, or through globalThis/window/self/global) and
// http(s).request/get always count. A member `x.fetch(...)` is often an in-process framework app (Hono's
// `app.fetch(request)`, itty-router's `router.fetch`), so it is exempt only when `x` is bound in the module to an
// import or to `new`/a call of an imported name. A member call whose first argument is a URL (a string or template
// literal, or `new URL(`) is a client call and always counts. Any other member `.fetch(` is still reported, with
// `uncertain` so the note says it may be in-process.
// A method or function *named* fetch (`fetch(request) {`, `function fetch(`) is a definition, not a call.
const globalReceivers = new Set(['globalThis', 'window', 'self', 'global']);
function maskComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (match, lead: string | undefined) =>
    (lead ?? '') + match.slice((lead ?? '').length).replace(/[^\n]/g, ' '));
}
function closingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')' && --depth === 0) return i;
  }
  return -1;
}
function importedNames(code: string): Set<string> {
  const names = new Set<string>();
  for (const [, clause] of code.matchAll(/\bimport\s+([^'"`;]+?)\s+from\s*['"]/g)) {
    for (const part of clause!.replace(/[{}]/g, ',').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()!.replace(/^\*\s*/, '').trim();
      if (identifier.test(name)) names.add(name);
    }
  }
  return names;
}
/** Whether `name` is an in-process app: an import, or `new X(...)`/`X(...)` (optionally awaited or chained) of an imported X. */
function inProcessApp(code: string, name: string, imported: Set<string>): boolean {
  if (imported.has(name)) return true;
  const declared = new RegExp(`\\b(?:const|let|var)\\s+${escapeName(name)}\\s*=\\s*(?:await\\s+)?(?:new\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`).exec(code);
  return declared !== null && imported.has(declared[1]!);
}
function detectEgress(source: string): (Match & { uncertain: boolean }) | undefined {
  const code = maskComments(source), imported = importedNames(code);
  let uncertain: number | undefined;
  for (const call of code.matchAll(/\bfetch\s*\(|\bhttps?\.(?:request|get)\s*\(/g)) {
    if (!call[0].startsWith('fetch')) return {...locate(source, call.index), uncertain: false};
    const before = code.slice(0, call.index);
    const open = call.index + call[0].length - 1, close = closingParen(code, open);
    const after = close < 0 ? '' : code.slice(close + 1);
    if (/\bfunction\s*\*?\s*$/.test(before) || (/^\s*\{/.test(after) && !/\.\s*$/.test(before))) continue;
    const member = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*$/.exec(before);
    if (!member) return {...locate(source, call.index), uncertain: false};
    const chain = member[1]!.split('.').map(part => part.trim());
    if (globalReceivers.has(chain[0]!) && chain.length === 1) return {...locate(source, call.index), uncertain: false};
    const firstArgument = code.slice(open + 1).trimStart();
    if (/^(?:['"`]|new\s+URL\s*\()/.test(firstArgument)) return {...locate(source, call.index), uncertain: false};
    if (chain.length === 1 && inProcessApp(code, chain[0]!, imported)) continue;
    uncertain ??= call.index;
  }
  return uncertain === undefined ? undefined : {...locate(source, uncertain), uncertain: true};
}
const rateLimitHints = [/\b(?:count|counts|hits|attempts|requests)\w*\s*(?:\+\+|\+=\s*1)/i, /Date\.now\s*\(\)/, /\bwindow\b/i, /\bquota\b/i, /retry-after/i, /too many requests/i];
function detectRateLimit(source: string): Match | undefined {
  const anchor = /\b429\b/.exec(source) ?? /retry-after/i.exec(source);
  return anchor && rateLimitHints.filter(re => re.test(source)).length >= 2 ? locate(source, anchor.index) : undefined;
}
const securityHeaderNames = ['x-frame-options', 'content-security-policy', 'strict-transport-security', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'x-xss-protection'];
function detectSecurityHeaders(source: string): Match | undefined {
  const found = securityHeaderNames.filter(name => new RegExp(name, 'i').test(source));
  if (found.length < 2) return undefined;
  const first = new RegExp(found[0]!, 'i').exec(source)!;
  return locate(source, first.index);
}

const emptyCategory = (): Record<ReviewCategory, number> => ({'native-alternative': 0, 'extension-alternative': 0, gap: 0, 'manual-review': 0});
/** Whether an operator extension is actually registered (not merely declared in YAML), from the caller-supplied registrations
 * (InspectOptions.extensions) that a --host-file/MCP host already loaded; review.ts never loads or executes a host file itself.
 * `undefined` when the caller supplied no registrations at all, meaning registration state is genuinely unconfirmed. */
function extensionStatus(name: string, extensions: readonly Pick<RuntimeExtension, 'name' | 'projectSha256'>[] | undefined, projectSha256: string): {registered: boolean; revisionPinned?: boolean} | undefined {
  if (extensions === undefined) return undefined;
  const registration = extensions.find(item => item.name === name);
  return registration ? {registered: true, revisionPinned: registration.projectSha256 === projectSha256} : {registered: false};
}

export async function reviewProject(project: string, options: InspectOptions = {}): Promise<ProjectReview> {
  const {loaded, projectSha256, routes, declaredTargets, trustedDependencies} = await prepare(project, options);
  const target = options.target === undefined ? undefined : normalizeCapabilityTarget(options.target);
  // An extension that does not run on the requested target is no alternative there (#875); unknown targets stay usable.
  const refusedOn = (name: string): CapabilityTarget | undefined => {
    if (target === undefined) return undefined;
    const targets: readonly string[] | undefined = options.extensions ? options.extensions.find(item => item.name === name)?.targets : declaredTargets?.get(name);
    return targets && !targets.includes(target === 'self-hosted' ? 'node' : target) ? target : undefined;
  };
  const refusedNote = (name: string, refused: CapabilityTarget): string => `${name} is declared but does not run on ${refused} (its declared targets), so it is no alternative there. `;
  const declaredExtensions = new Set(Object.keys(loaded.document.extensions ?? {}));
  // The session hint follows the contract, not a name: the declared extensions that provide a principal.
  const principalProviders = await principalProvidersOf(dirname(loaded.root), [...declaredExtensions], options.extensions);
  interface ModuleInfo { source: string; routes: Set<string>; routesMissingSchema: Set<string>; routesWithThrottle: Set<string>; routesWithSecurity: Set<string>; handlerRoutes: Set<string>; middleware: boolean; boundArgs: boolean; importedFrom: Set<string> }
  const modules = new Map<string, ModuleInfo>();
  for (const route of routes) {
    const declared = loaded.routes[route.pattern];
    if (!declared) continue;
    const hasSchema = Object.values(declared.request?.body ?? {}).some(policy => policy?.schema !== undefined);
    const effective = effectivePolicies(loaded.document, declared);
    const hasThrottle = Boolean(effective.throttle), hasSecurity = Boolean(effective.security);
    for (const definition of routeFunctions(declared)) {
      let absolute: string;
      try { absolute = await functionFile(loaded.root, definition.source); } catch { continue; }
      let info = modules.get(absolute);
      if (!info) { info = {source: '/' + relative(loaded.root, absolute).split(sep).join('/'), routes: new Set(), routesMissingSchema: new Set(), routesWithThrottle: new Set(), routesWithSecurity: new Set(), handlerRoutes: new Set(), middleware: false, boundArgs: false, importedFrom: new Set()}; modules.set(absolute, info); }
      if (declared.function && definition === declared.function) {
        info.handlerRoutes.add(route.pattern);
        // A `{from: …}` arg is bound per request; only literal YAML args keep an answer constant.
        if (Object.values(declared.function.args ?? {}).some(value => value !== null && typeof value === 'object')) info.boundArgs = true;
      } else info.middleware = true;
      info.routes.add(route.pattern);
      if (!hasSchema) info.routesMissingSchema.add(route.pattern);
      if (hasThrottle) info.routesWithThrottle.add(route.pattern);
      if (hasSecurity) info.routesWithSecurity.add(route.pattern);
    }
  }
  const texts = new Map<string, string | undefined>();
  const load = async (absolute: string): Promise<string | undefined> => {
    if (!texts.has(absolute)) {
      try { const text = await readFile(absolute, 'utf8'); texts.set(absolute, text.length > reviewModuleByteLimit ? text.slice(0, reviewModuleByteLimit) : text); } catch { texts.set(absolute, undefined); }
    }
    return texts.get(absolute);
  };
  // Follow static relative imports from each route module (#1141), breadth first, within the depth and file-count caps.
  // An imported module is reviewed for the routes whose modules reach it; a route module stays reviewed for its own routes only.
  const projectRoot = await realpath(loaded.root);
  const entries = [...modules.keys()].sort(), importsOf = new Map<string, string[]>(), readImports = new Set<string>(), unread = new Set<string>();
  for (const entry of entries) {
    const owner = modules.get(entry)!, visited = new Set([entry]);
    let frontier = [entry];
    for (let depth = 1; frontier.length; depth++) {
      const next: string[] = [];
      for (const file of frontier) {
        if (!importsOf.has(file)) { const code = await load(file); importsOf.set(file, code === undefined ? [] : await relativeImports(projectRoot, file, code)); }
        for (const child of importsOf.get(file)!) {
          if (visited.has(child)) continue;
          visited.add(child);
          if (modules.has(child) && !readImports.has(child)) { next.push(child); continue; }
          if (depth > REVIEW_IMPORT_DEPTH_LIMIT || (!readImports.has(child) && readImports.size >= REVIEW_IMPORT_FILE_LIMIT)) { if (!readImports.has(child)) unread.add(child); continue; }
          readImports.add(child); unread.delete(child);
          let info = modules.get(child);
          if (!info) { info = {source: '/' + relative(projectRoot, child).split(sep).join('/'), routes: new Set(), routesMissingSchema: new Set(), routesWithThrottle: new Set(), routesWithSecurity: new Set(), handlerRoutes: new Set(), middleware: false, boundArgs: false, importedFrom: new Set()}; modules.set(child, info); }
          for (const route of owner.routes) info.routes.add(route);
          for (const route of owner.routesMissingSchema) info.routesMissingSchema.add(route);
          for (const route of owner.routesWithThrottle) info.routesWithThrottle.add(route);
          for (const route of owner.routesWithSecurity) info.routesWithSecurity.add(route);
          info.importedFrom.add(owner.source);
          next.push(child);
        }
      }
      frontier = next;
    }
  }
  const observations: ReviewObservation[] = [], summary = emptyCategory();
  for (const [absolute, info] of [...modules.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const source = await load(absolute);
    if (source === undefined) continue;
    const routesList = [...info.routes].sort();
    const push = (match: Match, rest: Omit<ReviewObservation, 'source' | 'line' | 'excerpt'>) => {
      const observation: ReviewObservation = {...rest, source: info.source, line: match.line, excerpt: match.excerpt, ...(info.importedFrom.size ? {importedFrom: [...info.importedFrom].sort()} : {})};
      observations.push(observation); summary[observation.category]++;
    };

    const bodyValidation = detectBodyValidation(source);
    if (bodyValidation && info.routesMissingSchema.size) push(bodyValidation, {
      category: 'native-alternative', signal: 'manual-body-validation', routes: [...info.routesMissingSchema].sort(), confidence: 'medium',
      reason: 'Body parsed (JSON.parse or request.json()) then checked field by field; no request.body.<METHOD>.schema.', capability: 'request.body',
      note: 'request.body.<METHOD>.schema validates this, per method on one path; see get_capability("request.body").',
    });

    const constant = info.middleware || !info.handlerRoutes.size ? undefined : detectConstantResponse(source, !info.boundArgs);
    if (constant) push(constant, {
      category: 'native-alternative', signal: 'constant-response', routes: [...info.handlerRoutes].sort(), confidence: 'medium',
      reason: 'The handler returns the same literal response for every request; nothing is read from the request or bound per request.', capability: 'respond',
      note: 'respond: {status, json | text} declares this without code, and middleware still wraps a respond route; see get_capability("respond").',
    });

    const cookieSession = detectCookieSession(source);
    if (cookieSession) {
      // Providers that do not run on the requested target are no alternative there (#875).
      const usable = principalProviders.filter(name => refusedOn(name) === undefined);
      const refusedProvider = principalProviders.find(name => refusedOn(name) !== undefined);
      const refused = usable.length ? undefined : refusedProvider === undefined ? undefined : refusedOn(refusedProvider);
      const [provider, ...others] = usable;
      const providerStatus = provider !== undefined && !others.length ? extensionStatus(provider, options.extensions, projectSha256) : undefined;
      const gate = `protect the route with auth: true (it expands to policies.extensions.${provider}) and read the signed-in user from the capability ${provider} documents`;
      push(cookieSession, {
        category: provider !== undefined ? 'extension-alternative' : 'manual-review', signal: 'manual-cookie-session', routes: routesList, confidence: 'medium',
        reason: 'Hand-built Set-Cookie with session values (id, token, expiry, HttpOnly).',
        ...(provider !== undefined && !others.length ? {extension: provider} : {}), ...(refused ? {refusedOn: refused} : {}),
        ...(providerStatus?.registered ? {registered: true, revisionPinned: providerStatus.revisionPinned} : {}),
        note: provider === undefined
          ? `${refused ? refusedNote(refusedProvider!, refused) : 'No declared extension provides a principal; '}needs human review (rotation, invalidation).`
          : others.length
            ? `${usable.join(' and ')} each provide a principal and own their sessions; protect the route with policies.extensions.<name> for the one it uses. Hand-built cookies still need a human decision.`
            : providerStatus?.registered
              ? providerStatus.revisionPinned
                ? `${provider} is registered and revision-pinned to this project and provides the request principal, owning sessions and cookies: ${gate}. Hand-built cookies still need a human decision.`
                : `${provider} is registered but not revision-pinned to this project's current revision; once it is, it owns sessions: ${gate}. Hand-built cookies still need a human decision.`
              : `${provider} provides the request principal and owns sessions once registered: ${gate}. Hand-built cookies still need a human decision.`,
      });
    }

    const globalState = detectGlobalState(source);
    if (globalState) {
      // #1052 S6: the store is one owner of durable state, not the only one; an ordinary database library is another.
      const nativeStorage = ' A trusted (non-sandbox) function can instead keep it in an ordinary npm database library it imports (the native path; its data, migrations and backups are then the operator\'s).';
      const storeRefused = declaredExtensions.has('store') ? refusedOn('store') : undefined;
      const storeDeclared = declaredExtensions.has('store') && storeRefused === undefined;
      const storeStatus = storeDeclared ? extensionStatus('store', options.extensions, projectSha256) : undefined;
      push(globalState, {
        category: storeDeclared ? 'extension-alternative' : 'gap', signal: 'global-mutable-state', routes: routesList, confidence: 'medium',
        reason: 'Module-scope let/var starts empty, later mutated: local state.',
        ...(storeDeclared ? {extension: 'store'} : {}), ...(storeRefused ? {refusedOn: storeRefused} : {}),
        ...(storeStatus?.registered ? {registered: true, revisionPinned: storeStatus.revisionPinned} : {}),
        note: `${storeDeclared
          ? storeStatus?.registered
            ? storeStatus.revisionPinned
              ? 'store is registered and revision-pinned to this project; resets on restart, not shared across multiple instances.'
              : 'store is registered but not revision-pinned to this project\'s current revision; resets on restart, not shared across multiple instances.'
            : 'store can own this once registered; resets on restart, not shared across multiple instances.'
          : `${storeRefused ? refusedNote('store', storeRefused) : ''}Resets on restart, not shared across multiple instances; no declared extension owns it: a real gap. A store extension can (the bundled one: urlcode extensions add store).`}${nativeStorage}`,
      });
    }

    const egress = detectEgress(source);
    if (egress) push(egress, {
      category: 'manual-review', signal: 'outbound-network-call', routes: routesList, confidence: 'low',
      reason: egress.uncertain ? 'A .fetch(...) member call whose receiver the review could not identify as an in-process app.' : 'Direct outbound call (fetch/http(s).request/get) from app code.', capability: 'proxy',
      note: (egress.uncertain ? 'It may be an in-process framework app rather than egress; if it is, ignore this. ' : '') + 'proxy/signals centralizes egress but equivalence isn\'t verifiable; review by hand.',
    });

    const rateLimit = detectRateLimit(source);
    if (rateLimit) {
      const declaredRoutes = [...info.routesWithThrottle].sort(), duplicate = declaredRoutes.length > 0;
      push(rateLimit, {
        category: duplicate ? 'manual-review' : 'native-alternative', signal: 'manual-rate-limit',
        routes: duplicate ? declaredRoutes : routesList, confidence: 'medium', capability: 'policies.throttle',
        reason: 'Hand-rolled request counting with a 429/Retry-After response: a rate-limit pattern.',
        note: duplicate
          ? 'policies.throttle is already declared for these routes; hand-rolled counting duplicates the host-enforced quota and needs a human decision to remove one.'
          : 'policies.throttle is not declared for these routes; see get_capability("policies.throttle") for quota/window enforcement without application code.',
      });
    }

    const securityHeaders = detectSecurityHeaders(source);
    if (securityHeaders) {
      const declaredRoutes = [...info.routesWithSecurity].sort(), duplicate = declaredRoutes.length > 0;
      push(securityHeaders, {
        category: duplicate ? 'manual-review' : 'native-alternative', signal: 'manual-security-headers',
        routes: duplicate ? declaredRoutes : routesList, confidence: 'medium', capability: 'policies.security',
        reason: 'Hand-set security response headers (two or more of X-Frame-Options, CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy).',
        note: duplicate
          ? 'policies.security is already declared for these routes; hand-set headers duplicate the host-enforced profile and need a human decision to remove one.'
          : 'policies.security is not declared for these routes; see get_capability("policies.security") for header configuration without application code.',
      });
    }
  }
  const imports: ProjectReview['imports'] = {read: readImports.size, notRead: unread.size, ...(unread.size ? {note: `${unread.size} imported project module${unread.size === 1 ? ' was' : 's were'} not read (review follows static relative imports at most ${REVIEW_IMPORT_DEPTH_LIMIT} hops from a route module and reads at most ${REVIEW_IMPORT_FILE_LIMIT} imported modules)`} : {})};
  return {format: 1, projectSha256, trustedDependencies, routeCount: routes.length, moduleCount: entries.length + readImports.size, imports, observations, summary};
}
