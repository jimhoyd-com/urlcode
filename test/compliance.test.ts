import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, redirect, param, approveBindings } from './helpers.ts';
import type { ProjectRoutes, ProjectFiles, ProjectSettings } from './helpers.ts';
import type { TestContext } from 'node:test';
import type { SpawnSyncReturns } from 'node:child_process';
import type { RouteConfig } from '../src/types.ts';
import { createRuntime } from '../src/runtime.ts';
import { startServer } from '../src/server.ts';
import { auditProject } from '../src/readiness.ts';
import { runCompliance, builtinProfiles, validateRules, resolveRules, loadComplianceRules, profileNames } from '../src/compliance.ts';
import type { ComplianceOptions, ComplianceProfileName, ComplianceReport, ComplianceRule, Finding, RawFinding, RuleResult } from '../src/compliance.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const cookbook = fileURLToPath(new URL('../examples/cookbook', import.meta.url));
const exampleRules = fileURLToPath(new URL('../examples/compliance/rules.mjs', import.meta.url));
const fn = { function: { source: 'f.mjs' } };
const files = { 'f.mjs': 'export default () => new Response("ok")' };
const secure = { security: { headers: 'oshp' } };

interface Fixture { routes: ProjectRoutes; settings?: ProjectSettings; files?: ProjectFiles; options?: ComplianceOptions }
async function run(t: TestContext, { routes, settings = {}, files: extra = {}, options = {} }: Fixture) {
  const root = await project(t, routes, { ...files, ...extra }, settings);
  const secrets = Object.values(routes).some(route => 'secrets' in route && route.secrets);
  const runtime = await createRuntime(root, secrets ? { permissions: await approveBindings(root), environment: { TOKEN: 'value' } } : {});
  t.after(() => runtime.close());
  return runCompliance(runtime, { profile: 'strict', ...options });
}
const ids = (report: ComplianceReport) => new Set(report.findings.map(f => f.rule));
const profile = (name: ComplianceProfileName): readonly ComplianceRule[] => builtinProfiles[name];
async function outside(t: TestContext, source: string) {
  const dir = await mkdtemp(join(tmpdir(), 'urlcode-rules-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'rules.mjs'); await writeFile(file, source); return file;
}

test('built-in profiles validate and share rules by id', () => {
  for (const [name, rules] of Object.entries(builtinProfiles)) { validateRules(rules); assert.ok(rules.length > 0, name); }
  assert.deepEqual(profileNames, ['baseline', 'strict', 'privacy', 'none']);
  const baseline = new Set(profile('baseline').map(r => r.id));
  assert.ok(profile('strict').every(r => r.severity && r.standard.reference));
  assert.ok([...baseline].every(id => profile('strict').some(r => r.id === id)));
  for (const rules of Object.values(builtinProfiles)) for (const rule of rules) assert.match(rule.id, /^[a-z0-9-]+\/[a-z0-9-]+$/);
  assert.throws(() => validateRules([{ id: 'nonamespace', title: 't', standard: { name: 'n', reference: 'RFC 9110' }, severity: 'high', appliesTo: 'route', check() {} }]), /namespaced/);
  assert.throws(() => validateRules([{ id: 'a/b', title: 't', standard: { name: 'n', reference: 'not a url' }, severity: 'high', appliesTo: 'route', check() {} }]), /reference/);
  assert.throws(() => validateRules([{ id: 'a/b', title: 't', standard: { name: 'n', reference: 'RFC 9110' }, severity: 'urgent', appliesTo: 'route', check() {} }]), /severity/);
  const rule = { id: 'a/b', title: 't', standard: { name: 'n', reference: 'RFC 9110' }, severity: 'high', appliesTo: 'route', check() {} };
  assert.throws(() => validateRules([rule, rule]), /Duplicate/);
  assert.equal(resolveRules({ profile: 'none' }).length, 0);
  assert.throws(() => resolveRules({ profile: 'unknown' }), /Unknown compliance profile/);
});

// One violating and one complying fixture per built-in rule. Fixtures are
// minimal so the other rules' findings do not matter; each case asserts only
// its own rule id in the violating set and its absence in the complying set.
const secretRoute = (extra: RouteConfig): RouteConfig => ({ ...fn, secrets: { KEY: { secret: 'TOKEN' } }, ...extra });
const cases: [string, Fixture, Fixture][] = [
  ['oshp/security-headers', { routes: { '/a': { respond: { text: 'a' } } } }, { routes: { '/a': { respond: { text: 'a' } } }, settings: { policies: secure } }],
  ['oshp/hsts-origin', { routes: { '/a': { respond: { text: 'a' } } }, settings: { policies: secure }, options: { origin: 'http://links.example' } }, { routes: { '/a': { respond: { text: 'a' } } }, settings: { policies: secure }, options: { origin: 'https://links.example' } }],
  ['breach/secrets-compression', { routes: { '/s': secretRoute({ policies: { compression: { allowWithSecrets: true } } }) } }, { routes: { '/s': secretRoute({ policies: { compression: {} } }) } }],
  ['rfc9111/secrets-no-store', { routes: { '/s': secretRoute({ policies: { cache: { strategy: 'public', maxAge: 60 } } }) } }, { routes: { '/s': secretRoute({ policies: { cache: { strategy: 'no-store' } } }) } }],
  ['rfc9111/cache-control-declared', { routes: { '/a': { respond: { text: 'a' } }, '/p': { page: { file: 'p.html' } } }, files: { 'p.html': '<p>' } }, { routes: { '/a': { respond: { text: 'a' }, response: { headers: { 'Cache-Control': 'no-store' } } }, '/p': { page: { file: 'p.html', cacheControl: 'no-cache' } }, '/c': { ...redirect(), policies: { cache: { strategy: 'revalidate' } } } }, files: { 'p.html': '<p>' } }],
  ['rfc6585/throttle-functions', { routes: { '/f': fn } }, { routes: { '/f': { ...fn, policies: { throttle: { quota: 5, window: 60, partition: 'route' } } } } }],
  ['rfc9309/robots', { routes: { '/a': redirect() } }, { routes: { '/a': redirect(), '/robots.txt': { respond: { text: 'User-agent: *\nAllow: /\n' } } } }],
  ['rfc9110/expired-routes', { routes: { '/old': { ...redirect(), expires: '2000-01-01T00:00:00Z' } } }, { routes: { '/new': redirect() } }],
  ['ops/management-private', { routes: { '/a': redirect() }, settings: { dynamicLinks: true } }, { routes: { '/a': redirect() } }],
  ['oshp/csp', { routes: { '/a': { respond: { text: 'a' } } }, settings: { policies: { security: { headers: 'oshp-no-csp' } } } }, { routes: { '/a': { respond: { text: 'a' } } }, settings: { policies: secure } }],
  ['rfc6585/throttle-all', { routes: { '/a': redirect() } }, { routes: { '/a': redirect() }, settings: { policies: { throttle: { quota: 5, window: 60, partition: 'route' } } } }],
  ['agents/lists-pinned', { routes: { '/a': { ...redirect(), policies: { agents: { deny: ['lists/mine.json'] } } } }, files: { 'lists/mine.json': JSON.stringify([{ name: 'x', pattern: '^Foo' }]) } }, { routes: { '/a': { ...redirect(), policies: { agents: { deny: ['ai-crawlers'] } } } } }],
  ['rfc9110/redirect-https', { routes: { '/a': redirect('http://example.com/') } }, { routes: { '/a': redirect('https://example.com/') } }],
  ['http/header-budget', { routes: { '/a': { respond: { text: 'a' }, response: { headers: { 'X-Big-1': 'a'.repeat(4000), 'X-Big-2': 'a'.repeat(4000), 'X-Big-3': 'a'.repeat(1000) } } } } }, { routes: { '/a': { respond: { text: 'a' }, response: { headers: { 'X-Small': 'a' } } } }, settings: { policies: secure } }],
  ['privacy/request-log-minimal', { routes: { '/a': redirect() }, options: { profile: 'privacy', host: { requestLog: 'detailed' } } }, { routes: { '/a': redirect() }, options: { profile: 'privacy', host: { requestLog: 'minimal' } } }],
  ['privacy/link-events-off', { routes: { '/a': redirect() }, settings: { dynamicLinks: true }, options: { profile: 'privacy', host: { linkEvents: true } } }, { routes: { '/a': redirect() }, settings: { dynamicLinks: true }, options: { profile: 'privacy', host: { linkEvents: false } } }],
  ['privacy/detailed-log-parameters', { routes: { '/u/{id}': { parameters: [param('id')], redirect: { url: 'https://example.com/{id}' } } }, options: { profile: 'privacy', host: { requestLog: 'detailed' } } }, { routes: { '/u/{id}': { parameters: [param('id')], redirect: { url: 'https://example.com/{id}' } } }, options: { profile: 'privacy', host: { requestLog: 'minimal' } } }],
];
for (const [id, violating, complying] of cases) {
  test(`rule ${id} fires on a violating project and stays silent on a complying one`, async t => {
    const bad = await run(t, violating), good = await run(t, complying);
    assert.ok(ids(bad).has(id), `expected ${id} in ${[...ids(bad)].join(', ')}`);
    assert.ok(!ids(good).has(id), `did not expect ${id} in ${[...ids(good)].join(', ')}`);
    for (const finding of bad.findings.filter(f => f.rule === id)) {
      assert.ok(finding.message && finding.remediation && finding.standard.reference, 'finding carries message, remediation and reference');
      assert.ok(['high','medium','low','info'].includes(finding.severity));
    }
  });
}
test('every built-in rule is covered by a fixture', () => {
  const covered = new Set(cases.map(([id]) => id));
  for (const rules of Object.values(builtinProfiles)) for (const rule of rules) assert.ok(covered.has(rule.id), `${rule.id} has no fixture`);
});

test('report carries counts, pass on no high, evidence, ignore and undeclared host settings as info', async t => {
  const report = await run(t, { routes: { '/s': secretRoute({ policies: { compression: { allowWithSecrets: true } } }) }, options: { profile: 'privacy', host: {} } });
  assert.equal(report.profile, 'privacy'); assert.equal(report.pass, true);
  assert.deepEqual(report.findings.map(f => [f.rule, f.severity]), [['privacy/request-log-minimal', 'info']]);
  const strict = await run(t, { routes: { '/s': secretRoute({ policies: { compression: { allowWithSecrets: true } } }) } });
  assert.equal(strict.pass, false); assert.equal(strict.counts.high, 1); assert.equal(strict.rules, profile('strict').length);
  assert.equal(strict.findings[0]?.severity, 'high'); assert.equal(strict.findings[0]?.route, '/s');
  assert.equal(strict.evidence.routes, 1); assert.deepEqual(strict.evidence.files, ['urlcode.yaml']); assert.deepEqual(strict.evidence.policies, ['compression']);
  const ignored = await run(t, { routes: { '/s': secretRoute({ policies: { compression: { allowWithSecrets: true } } }) }, options: { ignore: ['breach/secrets-compression'] } });
  assert.equal(ignored.pass, true); assert.deepEqual(ignored.ignored, ['breach/secrets-compression']); assert.equal(ignored.rules, profile('strict').length - 1);
  const linkless = await run(t, { routes: { '/a': redirect() }, settings: { dynamicLinks: true }, options: { profile: 'privacy', host: { linkEvents: true, includeCode: true } } });
  assert.equal(linkless.findings.find(f => f.rule === 'privacy/link-events-off')?.severity, 'high'); assert.equal(linkless.pass, false);
  await assert.rejects(run(t, { routes: { '/a': redirect() }, options: { host: { requestLog: 'verbose' } } }), /requestLog/);
  await assert.rejects(run(t, { routes: { '/a': redirect() }, options: { origin: 'https://x/path' } }), /origin/);
});

test('a custom rules module adds, overrides and disables rules; a throwing rule is reported', async t => {
  const file = await outside(t, `export const rules = [{ id: 'acme/no-go', title: 'No /go', standard: { name: 'ACME', reference: 'https://example.com/acme' }, severity: 'high', appliesTo: 'route',
    check({ route }) { return route.path === '/go' ? [{ message: 'go is reserved', remediation: 'rename' }] : []; } }];
    export const disable = ['rfc9309/robots'];
    export const override = { 'oshp/security-headers': { severity: 'high' } };`);
  const root = await project(t, { '/go': redirect() });
  const operator = await loadComplianceRules(file, root);
  assert.ok(operator, 'the rules module loaded nothing'); assert.equal(operator.rules.length, 1); assert.deepEqual(operator.disable, ['rfc9309/robots']);
  const runtime = await createRuntime(root); t.after(() => runtime.close());
  const report = await runCompliance(runtime, { profile: 'baseline', ...operator });
  assert.ok(report.ruleIds.includes('acme/no-go')); assert.ok(!report.ruleIds.includes('rfc9309/robots'));
  assert.equal(report.findings.find(f => f.rule === 'acme/no-go')?.route, '/go');
  assert.equal(report.findings.find(f => f.rule === 'oshp/security-headers')?.severity, 'high');
  assert.equal(report.pass, false);
  assert.throws(() => resolveRules({ profile: 'none', rules: operator.rules, override: { 'acme/no-go': { severity: 'loud' } } }), /severity/);
  assert.throws(() => resolveRules({ profile: 'none', disable: ['nope/nope'] }), /unknown rule/);
  assert.throws(() => resolveRules({ profile: 'baseline', rules: [{ ...profile('baseline')[0] }] }), /already exists/);
  await assert.rejects(runCompliance(runtime, { profile: 'none', rules: [{ id: 'acme/boom', title: 'b', standard: { name: 'n', reference: 'RFC 9110' }, severity: 'low', appliesTo: 'project', check() { throw new Error('bad'); } }] }), /acme\/boom.*bad/);
  await assert.rejects(runCompliance(runtime, { profile: 'none', rules: [{ id: 'acme/bare', title: 'b', standard: { name: 'n', reference: 'RFC 9110' }, severity: 'low', appliesTo: 'project', check(): RuleResult { return [{ message: 'x' } as RawFinding]; /* deliberately missing remediation: the runner must reject it */ } }] }), /remediation/);
});

test('rules inside the project are refused; relative paths and non-modules too', async t => {
  const root = await project(t, { '/go': redirect() }, { 'rules.mjs': 'export const rules = [];', 'nested/rules.mjs': 'export const rules = [];' });
  await assert.rejects(loadComplianceRules(join(root, 'rules.mjs'), root), /outside the application project/);
  await assert.rejects(loadComplianceRules(join(root, 'nested/rules.mjs'), root), /outside the application project/);
  await assert.rejects(loadComplianceRules('rules.mjs', root), /absolute path/);
  await assert.rejects(loadComplianceRules('/rules.json', root), /absolute path/);
  const bad = await outside(t, 'export const rules = { not: "an array" };');
  await assert.rejects(loadComplianceRules(bad, root), /array named rules/);
  assert.equal(await loadComplianceRules(undefined, root), undefined);
});

test('auditProject reports compliance beside readiness and null without options', async t => {
  const root = await project(t, { '/go': redirect() });
  const app = await startServer({ project: root, port: 0, log: () => {} }); t.after(() => app.close());
  const plain = await auditProject(app); assert.equal(plain.compliance, null); assert.equal(plain.ready, true);
  const audited = await auditProject(app, { compliance: { profile: 'baseline', host: { requestLog: 'minimal' } } });
  assert.equal(audited.ready, true); assert.ok(audited.compliance, 'no compliance report'); assert.equal(audited.compliance.profile, 'baseline'); assert.equal(typeof audited.compliance.pass, 'boolean');
});

test('audit CLI runs compliance on the cookbook, exits per severity and keeps --compliance-warn at 0', () => {
  const cliRun = (...args: string[]) => spawnSync(process.execPath, [cli, 'audit', '--project', cookbook, ...args], { encoding: 'utf8', timeout: 60000 });
  // The CLI prints the audit report as JSON; it is read back with the shape auditProject returns.
  interface AuditJson { ready: boolean; compliance: ComplianceReport | null }
  const last = (result: SpawnSyncReturns<string>): AuditJson => JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '') as AuditJson;
  const compliance = (result: SpawnSyncReturns<string>): ComplianceReport => { const report = last(result).compliance; assert.ok(report, 'no compliance report in the audit output'); return report; };
  const plain = cliRun(); assert.equal(plain.status, 0); assert.equal(last(plain).compliance, null);
  const baseline = cliRun('--compliance', 'baseline');
  assert.equal(baseline.status, 0);
  const report = compliance(baseline);
  assert.equal(report.profile, 'baseline'); assert.equal(report.pass, true); assert.equal(report.counts.high, 0);
  assert.ok(report.findings.some((f: Finding) => f.rule === 'rfc9110/expired-routes'));
  assert.ok(report.findings.every((f: Finding) => f.standard.reference && f.remediation));
  assert.deepEqual(report.evidence.host, { requestLog: 'minimal', linkEvents: false, includeCode: null });
  const failing = cliRun('--compliance', 'baseline', '--compliance-rules', exampleRules);
  assert.equal(failing.status, 1); assert.equal(last(failing).ready, true); assert.equal(compliance(failing).pass, false);
  assert.ok(compliance(failing).ruleIds.includes('acme/redirect-hosts')); assert.ok(!compliance(failing).ruleIds.includes('rfc9110/expired-routes'));
  const warned = cliRun('--compliance', 'baseline', '--compliance-rules', exampleRules, '--compliance-warn');
  assert.equal(warned.status, 0); assert.equal(compliance(warned).pass, false);
  const ignored = cliRun('--compliance-rules', exampleRules, '--compliance-ignore', 'oshp/security-headers,acme/redirect-hosts');
  assert.equal(ignored.status, 0); assert.equal(compliance(ignored).profile, 'baseline'); assert.equal(compliance(ignored).pass, true);
  const privacy = cliRun('--compliance', 'privacy', '--request-log', 'detailed');
  assert.equal(privacy.status, 0); assert.ok(compliance(privacy).findings.some(f => f.rule === 'privacy/detailed-log-parameters'));
  for (const args of [['--compliance', 'lax'], ['--compliance-rules', join(cookbook, 'urlcode.yaml')], ['--compliance-ignore', 'not-namespaced'], ['--compliance', 'baseline', '--request-log', 'verbose']]) {
    const result = cliRun(...args); assert.equal(result.status, 1, args.join(' ')); assert.equal((JSON.parse(result.stderr) as { event?: unknown }).event, 'error');
  }
});
