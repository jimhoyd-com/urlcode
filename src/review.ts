import {readFile} from 'node:fs/promises';
import {relative, sep} from 'node:path';
import {functionFile} from './config.ts';
import {routeFunctions, MODULE_BYTE_LIMIT} from './function-sources.ts';
import {prepare} from './tooling.ts';
import type {InspectOptions} from './tooling.ts';

// Read-only static review; see docs/TOOLING.md#project-review.
export type ReviewCategory = 'native-alternative' | 'extension-alternative' | 'gap' | 'manual-review';
export type ReviewSignal = 'manual-body-validation' | 'manual-cookie-session' | 'global-mutable-state' | 'outbound-network-call';

export interface ReviewObservation {
  category: ReviewCategory; signal: ReviewSignal; routes: string[];
  source: string; line: number; confidence: 'low' | 'medium'; reason: string; excerpt: string;
  capability?: 'request.body' | 'proxy'; extension?: string; note: string;
}
export interface ProjectReview {
  format: 1; projectSha256: string; routeCount: number; moduleCount: number;
  observations: ReviewObservation[]; summary: Record<ReviewCategory, number>;
}

export const reviewModuleByteLimit = MODULE_BYTE_LIMIT;
export const reviewExcerptLimit = 240;

interface Match { line: number; excerpt: string }
function locate(source: string, at: number): Match {
  const start = Math.max(0, at - 40), end = Math.min(source.length, at + 200);
  return {line: source.slice(0, at).split('\n').length, excerpt: source.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, reviewExcerptLimit)};
}
const bodyHints = [/typeof\s+\w+\s*(!==|===)/, /\brequired\b/i, /\bmissing\b/i, /\binvalid\b/i, /throw\s+new\s+(Error|TypeError)/];
function detectBodyValidation(source: string): Match | undefined {
  const parse = /JSON\.parse\s*\(/.exec(source);
  return parse && bodyHints.filter(re => re.test(source)).length >= 2 ? locate(source, parse.index) : undefined;
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

const emptyCategory = (): Record<ReviewCategory, number> => ({'native-alternative': 0, 'extension-alternative': 0, gap: 0, 'manual-review': 0});

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
      reason: 'JSON.parse plus hand checks; no request.body.schema.', capability: 'request.body',
      note: 'request.body.schema validates this; see get_capability("request.body").',
    });

    const cookieSession = detectCookieSession(source);
    if (cookieSession) {
      const authDeclared = declaredExtensions.has('auth');
      push(cookieSession, {
        category: authDeclared ? 'extension-alternative' : 'manual-review', signal: 'manual-cookie-session', routes: routesList, confidence: 'medium',
        reason: 'Hand-built Set-Cookie with session values (id, token, expiry, HttpOnly).',
        ...(authDeclared ? {extension: 'auth'} : {}),
        note: authDeclared
          ? 'auth owns sessions once registered; hand-built cookies still need a human decision.'
          : 'No session extension declared; needs human review (rotation, invalidation).',
      });
    }

    const globalState = detectGlobalState(source);
    if (globalState) {
      const storeDeclared = declaredExtensions.has('store');
      push(globalState, {
        category: storeDeclared ? 'extension-alternative' : 'gap', signal: 'global-mutable-state', routes: routesList, confidence: 'medium',
        reason: 'Module-scope let/var starts empty, later mutated: local state.',
        ...(storeDeclared ? {extension: 'store'} : {}),
        note: storeDeclared
          ? 'store can own this once registered; resets on restart, not shared across multiple instances.'
          : 'Resets on restart, not shared across multiple instances; no alternative yet: a real gap.',
      });
    }

    const egress = detectEgress(source);
    if (egress) push(egress, {
      category: 'manual-review', signal: 'outbound-network-call', routes: routesList, confidence: 'low',
      reason: 'Direct outbound call (fetch/http(s).request/get) from app code.', capability: 'proxy',
      note: 'proxy/signals centralizes egress but equivalence isn\'t verifiable; review by hand.',
    });
  }
  return {format: 1, projectSha256, routeCount: routes.length, moduleCount: modules.size, observations, summary};
}
