import { realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, ConfigError } from './errors.ts';
import { loadDocument } from './config.ts';
import { effectivePolicies } from './policies.ts';
import * as baseline from './compliance-rules/baseline.ts';
import * as strict from './compliance-rules/strict.ts';
import * as privacy from './compliance-rules/privacy.ts';

// Compliance rules: standards-referenced checks over a project's declared
// configuration and the runtime's own facts (the test plan, the effective
// policy per route, the origin and host settings the operator states). The
// contract mirrors host plugins: the runtime ships built-in rules, an operator
// adds or overrides rules with code kept outside the project, and the CLI
// reports pass/fail with the reference each finding rests on. A rule never
// sends a request, reads a binding or runs guest code; it only reads what
// `runCompliance` hands it. A passing run is not a certification of a
// deployment: it says the declared configuration matches the rule set.
//
//   { id: 'oshp/hsts',                       kebab-case, namespaced
//     title,
//     standard: { name, reference, section? }, reference is a URL or an RFC
//     severity: 'high' | 'medium' | 'low' | 'info',
//     appliesTo: 'project' | 'route',
//     check(context) → findings[] }
//
// Project context: { document, routes, plan, policies, origin, target, host }
// Route context adds: { route (inventory entry), config (YAML), policy
// (describe map), effective (effectivePolicies for the route) }.
// A finding: { rule, severity, route?, message, remediation, standard }.
export const severities = Object.freeze(['high','medium','low','info']);
export const idPattern = /^[a-z][a-z0-9-]{0,31}\/[a-z][a-z0-9-]{0,63}$/;
const referencePattern = /^(?:https?:\/\/\S+|RFC ?\d{3,5}|docs\/[A-Za-z0-9./-]+\.md)$/;
const hostKeys = ['requestLog','linkEvents','includeCode'];

export const builtinProfiles = Object.freeze({
  [baseline.profile]: baseline.rules,
  [strict.profile]: strict.rules,
  [privacy.profile]: privacy.rules,
});
export const profileNames = Object.freeze([...Object.keys(builtinProfiles), 'none']);

export function validateRule(rule) {
  assert(rule && typeof rule === 'object' && !Array.isArray(rule), 'Compliance rule must be an object');
  assert(typeof rule.id === 'string' && idPattern.test(rule.id), `Compliance rule id ${JSON.stringify(rule.id)} must be namespaced kebab-case (namespace/name)`);
  const where = `Compliance rule "${rule.id}"`;
  assert(typeof rule.title === 'string' && rule.title.trim().length && rule.title.length <= 160, `${where} needs a title`);
  const standard = rule.standard;
  assert(standard && typeof standard === 'object' && !Array.isArray(standard), `${where} needs a standard { name, reference }`);
  assert(typeof standard.name === 'string' && standard.name.trim().length && standard.name.length <= 120, `${where} standard needs a name`);
  assert(typeof standard.reference === 'string' && referencePattern.test(standard.reference) && standard.reference.length <= 512, `${where} standard.reference must be a URL, an RFC number or a docs/ path`);
  assert(standard.section === undefined || (typeof standard.section === 'string' && standard.section.length <= 120), `${where} standard.section must be a string`);
  assert(severities.includes(rule.severity), `${where} severity must be one of ${severities.join(', ')}`);
  assert(rule.appliesTo === 'project' || rule.appliesTo === 'route', `${where} appliesTo must be project or route`);
  assert(typeof rule.check === 'function', `${where} check must be a function`);
  return rule;
}

export function validateRules(rules) {
  assert(Array.isArray(rules) && rules.length <= 256, 'Compliance rules must be an array of at most 256 entries');
  const seen = new Set();
  for (const rule of rules) {
    validateRule(rule);
    assert(!seen.has(rule.id), `Duplicate compliance rule "${rule.id}"`);
    seen.add(rule.id);
  }
  return rules;
}

// The rule set for a run: a built-in profile, plus operator rules applied the
// way a rules module declares them (add, then override, then disable).
export function resolveRules({ profile = 'baseline', rules = [], override = {}, disable = [] } = {}) {
  assert(profileNames.includes(profile), `Unknown compliance profile "${profile}"; use ${profileNames.join(', ')}`);
  const set = new Map((profile === 'none' ? [] : builtinProfiles[profile]).map(rule => [rule.id, rule]));
  for (const rule of validateRules(rules)) {
    assert(!set.has(rule.id), `Compliance rule "${rule.id}" already exists; use override to change it`);
    set.set(rule.id, rule);
  }
  assert(override && typeof override === 'object' && !Array.isArray(override), 'Compliance override must map rule ids to partial rules');
  for (const [id, partial] of Object.entries(override)) {
    assert(set.has(id), `Compliance override names unknown rule "${id}"`);
    assert(partial && typeof partial === 'object' && !Array.isArray(partial) && (partial.id === undefined || partial.id === id), `Compliance override for "${id}" must be a partial rule with the same id`);
    set.set(id, validateRule({ ...set.get(id), ...partial, id }));
  }
  assert(Array.isArray(disable) && disable.every(id => typeof id === 'string'), 'Compliance disable must list rule ids');
  for (const id of disable) { assert(set.has(id), `Compliance disable names unknown rule "${id}"`); set.delete(id); }
  return [...set.values()];
}

// Operator rules live outside the project, like the binding policy: they are
// trusted host code and a project must never be able to ship its own verdict.
export async function loadComplianceRules(file, project) {
  if (!file) return undefined;
  assert(isAbsolute(file) && ['.mjs','.js'].includes(file.slice(file.lastIndexOf('.'))), 'Compliance rules must be an absolute path to an ES module (.mjs or .js)');
  const root = await realpath(project), path = await realpath(file);
  const rel = relative(root, path);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep), 'Compliance rules must be outside the application project');
  assert((await stat(path)).isFile() && (await stat(path)).size <= 1048576, 'Compliance rules exceed 1 MiB');
  const module = await import(pathToFileURL(path).href);
  const rules = module.rules ?? [];
  assert(Array.isArray(rules), 'Compliance rules module must export an array named rules');
  const disable = module.disable ?? [];
  const override = module.override ?? {};
  assert(Array.isArray(disable) && disable.every(id => typeof id === 'string' && idPattern.test(id)), 'Compliance rules module disable must list rule ids');
  assert(override && typeof override === 'object' && !Array.isArray(override), 'Compliance rules module override must map rule ids to partial rules');
  validateRules(rules);
  return { rules, disable, override };
}

function validateHost(host = {}) {
  assert(host && typeof host === 'object' && !Array.isArray(host) && Object.keys(host).every(key => hostKeys.includes(key)), `Compliance host settings accept ${hostKeys.join(', ')}`);
  assert(host.requestLog === undefined || ['minimal','detailed'].includes(host.requestLog), 'Compliance host.requestLog must be minimal or detailed');
  assert(host.linkEvents === undefined || typeof host.linkEvents === 'boolean', 'Compliance host.linkEvents must be a boolean');
  assert(host.includeCode === undefined || typeof host.includeCode === 'boolean', 'Compliance host.includeCode must be a boolean');
  return { requestLog: host.requestLog ?? null, linkEvents: host.linkEvents ?? null, includeCode: host.includeCode ?? null };
}

function finding(rule, raw, route) {
  assert(raw && typeof raw === 'object' && typeof raw.message === 'string' && raw.message.length, `Compliance rule "${rule.id}" returned a finding without a message`);
  assert(typeof raw.remediation === 'string' && raw.remediation.length, `Compliance rule "${rule.id}" returned a finding without a remediation`);
  const severity = raw.severity ?? rule.severity;
  assert(severities.includes(severity), `Compliance rule "${rule.id}" returned an unknown severity`);
  const out = { rule: rule.id, severity, message: raw.message, remediation: raw.remediation, standard: { ...rule.standard } };
  const path = raw.route ?? route;
  if (path !== undefined) { assert(typeof path === 'string', `Compliance rule "${rule.id}" returned a non-string route`); out.route = path; }
  return out;
}

async function evaluate(rule, context, route) {
  let result;
  try { result = await rule.check(context); }
  catch (error) { throw new ConfigError(`Compliance rule "${rule.id}" failed: ${error?.message ?? error}`); }
  if (result === undefined || result === null || result === false) return [];
  const list = Array.isArray(result) ? result : [result];
  assert(list.length <= 1000, `Compliance rule "${rule.id}" returned too many findings`);
  return list.map(raw => finding(rule, raw, route));
}

// Runs a rule set against a started server or a runtime. Both expose `root`
// and `testPlan()`; the YAML is re-read from the root so rules see what the
// runtime compiled rather than a copy an operator could hand in. `origin` is
// the public origin the operator declares (never a forwarded header) and
// `host` the logging settings of the deployment under review; both are
// evidence, so the report echoes them.
export async function runCompliance(app, { rules = [], profile = 'baseline', ignore = [], origin, target = 'node', host, override, disable } = {}) {
  assert(app && typeof app.testPlan === 'function' && typeof app.root === 'string', 'runCompliance needs a started server or runtime');
  assert(Array.isArray(ignore) && ignore.every(id => typeof id === 'string' && idPattern.test(id)), 'Compliance ignore must list rule ids');
  assert(origin === undefined || origin === null || (typeof origin === 'string' && /^https?:\/\/[^/\s]+$/.test(origin)), 'Compliance origin must be a bare HTTP(S) origin');
  const set = resolveRules({ profile, rules, override, disable }).filter(rule => !ignore.includes(rule.id));
  const loaded = await loadDocument(app.root);
  const plan = app.testPlan();
  const policies = {};
  for (const [pattern, config] of Object.entries(loaded.routes)) policies[pattern] = effectivePolicies(loaded.document, config);
  const hostSettings = validateHost(host);
  const base = { document: loaded.document, routes: loaded.routes, plan, policies, origin: origin ?? null, target, host: hostSettings };
  const findings = [];
  for (const rule of set) {
    if (rule.appliesTo === 'project') { findings.push(...await evaluate(rule, base)); continue; }
    for (const route of plan.inventory) {
      const context = { ...base, route, config: loaded.routes[route.path] ?? {}, policy: plan.policies?.[route.path] ?? {}, effective: policies[route.path] ?? {} };
      findings.push(...await evaluate(rule, context, route.path));
    }
  }
  const order = new Map(severities.map((s, i) => [s, i]));
  findings.sort((a, b) => order.get(a.severity) - order.get(b.severity) || a.rule.localeCompare(b.rule) || (a.route ?? '').localeCompare(b.route ?? ''));
  const counts = Object.fromEntries(severities.map(s => [s, 0]));
  for (const f of findings) counts[f.severity]++;
  const active = plan.inventory.filter(r => r.state === 'active').length;
  return {
    profile, rules: set.length, ruleIds: set.map(rule => rule.id), ignored: [...ignore], findings, counts, pass: counts.high === 0,
    evidence: {
      routes: plan.inventory.length, active, dynamicLinks: plan.dynamicLinks === true,
      policies: [...new Set(Object.values(policies).flatMap(Object.keys))].sort(),
      files: loaded.files.map(file => relative(loaded.root, file)),
      origin: origin ?? null, target, host: hostSettings,
      scope: 'declared configuration and runtime facts; not a deployment or certification',
    },
  };
}
