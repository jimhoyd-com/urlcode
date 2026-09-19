import { realpath, stat } from 'node:fs/promises';
import { relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assert, ConfigError } from './errors.ts';
import { loadDocument } from './config.ts';
import { effectivePolicies } from './policies.ts';
import * as baseline from './compliance-rules/baseline.ts';
import * as strict from './compliance-rules/strict.ts';
import * as privacy from './compliance-rules/privacy.ts';
import type { EffectivePolicies, PlanInventoryEntry, PolicyInventory, ProjectDocument, RouteConfig, TestPlan } from './types.ts';

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
export type Severity = 'high' | 'medium' | 'low' | 'info';
export interface Standard { name: string; reference: string; section?: string }
/** What a rule's check returns per finding; severity and route default to the rule's and the context's. */
export interface RawFinding { message: string; remediation: string; severity?: Severity; route?: string }
export interface Finding { rule: string; severity: Severity; route?: string; message: string; remediation: string; standard: Standard }
export type RuleResult = RawFinding[] | RawFinding | null | undefined | false;
/** The host settings under review, null where the operator declared nothing. */
export interface HostSettings { requestLog: 'minimal' | 'detailed' | null }
export interface ProjectContext {
  document: ProjectDocument; routes: Record<string, RouteConfig>; plan: TestPlan; policies: Record<string, EffectivePolicies>;
  origin: string | null; target: string; host: HostSettings;
}
export interface RouteContext extends ProjectContext { route: PlanInventoryEntry; config: RouteConfig; policy: PolicyInventory; effective: EffectivePolicies }
interface RuleBase { id: string; title: string; standard: Standard; severity: Severity }
export interface ProjectRule extends RuleBase { appliesTo: 'project'; check(context: ProjectContext): RuleResult | Promise<RuleResult> }
export interface RouteRule extends RuleBase { appliesTo: 'route'; check(context: RouteContext): RuleResult | Promise<RuleResult> }
export type ComplianceRule = ProjectRule | RouteRule;
/** What an operator rules module exports, after loadComplianceRules checked it. */
export interface ComplianceRules { rules: ComplianceRule[]; disable: string[]; override: Record<string, Partial<ComplianceRule>> }
export interface ComplianceOptions {
  rules?: ComplianceRule[]; profile?: string; ignore?: string[]; origin?: string | null | undefined; target?: string;
  host?: unknown; override?: Record<string, Partial<ComplianceRule>> | undefined; disable?: string[] | undefined;
}
/** The started server or runtime under review: its project root and test plan. */
export interface ComplianceApp { root: string; testPlan(): TestPlan }
export interface ComplianceReport {
  profile: string; rules: number; ruleIds: string[]; ignored: string[]; findings: Finding[]; counts: Record<Severity, number>; pass: boolean;
  evidence: {
    routes: number; active: number; policies: string[]; files: string[];
    origin: string | null; target: string; host: HostSettings; scope: string;
  };
}
export const severities: readonly Severity[] = Object.freeze(['high','medium','low','info']);
export const idPattern = /^[a-z][a-z0-9-]{0,31}\/[a-z][a-z0-9-]{0,63}$/;
const referencePattern = /^(?:https?:\/\/\S+|RFC ?\d{3,5}|docs\/[A-Za-z0-9./-]+\.md)$/;
const hostKeys = ['requestLog'];
const isSeverity = (value: unknown): value is Severity => (severities as readonly unknown[]).includes(value);

export type ComplianceProfileName = typeof baseline.profile | typeof strict.profile | typeof privacy.profile;
const isProfileName = (value: string): value is ComplianceProfileName => Object.hasOwn(builtinProfiles, value);
export const builtinProfiles: Readonly<Record<ComplianceProfileName, readonly ComplianceRule[]>> = Object.freeze({
  [baseline.profile]: baseline.rules,
  [strict.profile]: strict.rules,
  [privacy.profile]: privacy.rules,
});
export const profileNames: readonly string[] = Object.freeze([...Object.keys(builtinProfiles), 'none']);

export function validateRule(rule: unknown): ComplianceRule {
  assert(rule && typeof rule === 'object' && !Array.isArray(rule), 'Compliance rule must be an object');
  const candidate = rule as Record<string, unknown>; // trust boundary: operator code, checked field by field below
  assert(typeof candidate.id === 'string' && idPattern.test(candidate.id), `Compliance rule id ${JSON.stringify(candidate.id)} must be namespaced kebab-case (namespace/name)`);
  const where = `Compliance rule "${candidate.id}"`;
  assert(typeof candidate.title === 'string' && candidate.title.trim().length && candidate.title.length <= 160, `${where} needs a title`);
  const standard = candidate.standard as Record<string, unknown> | null | undefined;
  assert(standard && typeof standard === 'object' && !Array.isArray(standard), `${where} needs a standard { name, reference }`);
  assert(typeof standard.name === 'string' && standard.name.trim().length && standard.name.length <= 120, `${where} standard needs a name`);
  assert(typeof standard.reference === 'string' && referencePattern.test(standard.reference) && standard.reference.length <= 512, `${where} standard.reference must be a URL, an RFC number or a docs/ path`);
  assert(standard.section === undefined || (typeof standard.section === 'string' && standard.section.length <= 120), `${where} standard.section must be a string`);
  assert(isSeverity(candidate.severity), `${where} severity must be one of ${severities.join(', ')}`);
  assert(candidate.appliesTo === 'project' || candidate.appliesTo === 'route', `${where} appliesTo must be project or route`);
  assert(typeof candidate.check === 'function', `${where} check must be a function`);
  return rule as ComplianceRule;
}

export function validateRules(rules: unknown): ComplianceRule[] {
  assert(Array.isArray(rules) && rules.length <= 256, 'Compliance rules must be an array of at most 256 entries');
  const seen = new Set<string>();
  for (const rule of rules as unknown[]) {
    const checked = validateRule(rule);
    assert(!seen.has(checked.id), `Duplicate compliance rule "${checked.id}"`);
    seen.add(checked.id);
  }
  return rules as ComplianceRule[]; // every entry was just checked
}

// The rule set for a run: a built-in profile, plus operator rules applied the
// way a rules module declares them (add, then override, then disable).
export function resolveRules({ profile = 'baseline', rules = [], override = {}, disable = [] }: { profile?: string; rules?: unknown; override?: unknown; disable?: unknown } = {}): ComplianceRule[] {
  assert(profileNames.includes(profile), `Unknown compliance profile "${profile}"; use ${profileNames.join(', ')}`);
  const set = new Map<string, ComplianceRule>((isProfileName(profile) ? builtinProfiles[profile] : []).map(rule => [rule.id, rule]));
  for (const rule of validateRules(rules)) {
    assert(!set.has(rule.id), `Compliance rule "${rule.id}" already exists; use override to change it`);
    set.set(rule.id, rule);
  }
  assert(override && typeof override === 'object' && !Array.isArray(override), 'Compliance override must map rule ids to partial rules');
  for (const [id, partial] of Object.entries(override as Record<string, unknown>)) {
    assert(set.has(id), `Compliance override names unknown rule "${id}"`);
    assert(partial && typeof partial === 'object' && !Array.isArray(partial) && ((partial as { id?: unknown }).id === undefined || (partial as { id?: unknown }).id === id), `Compliance override for "${id}" must be a partial rule with the same id`);
    set.set(id, validateRule({ ...set.get(id), ...partial, id }));
  }
  assert(Array.isArray(disable) && disable.every(id => typeof id === 'string'), 'Compliance disable must list rule ids');
  for (const id of disable as string[]) { assert(set.has(id), `Compliance disable names unknown rule "${id}"`); set.delete(id); }
  return [...set.values()];
}

// Operator rules live outside the project, like the binding policy: they are
// trusted host code and a project must never be able to ship its own verdict.
export async function loadComplianceRules(file: string | undefined, project: string): Promise<ComplianceRules | undefined> {
  if (!file) return undefined;
  assert(isAbsolute(file) && ['.mjs','.js'].includes(file.slice(file.lastIndexOf('.'))), 'Compliance rules must be an absolute path to an ES module (.mjs or .js)');
  const root = await realpath(project), path = await realpath(file);
  const rel = relative(root, path);
  assert(isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep), 'Compliance rules must be outside the application project');
  assert((await stat(path)).isFile() && (await stat(path)).size <= 1048576, 'Compliance rules exceed 1 MiB');
  const module = (await import(pathToFileURL(path).href)) as Record<string, unknown>; // trust boundary: an operator module, checked below
  const rules = module.rules ?? [];
  assert(Array.isArray(rules), 'Compliance rules module must export an array named rules');
  const disable = module.disable ?? [];
  const override = module.override ?? {};
  assert(Array.isArray(disable) && disable.every(id => typeof id === 'string' && idPattern.test(id)), 'Compliance rules module disable must list rule ids');
  assert(override && typeof override === 'object' && !Array.isArray(override), 'Compliance rules module override must map rule ids to partial rules');
  validateRules(rules);
  return { rules: rules as ComplianceRule[], disable: disable as string[], override: override as Record<string, Partial<ComplianceRule>> };
}

function validateHost(host: unknown = {}): HostSettings {
  assert(host && typeof host === 'object' && !Array.isArray(host) && Object.keys(host).every(key => hostKeys.includes(key)), `Compliance host settings accept ${hostKeys.join(', ')}`);
  const { requestLog } = host as { requestLog?: unknown };
  assert(requestLog === undefined || requestLog === 'minimal' || requestLog === 'detailed', 'Compliance host.requestLog must be minimal or detailed');
  return { requestLog: requestLog ?? null };
}

function finding(rule: RuleBase, raw: unknown, route: string | undefined): Finding {
  const candidate = raw as Partial<RawFinding> | null | undefined; // what the rule returned, checked below
  assert(candidate && typeof candidate === 'object' && typeof candidate.message === 'string' && candidate.message.length, `Compliance rule "${rule.id}" returned a finding without a message`);
  assert(typeof candidate.remediation === 'string' && candidate.remediation.length, `Compliance rule "${rule.id}" returned a finding without a remediation`);
  const severity = candidate.severity ?? rule.severity;
  assert(isSeverity(severity), `Compliance rule "${rule.id}" returned an unknown severity`);
  const out: Finding = { rule: rule.id, severity, message: candidate.message, remediation: candidate.remediation, standard: { ...rule.standard } };
  const path = candidate.route ?? route;
  if (path !== undefined) { assert(typeof path === 'string', `Compliance rule "${rule.id}" returned a non-string route`); out.route = path; }
  return out;
}

async function evaluate<C>(rule: RuleBase & { check(context: C): RuleResult | Promise<RuleResult> }, context: C, route?: string): Promise<Finding[]> {
  let result: RuleResult;
  try { result = await rule.check(context); }
  catch (error) { throw new ConfigError(`Compliance rule "${rule.id}" failed: ${(error as { message?: unknown } | null)?.message ?? error}`); }
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
export async function runCompliance(app: ComplianceApp, { rules = [], profile = 'baseline', ignore = [], origin, target = 'node', host, override, disable }: ComplianceOptions = {}): Promise<ComplianceReport> {
  assert(app && typeof app.testPlan === 'function' && typeof app.root === 'string', 'runCompliance needs a started server or runtime');
  assert(Array.isArray(ignore) && ignore.every(id => typeof id === 'string' && idPattern.test(id)), 'Compliance ignore must list rule ids');
  assert(origin === undefined || origin === null || (typeof origin === 'string' && /^https?:\/\/[^/\s]+$/.test(origin)), 'Compliance origin must be a bare HTTP(S) origin');
  const set = resolveRules({ profile, rules, override, disable }).filter(rule => !ignore.includes(rule.id));
  const loaded = await loadDocument(app.root);
  const plan = app.testPlan();
  const policies: Record<string, EffectivePolicies> = {};
  for (const [pattern, config] of Object.entries(loaded.routes)) policies[pattern] = effectivePolicies(loaded.document, config);
  const hostSettings = validateHost(host);
  const base: ProjectContext = { document: loaded.document, routes: loaded.routes, plan, policies, origin: origin ?? null, target, host: hostSettings };
  const findings: Finding[] = [];
  for (const rule of set) {
    if (rule.appliesTo === 'project') { findings.push(...await evaluate(rule, base)); continue; }
    for (const route of plan.inventory) {
      const context: RouteContext = { ...base, route, config: loaded.routes[route.path] ?? {}, policy: plan.policies?.[route.path] ?? {}, effective: policies[route.path] ?? {} };
      findings.push(...await evaluate(rule, context, route.path));
    }
  }
  const order = new Map(severities.map((s, i) => [s, i]));
  findings.sort((a, b) => order.get(a.severity)! - order.get(b.severity)! || a.rule.localeCompare(b.rule) || (a.route ?? '').localeCompare(b.route ?? ''));
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const active = plan.inventory.filter(r => r.state === 'active').length;
  return {
    profile, rules: set.length, ruleIds: set.map(rule => rule.id), ignored: [...ignore], findings, counts, pass: counts.high === 0,
    evidence: {
      routes: plan.inventory.length, active,
      policies: [...new Set(Object.values(policies).flatMap(Object.keys))].sort(),
      files: loaded.files.map(file => relative(loaded.root, file)),
      origin: origin ?? null, target, host: hostSettings,
      scope: 'declared configuration and runtime facts; not a deployment or certification',
    },
  };
}
