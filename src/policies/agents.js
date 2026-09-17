import { assert, ConfigError } from '../errors.js';
import { lists as bundled } from '../../data/agents/index.js';

// User-Agent policy. Contract in src/policies.js. This module also runs inside
// the Cloudflare Worker, so it has no Node imports and never touches the
// filesystem: bundled lists arrive through the generated data/agents/index.js
// and project-relative list files arrive already loaded (src/agent-lists.js
// on Node, or a `resolved` map the build step attaches for the Worker).
export const name = 'agents';
export const phases = ['request'];
export function targets() { return { node:'native', vercel:'native', aws:'native', cloudflare:'compiled' }; }

export const bundledLists = Object.freeze(Object.keys(bundled));
export const MAX_PATTERN_BYTES = 256;
export const MAX_REPEAT = 64;

// The pattern subset: anchors, literals, `.`, escapes, character classes,
// groups, alternation, and quantifiers on a single atom only. Nothing here
// can make a backtracking engine super-linear on the input: no backreferences,
// no lookaround, no quantifier on a group that itself repeats, no unbounded
// counted repetition. A pattern outside the subset is a ConfigError, so a
// project cannot turn the matcher into a ReDoS vector by editing YAML.
const escapeClass = /^[dDwWsSbBtnrfv0]$/;
export function validatePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.length) return 'pattern must be a non-empty string';
  if (new TextEncoder().encode(pattern).length > MAX_PATTERN_BYTES) return `pattern exceeds ${MAX_PATTERN_BYTES} bytes`;
  let i = 0;
  const p = pattern;
  const peek = () => p[i];
  function escape() { // after the backslash
    const c = p[i++];
    if (c === undefined) return 'trailing backslash';
    if (/[1-9]/.test(c) || c === 'k') return 'backreferences are not allowed';
    if (c === 'p' || c === 'P') return 'unicode property escapes are not allowed';
    if (c === 'x') { if (!/^[0-9a-fA-F]{2}$/.test(p.slice(i, i + 2))) return 'bad \\x escape'; i += 2; return; }
    if (c === 'u') { if (!/^[0-9a-fA-F]{4}$/.test(p.slice(i, i + 4))) return 'bad \\u escape'; i += 4; return; }
    if (c === 'c') return 'control escapes are not allowed';
    if (escapeClass.test(c) || /[^A-Za-z0-9]/.test(c)) return;
    return `unknown escape \\${c}`;
  }
  function charClass() { // after '['
    if (peek() === '^') i++;
    let first = true;
    for (;;) {
      const c = p[i++];
      if (c === undefined) return 'unterminated character class';
      if (c === ']' && !first) return;
      first = false;
      if (c === '[') return 'nested character classes are not allowed';
      if (c === '\\') { const err = escape(); if (err) return err; }
    }
  }
  function quantifier() { // returns {ok, err, bounded}
    const c = peek();
    if (c === '*' || c === '+' || c === '?') { i++; }
    else if (c === '{') {
      const m = /^\{(\d{1,3})(?:,(\d{1,3}))?\}/.exec(p.slice(i));
      if (!m) return { err: 'counted repetition must be {n} or {n,m}' };
      const lo = Number(m[1]), hi = m[2] === undefined ? lo : Number(m[2]);
      if (hi < lo) return { err: 'repetition upper bound below lower bound' };
      if (hi > MAX_REPEAT) return { err: `repetition bound above ${MAX_REPEAT}` };
      i += m[0].length;
    } else return { none: true };
    if (/[*+?{]/.test(peek() ?? '')) return { err: 'stacked or lazy quantifiers are not allowed' };
    return {};
  }
  // Parses one alternation; returns {err} or {quantified: boolean} where
  // quantified says whether anything inside carries a quantifier.
  function alternation(depth) {
    let quantified = false;
    for (;;) {
      const c = p[i];
      if (c === undefined || c === '|' || c === ')') return { quantified, end: c };
      i++;
      let atom = 'single';
      if (c === '\\') { const err = escape(); if (err) return { err }; }
      else if (c === '[') { const err = charClass(); if (err) return { err }; }
      else if (c === '(') {
        if (peek() === '?') {
          if (p[i + 1] !== ':') return { err: 'lookaround and named groups are not allowed' };
          i += 2;
        }
        let inner = false;
        for (;;) {
          const r = alternation(depth + 1);
          if (r.err) return r;
          inner = inner || r.quantified;
          if (r.end === '|') { i++; continue; }
          if (r.end === ')') { i++; break; }
          return { err: 'unterminated group' };
        }
        atom = inner ? 'group-quantified' : 'group';
      }
      else if (c === ')') return { err: 'unbalanced parenthesis' };
      else if (c === '^' || c === '$') atom = 'anchor';
      else if (c === '*' || c === '+' || c === '?' || c === '{') {
        if (c === '{') continue; // a literal brace where no quantifier can apply
        return { err: 'quantifier without a preceding atom' };
      }
      const q = quantifier();
      if (q.err) return { err: q.err };
      if (q.none) continue;
      if (atom === 'anchor') return { err: 'quantifier on an anchor' };
      if (atom === 'group-quantified') return { err: 'nested quantifiers are not allowed' };
      if (atom === 'group' && p[i - 1] !== '?') return { err: 'only ? may quantify a group; put * + {n,m} on a single atom' };
      quantified = true;
    }
  }
  for (;;) {
    const r = alternation(0);
    if (r.err) return r.err;
    if (r.end === '|') { i++; continue; }
    if (r.end === ')') return 'unbalanced parenthesis';
    break;
  }
  try { new RegExp(pattern, 'i'); } catch (error) { return `invalid regular expression: ${error.message}`; }
  return undefined;
}

function checkPatterns(entries, where) {
  for (const entry of entries) {
    const problem = validatePattern(entry.pattern);
    if (problem) throw new ConfigError(`${where}: pattern ${JSON.stringify(String(entry.pattern))} rejected (${problem})`);
  }
}

// One RegExp per list, alternated: a single pass over the header per list
// instead of one per pattern, and the list name still known on a hit.
function compileList(label, entries) {
  if (!entries.length) return null;
  const regexp = new RegExp(entries.map(({ pattern }) => `(?:${pattern})`).join('|'), 'i');
  return { label, count: entries.length, regexp };
}

export function isBundled(reference) { return Object.hasOwn(bundled, reference); }
export function isListFile(reference) { return typeof reference === 'string' && reference.endsWith('.json'); }

// Resolves one `deny`/`allow` reference to {label, entries, source}. Bundled
// names come from the generated index; a `.json` reference must be in
// `loaded` (Node: read by src/agent-lists.js; Worker: attached at build).
function resolveReference(reference, loaded, routePattern) {
  if (isBundled(reference)) {
    const list = bundled[reference];
    return { label: reference, entries: list.patterns.map(([entryName, pattern]) => ({ name: entryName, pattern })), source: list.source, revision: list.revision };
  }
  if (isListFile(reference)) {
    const entries = loaded?.[reference];
    assert(Array.isArray(entries), `${routePattern}: policies.agents list ${JSON.stringify(reference)} is not loaded on this target; bundled names are ${bundledLists.join(', ')}`);
    return { label: reference, entries, source: 'project', revision: 'project' };
  }
  throw new ConfigError(`${routePattern}: policies.agents references unknown list ${JSON.stringify(reference)}; bundled names are ${bundledLists.join(', ')}, or give a project-relative path ending in .json`);
}

function build(config, { route, shared, loaded }) {
  assert(config && typeof config === 'object', `policies.${name} on ${route.pattern} must be an object`);
  const where = `${route.pattern} policies.agents`;
  const mode = config.mode ?? 'enforce';
  assert(mode === 'enforce' || mode === 'report', `${where}.mode must be enforce or report`);
  const status = config.status ?? 403;
  assert(Number.isInteger(status) && status >= 400 && status <= 599, `${where}.status must be an integer between 400 and 599`);
  const lists = { deny: [], allow: [] };
  const used = { deny: [], allow: [] };
  for (const side of ['deny', 'allow']) {
    for (const reference of config[side] ?? []) {
      const list = resolveReference(reference, loaded, route.pattern);
      checkPatterns(list.entries, `${where}.${side} list ${JSON.stringify(reference)}`);
      lists[side].push(compileList(list.label, list.entries));
      used[side].push({ name: list.label, patterns: list.entries.length, source: list.source, revision: list.revision });
    }
    const patterns = (config[`${side}Patterns`] ?? []).map(pattern => ({ pattern }));
    checkPatterns(patterns, `${where}.${side}Patterns`);
    const compiled = compileList('pattern', patterns);
    if (compiled) lists[side].push(compiled);
  }
  const state = {
    route: route.pattern, mode, status, denyEmpty: config.denyEmpty === true,
    deny: lists.deny.filter(Boolean), allow: lists.allow.filter(Boolean),
    used, patternCounts: { deny: config.denyPatterns?.length ?? 0, allow: config.allowPatterns?.length ?? 0 },
    log: shared?.log,
  };
  return state;
}

// Synchronous on the Worker (it is called without await there); on Node the
// project-relative list files are read first, so the result is a promise.
export function compile(config, context) {
  const { target, root } = context;
  const files = [...(config?.deny ?? []), ...(config?.allow ?? [])].filter(isListFile);
  if (target === 'cloudflare' || !files.length) return build(config, { ...context, loaded: config?.resolved });
  // Non-literal specifier on purpose: a Worker bundler must not follow this
  // Node-only import; the Worker never reaches this line.
  const loader = '../agent-lists.js';
  return import(loader).then(async ({ loadListFiles }) => build(config, { ...context, loaded: await loadListFiles(files, root, context.route.pattern) }));
}

const encoder = new TextEncoder();
function firstMatch(lists, agent) {
  for (const list of lists) if (list.regexp.test(agent)) return list.label;
  return undefined;
}

export function onRequest(state, request) {
  const agent = request.headers.get('user-agent');
  let list;
  if (agent === null || agent.trim() === '') { if (state.denyEmpty) list = 'empty'; }
  else if (firstMatch(state.allow, agent) === undefined) list = firstMatch(state.deny, agent);
  if (list === undefined) return undefined;
  const denied = state.mode === 'enforce';
  // The list name is logged, never the header: a User-Agent is attacker text.
  try { state.log?.({ event: 'agents', route: state.route, list, outcome: denied ? 'denied' : 'reported' }); } catch { /* logging cannot fail a request */ }
  if (!denied) return undefined;
  return { status: state.status, headers: [['content-type','text/plain; charset=utf-8'],['cache-control','no-store']], body: encoder.encode('Forbidden\n') };
}

export function describe(state) {
  const total = side => state[side].reduce((sum, list) => sum + list.count, 0);
  return { mode: state.mode, status: state.status, denyEmpty: state.denyEmpty,
    deny: state.used.deny, allow: state.used.allow,
    denyPatterns: state.patternCounts.deny, allowPatterns: state.patternCounts.allow,
    patterns: { deny: total('deny'), allow: total('allow') } };
}

export async function close() {}
