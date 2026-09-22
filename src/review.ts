import {readFile} from 'node:fs/promises';
import {relative, sep} from 'node:path';
import {functionFile} from './config.ts';
import {routeFunctions, MODULE_BYTE_LIMIT} from './function-sources.ts';
import {prepare} from './tooling.ts';
import type {InspectOptions} from './tooling.ts';
import type {CapabilityName} from './capabilities.ts';

// A static, read-only review of a compiled project's own function/middleware
// source, looking for a bounded, well-tested set of patterns that duplicate a
// declarative capability, could plausibly be an already-installed extension's
// job, are a genuine current capability gap, or are security/durable-state
// sensitive enough that a human, not this tool, must decide. Nothing here
// executes project code, reads an environment variable or secret, makes a
// network call, or reads outside the project's own root-confined source
// graph. Source text is read only to run bounded regular expressions against
// it and to cut a short excerpt for the report; it is never evaluated,
// imported or treated as instructions.

export type ReviewCategory = 'native-alternative' | 'extension-alternative' | 'gap' | 'manual-review';
export type ReviewSignal = 'manual-body-validation' | 'manual-cookie-session' | 'global-mutable-state' | 'outbound-network-call';

export interface ReviewObservation {
  category: ReviewCategory; signal: ReviewSignal;
  /** Routes whose `function`/`middleware` chain includes the flagged module. */
  routes: string[];
  /** Project-relative module path, `/`-separated, leading slash (matches the manifest's module naming). */
  source: string; line: number;
  confidence: 'low' | 'medium';
  reason: string;
  /** A short, bounded excerpt around the match. Untrusted project text, never executed. */
  excerpt: string;
  capability?: CapabilityName;
  extension?: string;
  note: string;
}
export interface ProjectReview {
  format: 1; projectSha256: string; routeCount: number; moduleCount: number;
  observations: ReviewObservation[];
  summary: Record<ReviewCategory, number>;
}

/** How much of a module's own text this review reads before giving up on it, mirroring
 * the sandbox snapshot's per-module byte budget (src/function-sources.ts) so a review
 * never reads more of a trusted module than the sandboxed path would ever accept. */
export const reviewModuleByteLimit = MODULE_BYTE_LIMIT;
/** Every excerpt this review reports is cut to this many characters. */
export const reviewExcerptLimit = 240;

interface Match { line: number; excerpt: string }
function excerptAround(source: string, index: number): string {
  const start = Math.max(0, index - 40), end = Math.min(source.length, index + 200);
  return source.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, reviewExcerptLimit);
}
function locate(source: string, at: number): Match {
  return {line: source.slice(0, at).split('\n').length, excerpt: excerptAround(source, at)};
}

/** Manual JSON body parsing plus hand-written field validation: the shape `request.body.schema`
 * validates declaratively before the handler runs. Two or more validation hints avoid flagging
 * a bare `JSON.parse` used only to read an already-trusted value. */
function detectBodyValidation(source: string): Match | undefined {
  const parse = /JSON\.parse\s*\(/.exec(source);
  if (!parse) return undefined;
  const hints = [/typeof\s+\w+\s*(!==|===)/, /\brequired\b/i, /\bmissing\b/i, /\binvalid\b/i, /throw\s+new\s+(Error|TypeError)/];
  if (hints.filter(re => re.test(source)).length < 2) return undefined;
  return locate(source, parse.index);
}

/** A `Set-Cookie` header assembled by hand alongside session-shaped values (a random id,
 * `session`/`token` naming, expiry or `HttpOnly` attributes). This is inherently
 * security-sensitive: it is never reported as a `gap` or claimed to be unsafe. */
function detectCookieSession(source: string): Match | undefined {
  const cookie = /set-cookie/i.exec(source);
  if (!cookie) return undefined;
  const hints = [/randomUUID\s*\(/, /randomBytes\s*\(/, /\bsession\b/i, /\btoken\b/i, /expires=/i, /httponly/i];
  if (hints.filter(re => re.test(source)).length < 2) return undefined;
  return locate(source, cookie.index);
}

/** A module-scope `let`/`var` initialized as an empty collection or a counter, later mutated
 * anywhere in the same file. In-process state like this is per-worker and does not survive a
 * restart or stay consistent across multiple instances — the real limitation to report, not a
 * generic warning against globals (a project-scope constant that is only ever read is not this). */
function detectGlobalState(source: string): Match | undefined {
  const decl = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\[\s*\]|\{\s*\}|new\s+Map\s*\(\s*\)|new\s+Set\s*\(\s*\)|0)\s*;?\s*$/m.exec(source);
  if (!decl) return undefined;
  const name = decl[1]!, rest = source.slice(decl.index + decl[0].length);
  const mutated = new RegExp(`\\b${name}\\s*(?:\\+\\+|--|\\+=|-=|\\.push\\s*\\(|\\.set\\s*\\(|\\.add\\s*\\(|\\.delete\\s*\\(|\\[[^\\]]*\\]\\s*=)`);
  if (!mutated.test(rest)) return undefined;
  return locate(source, decl.index);
}

/** A direct outbound call (`fetch`, `http(s).request`, `http(s).get`) from project source.
 * Always `manual-review`: whether the declarative `proxy`/`signals` composition is an
 * equivalent cannot be established statically, and the call target is not verified safe. */
function detectEgress(source: string): Match | undefined {
  const call = /\bfetch\s*\(|\bhttps?\.request\s*\(|\bhttps?\.get\s*\(/.exec(source);
  return call ? locate(source, call.index) : undefined;
}

const emptyCategory = (): Record<ReviewCategory, number> => ({'native-alternative': 0, 'extension-alternative': 0, gap: 0, 'manual-review': 0});

/**
 * Statically review a compiled project's own `function`/`middleware` source for a bounded,
 * conservative set of patterns that a declarative capability or an operator-registered
 * extension may already cover, that are a genuine current gap, or that need a human decision.
 * Read-only: no project code executes, no binding is read, nothing is fetched over the network.
 */
export async function reviewProject(project: string, options: InspectOptions = {}): Promise<ProjectReview> {
  const {loaded, projectSha256, routes} = await prepare(project, options);
  const declaredExtensions = new Set(Object.keys(loaded.document.extensions ?? {}));
  interface ModuleInfo { source: string; routes: Set<string>; routesMissingSchema: Set<string> }
  const modules = new Map<string, ModuleInfo>();
  for (const route of routes) {
    const declared = loaded.routes[route.pattern];
    if (!declared) continue;
    const hasSchema = declared.request?.body?.schema !== undefined;
    for (const definition of routeFunctions(declared)) {
      let absolute: string;
      try { absolute = await functionFile(loaded.root, definition.source); } catch { continue; }
      let info = modules.get(absolute);
      if (!info) { info = {source: '/' + relative(loaded.root, absolute).split(sep).join('/'), routes: new Set(), routesMissingSchema: new Set()}; modules.set(absolute, info); }
      info.routes.add(route.pattern);
      if (!hasSchema) info.routesMissingSchema.add(route.pattern);
    }
  }
  const observations: ReviewObservation[] = [];
  const summary = emptyCategory();
  const push = (observation: ReviewObservation) => { observations.push(observation); summary[observation.category]++; };
  for (const [absolute, info] of [...modules.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    let source: string;
    try { const text = await readFile(absolute, 'utf8'); source = text.length > reviewModuleByteLimit ? text.slice(0, reviewModuleByteLimit) : text; } catch { continue; }
    const routesList = [...info.routes].sort();

    const bodyValidation = detectBodyValidation(source);
    if (bodyValidation && info.routesMissingSchema.size) {
      push({
        category: 'native-alternative', signal: 'manual-body-validation', routes: [...info.routesMissingSchema].sort(),
        source: info.source, line: bodyValidation.line, confidence: 'medium',
        reason: 'The module parses the request body with JSON.parse and hand-writes field-presence/type checks; none of the flagged routes declare request.body.schema.',
        excerpt: bodyValidation.excerpt, capability: 'request.body',
        note: 'request.body.schema validates a JSON body against a bounded JSON Schema before the handler runs, on every target that supports the request.body capability; check get_capability("request.body") and search_recipes for a matching shape before keeping the hand-written check.',
      });
    }

    const cookieSession = detectCookieSession(source);
    if (cookieSession) {
      const authDeclared = declaredExtensions.has('auth');
      push({
        category: authDeclared ? 'extension-alternative' : 'manual-review', signal: 'manual-cookie-session', routes: routesList,
        source: info.source, line: cookieSession.line, confidence: 'medium',
        reason: 'The module assembles a Set-Cookie header alongside session-shaped values (a random id, session/token naming, an expiry or HttpOnly attribute) by hand.',
        excerpt: cookieSession.excerpt, ...(authDeclared ? {extension: 'auth'} : {}),
        note: authDeclared
          ? 'This project declares the auth extension, which owns session issuance, rotation and invalidation when registered and revision-pinned by the operator; a hand-built cookie bypasses that lifecycle even where auth is declared, so this still needs a human decision, not an automatic swap.'
          : 'No extension declaring session/cookie ownership is declared in this project, and trusted code is not judged by default here. Flag for human review of rotation, invalidation and multi-instance consistency before relying on it.',
      });
    }

    const globalState = detectGlobalState(source);
    if (globalState) {
      const storeDeclared = declaredExtensions.has('store');
      push({
        category: storeDeclared ? 'extension-alternative' : 'gap', signal: 'global-mutable-state', routes: routesList,
        source: info.source, line: globalState.line, confidence: 'medium',
        reason: 'A module-scope let/var is initialized as an empty collection or a counter and later mutated in the same file: state that lives only in this process.',
        excerpt: globalState.excerpt, ...(storeDeclared ? {extension: 'store'} : {}),
        note: storeDeclared
          ? 'This project declares the store extension, which can own durable, cross-instance persistence when registered by the operator; the module-scope variable itself does not survive a restart or stay consistent across multiple instances regardless of that declaration, so confirm the extension is actually registered before removing the in-memory state.'
          : 'In-process module state resets on every restart and is not shared across multiple instances or workers; there is currently no native declarative alternative for durable counters or stored collections (see the store extension for an operator-installed one). This is a real capability gap, not a coding mistake to silently patch.',
      });
    }

    const egress = detectEgress(source);
    if (egress) {
      push({
        category: 'manual-review', signal: 'outbound-network-call', routes: routesList,
        source: info.source, line: egress.line, confidence: 'low',
        reason: 'The module makes a direct outbound network call (fetch/http(s).request/http(s).get) from application code.',
        excerpt: egress.excerpt, capability: 'proxy',
        note: 'The declarative proxy/signals composition centralizes egress origin, headers and credential injection for a fixed backend, but whether it is equivalent to this call cannot be established statically (the target, method and payload are runtime values). A sandboxed route also cannot reach the network outside a declared policy. Review the target and any credentials by hand; this tool does not verify egress destinations.',
      });
    }
  }
  return {format: 1, projectSha256, routeCount: routes.length, moduleCount: modules.size, observations, summary};
}
