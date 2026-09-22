import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { project, redirect, param } from './helpers.ts';
import type { ProjectRoutes, ProjectSettings } from './helpers.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { runCompliance } from '../packages/core/src/compliance.ts';
import type { ComplianceOptions } from '../packages/core/src/compliance.ts';

// One small declarative fixture per profile, each tripping named rules, so a
// rule that silently stops firing is caught without the CLI or a sandbox.
async function findings(t: TestContext, routes: ProjectRoutes, options: ComplianceOptions, settings: ProjectSettings = {}) {
  const runtime = await createRuntime(await project(t, routes, {}, settings)); t.after(() => runtime.close());
  const report = await runCompliance(runtime, options);
  return { ids: new Set(report.findings.map(f => f.rule)), report };
}

test('baseline rules fire on unprotected redirects, undeclared caching and missing robots', async t => {
  const { ids, report } = await findings(t, { '/go': redirect(), '/txt': { respond: { text: 'hi' } } }, { profile: 'baseline' });
  for (const id of ['oshp/security-headers','rfc9111/cache-control-declared','rfc9309/robots']) assert.ok(ids.has(id), id);
  assert.ok(report.findings.every(f => f.standard.reference && f.remediation));
  const clean = await findings(t, { '/go': { ...redirect(), response: { headers: { 'Cache-Control': 'no-store' } } }, '/robots.txt': { respond: { text: 'User-agent: *\nDisallow:' }, response: { headers: { 'Cache-Control': 'public, max-age=3600' } } } }, { profile: 'baseline' }, { policies: { security: { headers: 'oshp' } } });
  for (const id of ['oshp/security-headers','rfc9111/cache-control-declared','rfc9309/robots']) assert.ok(!clean.ids.has(id), `${id} cleared`);
});

test('strict rules fire on plain-http redirects, budget-less routes and missing CSP', async t => {
  const { ids } = await findings(t, { '/go': redirect('http://example.com/') }, { profile: 'strict' });
  for (const id of ['rfc9110/redirect-https','rfc6585/throttle-all','oshp/csp']) assert.ok(ids.has(id), id);
  const fixed = await findings(t, { '/go': redirect() }, { profile: 'strict' }, { policies: { security: { headers: 'oshp' }, throttle: { quota: 10, window: 60 } } });
  for (const id of ['rfc9110/redirect-https','rfc6585/throttle-all','oshp/csp']) assert.ok(!fixed.ids.has(id), `${id} cleared`);
});

test('privacy rules read the declared host settings', async t => {
  const routes = { '/p/{id}': { parameters: [param('id')], ...redirect() } };
  const detailed = await findings(t, routes, { profile: 'privacy', host: { requestLog: 'detailed' } });
  for (const id of ['privacy/request-log-minimal','privacy/detailed-log-parameters']) assert.ok(detailed.ids.has(id), id);
  const minimal = await findings(t, routes, { profile: 'privacy', host: { requestLog: 'minimal' } });
  assert.ok(!minimal.ids.has('privacy/request-log-minimal') && !minimal.ids.has('privacy/detailed-log-parameters'));
});
