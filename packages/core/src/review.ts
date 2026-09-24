import {readFile} from 'node:fs/promises';
import {relative, sep} from 'node:path';
import {functionFile} from './config.ts';
import {routeFunctions, MODULE_BYTE_LIMIT} from './function-sources.ts';
import {prepare} from './tooling.ts';
import type {InspectOptions} from './tooling.ts';
import {effectivePolicies} from './policies.ts';
import type {RuntimeExtension} from './extensions.ts';

// Read-only static review; see docs/TOOLING.md#project-review.
export type ReviewCategory = 'native-alternative' | 'extension-alternative' | 'gap' | 'manual-review';
export type ReviewSignal = 'manual-body-validation' | 'manual-cookie-session' | 'global-mutable-state' | 'outbound-network-call'
  | 'method-dispatch' | 'manual-rate-limit' | 'manual-security-headers' | 'constant-response';

export interface ReviewObservation {
  category: ReviewCategory; signal: ReviewSignal; routes: string[];
  source: string; line: number; confidence: 'low' | 'medium'; reason: string; excerpt: string;
  capability?: 'request.body' | 'respond' | 'proxy' | 'methods' | 'policies.throttle' | 'policies.security'; extension?: string; note: string;
  /** Set only for an extension-alternative observation when the caller supplied operator registrations (InspectOptions.extensions): whether that extension is actually registered, and, if so, whether the registration is pinned to this project's current revision. Absent when registration state could not be determined (no registrations supplied), in which case `note` stays with the conservative "declared, setup unconfirmed" wording. */
  registered?: boolean; revisionPinned?: boolean;
}
export interface ProjectReview {
  format: 1; projectSha256: string; routeCount: number; moduleCount: number;
  observations: ReviewObservation[]; summary: Record<ReviewCategory, number>;
}

const reviewModuleByteLimit = MODULE_BYTE_LIMIT;
const reviewExcerptLimit = 240;

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
function detectEgress(source: string): Match | undefined {
  const call = /\bfetch\s*\(|\bhttps?\.request\s*\(|\bhttps?\.get\s*\(/.exec(source);
  return call ? locate(source, call.index) : undefined;
}
const methodCompare = /\brequest\s*\.\s*method\s*(?:===|==)\s*(['"])[A-Z]+\1/g;
function detectMethodDispatch(source: string): Match | undefined {
  const compares = [...source.matchAll(methodCompare)];
  if (compares.length >= 2) return locate(source, compares[0]!.index!);
  const dispatch = /switch\s*\(\s*request\s*\.\s*method\s*\)/.exec(source);
  if (!dispatch) return undefined;
  const tail = source.slice(dispatch.index, dispatch.index + 2000);
  const cases = [...tail.matchAll(/case\s+(['"])[A-Z]+\1\s*:/g)];
  return cases.length >= 2 ? locate(source, dispatch.index) : undefined;
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
  const {loaded, projectSha256, routes} = await prepare(project, options);
  const declaredExtensions = new Set(Object.keys(loaded.document.extensions ?? {}));
  interface ModuleInfo { source: string; routes: Set<string>; routesMissingSchema: Set<string>; routesWithThrottle: Set<string>; routesWithSecurity: Set<string>; handlerRoutes: Set<string>; middleware: boolean; boundArgs: boolean }
  const modules = new Map<string, ModuleInfo>();
  for (const route of routes) {
    const declared = loaded.routes[route.pattern];
    if (!declared) continue;
    const hasSchema = declared.request?.body?.schema !== undefined;
    const effective = effectivePolicies(loaded.document, declared);
    const hasThrottle = Boolean(effective.throttle), hasSecurity = Boolean(effective.security);
    for (const definition of routeFunctions(declared)) {
      let absolute: string;
      try { absolute = await functionFile(loaded.root, definition.source); } catch { continue; }
      let info = modules.get(absolute);
      if (!info) { info = {source: '/' + relative(loaded.root, absolute).split(sep).join('/'), routes: new Set(), routesMissingSchema: new Set(), routesWithThrottle: new Set(), routesWithSecurity: new Set(), handlerRoutes: new Set(), middleware: false, boundArgs: false}; modules.set(absolute, info); }
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
  const observations: ReviewObservation[] = [], summary = emptyCategory();
  for (const [absolute, info] of [...modules.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    let source: string;
    try { const text = await readFile(absolute, 'utf8'); source = text.length > reviewModuleByteLimit ? text.slice(0, reviewModuleByteLimit) : text; } catch { continue; }
    const routesList = [...info.routes].sort();
    const push = (match: Match, rest: Omit<ReviewObservation, 'source' | 'line' | 'excerpt'>) => {
      const observation: ReviewObservation = {...rest, source: info.source, line: match.line, excerpt: match.excerpt};
      observations.push(observation); summary[observation.category]++;
    };

    const bodyValidation = detectBodyValidation(source);
    if (bodyValidation && info.routesMissingSchema.size) push(bodyValidation, {
      category: 'native-alternative', signal: 'manual-body-validation', routes: [...info.routesMissingSchema].sort(), confidence: 'medium',
      reason: 'Body parsed (JSON.parse or request.json()) then checked field by field; no request.body.schema.', capability: 'request.body',
      note: 'request.body.schema validates this; see get_capability("request.body").',
    });

    const constant = info.middleware || !info.handlerRoutes.size ? undefined : detectConstantResponse(source, !info.boundArgs);
    if (constant) push(constant, {
      category: 'native-alternative', signal: 'constant-response', routes: [...info.handlerRoutes].sort(), confidence: 'medium',
      reason: 'The handler returns the same literal response for every request; nothing is read from the request or bound per request.', capability: 'respond',
      note: 'respond: {status, json | text} declares this without code, and middleware still wraps a respond route; see get_capability("respond").',
    });

    const cookieSession = detectCookieSession(source);
    if (cookieSession) {
      const authDeclared = declaredExtensions.has('auth');
      const authStatus = authDeclared ? extensionStatus('auth', options.extensions, projectSha256) : undefined;
      push(cookieSession, {
        category: authDeclared ? 'extension-alternative' : 'manual-review', signal: 'manual-cookie-session', routes: routesList, confidence: 'medium',
        reason: 'Hand-built Set-Cookie with session values (id, token, expiry, HttpOnly).',
        ...(authDeclared ? {extension: 'auth'} : {}),
        ...(authStatus?.registered ? {registered: true, revisionPinned: authStatus.revisionPinned} : {}),
        note: authDeclared
          ? authStatus?.registered
            ? authStatus.revisionPinned
              ? 'auth is registered and revision-pinned to this project; hand-built cookies still need a human decision.'
              : 'auth is registered but not revision-pinned to this project\'s current revision; hand-built cookies still need a human decision.'
            : 'auth owns sessions once registered; hand-built cookies still need a human decision.'
          : 'No session extension declared; needs human review (rotation, invalidation).',
      });
    }

    const globalState = detectGlobalState(source);
    if (globalState) {
      const storeDeclared = declaredExtensions.has('store');
      const storeStatus = storeDeclared ? extensionStatus('store', options.extensions, projectSha256) : undefined;
      push(globalState, {
        category: storeDeclared ? 'extension-alternative' : 'gap', signal: 'global-mutable-state', routes: routesList, confidence: 'medium',
        reason: 'Module-scope let/var starts empty, later mutated: local state.',
        ...(storeDeclared ? {extension: 'store'} : {}),
        ...(storeStatus?.registered ? {registered: true, revisionPinned: storeStatus.revisionPinned} : {}),
        note: storeDeclared
          ? storeStatus?.registered
            ? storeStatus.revisionPinned
              ? 'store is registered and revision-pinned to this project; resets on restart, not shared across multiple instances.'
              : 'store is registered but not revision-pinned to this project\'s current revision; resets on restart, not shared across multiple instances.'
            : 'store can own this once registered; resets on restart, not shared across multiple instances.'
          : 'Resets on restart, not shared across multiple instances; no alternative yet: a real gap.',
      });
    }

    const egress = detectEgress(source);
    if (egress) push(egress, {
      category: 'manual-review', signal: 'outbound-network-call', routes: routesList, confidence: 'low',
      reason: 'Direct outbound call (fetch/http(s).request/get) from app code.', capability: 'proxy',
      note: 'proxy/signals centralizes egress but equivalence isn\'t verifiable; review by hand.',
    });

    const methodDispatch = detectMethodDispatch(source);
    if (methodDispatch) push(methodDispatch, {
      category: 'native-alternative', signal: 'method-dispatch', routes: routesList, confidence: 'medium',
      reason: 'Hand-written request.method branching/switch dispatches per-method logic in code.', capability: 'methods',
      note: 'Native routing already dispatches by method; declare one route per method instead of branching on request.method. See get_capability("methods").',
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
  return {format: 1, projectSha256, routeCount: routes.length, moduleCount: modules.size, observations, summary};
}
