import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';
import { project, redirect } from './helpers.ts';
import type { ProjectFiles, ProjectRoutes, ProjectSettings } from './helpers.ts';
import { startServer } from '../packages/core/src/server.ts';
import type { ServerOptions } from '../packages/core/src/server.ts';
import { verifyDeployment } from '../packages/core/src/verify-deployment.ts';
import type { VerifyFinding, VerifyOptions, VerifyReport } from '../packages/core/src/verify-deployment.ts';

const cli = fileURLToPath(new URL('../packages/core/src/cli.ts', import.meta.url));
// A project that declares every policy the verifier checks, a site block, a
// respond route large enough to compress, a fixture and a POST-only route.
const body = 'x'.repeat(2048);
const routes: ProjectRoutes = {
  '/go': redirect(), '/text': { respond: { text: body } }, '/only-post': { methods: ['POST'], respond: { text: 'posted' } },
  '/insecure': redirect('http://plain.example/'), '/f': { function: { source: 'f.mjs' } },
};
const policies: ProjectSettings = {
  policies: { security: { headers: 'oshp' }, cache: { strategy: 'public', maxAge: 60 }, throttle: { quota: 1000, window: 60, partition: 'route' }, agents: { deny: ['ai-crawlers'], status: 403 }, compression: { encodings: ['br','gzip'], minBytes: 1024 } },
  site: { robots: { disallow: ['ai-crawlers'], sitemap: true }, securityTxt: { contact: ['mailto:security@example.com'], expires: '2099-01-01T00:00:00Z' } },
};
const files: ProjectFiles = { 'f.mjs': 'export default () => new Response("expected")', 'tests/requests.json': JSON.stringify([{ path: '/f', status: 200, expectBody: 'expected' }]) };
type Started = Awaited<ReturnType<typeof startServer>>;
async function serve(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<{ app: Started; target: string }> {
  // The deployment must know its public origin, as a real one would, or its
  // generated robots.txt omits the Sitemap line the local snapshot carries.
  const first = await startServer({ project: root, port: 0, local: true, log: () => {} });
  const target = `http://127.0.0.1:${first.address.port}`; await first.close();
  // verifyDeployment compares the deployed snapshot's version/route count
  // against the local project, so this fixture models an operator who opted
  // into --health-details on the deployment it verifies (kept behind the
  // proxy restriction documented in docs/OPERATIONS.md).
  const app = await startServer({ project: root, port: first.address.port, local: true, origin: target, log: () => {}, healthDetails: true, ...options });
  t.after(() => app.close()); return { app, target };
}
const verify = (root: string, target: string, options: Partial<VerifyOptions> = {}): Promise<VerifyReport> => verifyDeployment(root, { target, ...options });
const checks = (report: VerifyReport): string[] => [...new Set(report.findings.map(f => f.check))].sort();
const find = (report: VerifyReport, check: VerifyFinding['check']): VerifyFinding[] => report.findings.filter(f => f.check === check);

test('a deployment that serves the local project passes with every check exercised', async t => {
  const root = await project(t, routes, files, policies);
  const { target } = await serve(t, root);
  const report = await verify(root, target);
  assert.deepEqual(report.findings.filter(f => f.severity !== 'low'), []);
  // The plain http: redirect destination is reported low and does not fail the run.
  assert.deepEqual(find(report, 'transport').map(f => [f.severity, f.route]), [['low', '/insecure']]);
  assert.equal(report.pass, true); assert.equal(report.version.observed, report.version.local); assert.equal(report.routes.observed, report.routes.local);
  assert.ok(report.checks > 30 && report.requests > 15 && report.requests < 60, `checks ${report.checks} requests ${report.requests}`);
  assert.equal(report.compliance, null); assert.deepEqual(report.notes, []);
  const strict = await verify(root, target, { failOn: 'low' });
  assert.equal(strict.pass, false);
  const wrongCount = await verify(root, target, { expectRoutes: 3 });
  assert.equal(wrongCount.pass, false); assert.ok(find(wrongCount, 'probes').some(f => f.message.includes('--expect-routes')));
  const compliant = await verify(root, target, { compliance: { profile: 'baseline' } });
  assert.equal(compliant.compliance?.evidence.origin, target); assert.equal(compliant.pass, compliant.compliance?.pass);
});
test('a different snapshot is a high finding on version and route count', async t => {
  const local = await project(t, routes, files, policies);
  const other = await project(t, { '/go': redirect(), '/extra': redirect() }, {}, policies);
  const { target } = await serve(t, other);
  const report = await verify(local, target);
  assert.equal(report.pass, false);
  const probes = find(report, 'probes');
  assert.ok(probes.some(f => f.message.includes('snapshot version') && f.expected === report.version.local && f.observed === report.version.observed));
  assert.ok(probes.some(f => f.message.includes('route count') && f.expected === '7' && f.observed === '4'));
  assert.notEqual(report.version.observed, report.version.local);
});
test('a deployment whose YAML lacks the declared policies is reported per check', async t => {
  const local = await project(t, routes, files, policies);
  const bare = await project(t, routes, files, { site: policies.site });
  const { target } = await serve(t, bare);
  const report = await verify(local, target);
  assert.equal(report.pass, false);
  assert.deepEqual(checks(report), ['agents', 'cache', 'compression', 'errors', 'security', 'throttle', 'transport']);
  const security = find(report, 'security');
  assert.ok(security.some(f => f.route === '/text' && f.expected === 'deny' && f.observed === 'none' && f.message.includes('x-frame-options')));
  assert.ok(security.every(f => f.severity === 'high'));
  assert.ok(find(report, 'errors').some(f => f.message.includes('content-security-policy')));
  assert.deepEqual(find(report, 'agents').map(f => [f.route, f.expected, f.observed]).sort(), [['/.well-known/security.txt', '403', '200'], ['/f', '403', '200'], ['/go', '403', '302'], ['/insecure', '403', '302'], ['/only-post', '403', '405'], ['/robots.txt', '403', '200'], ['/text', '403', '200']]);
  assert.deepEqual(find(report, 'compression').map(f => f.route).sort(), ['/robots.txt', '/text']);
  assert.ok(find(report, 'cache').some(f => f.route === '/text' && f.expected === 'public, max-age=60'));
  assert.ok(find(report, 'throttle').some(f => f.expected === '"default";q=1000;w=60'));
  // Sanity check of the medium/high split: only header-profile findings fail the default gate.
  assert.equal((await verify(local, target, { failOn: 'none' })).pass, true);
});
test('a single unset header, a wrong site body and exposed metrics are found', async t => {
  const local = await project(t, routes, files, policies);
  const unset = await project(t, routes, files, { ...policies, policies: { ...(policies.policies as object), security: { headers: 'oshp', unset: ['Referrer-Policy'] } }, site: { ...(policies.site as object), robots: { disallow: ['/private'] } } });
  const { target } = await serve(t, unset, { metrics: true });
  const report = await verify(local, target);
  const security = find(report, 'security');
  assert.ok(security.every(f => f.message.includes('referrer-policy') && f.expected === 'strict-origin-when-cross-origin' && f.observed === 'none'));
  assert.deepEqual(security.map(f => f.route).sort(), ['/.well-known/security.txt', '/f', '/go', '/insecure', '/only-post', '/robots.txt', '/text']);
  assert.deepEqual(find(report, 'errors').map(f => f.expected), ['strict-origin-when-cross-origin']);
  assert.ok(find(report, 'site').some(f => f.route === '/robots.txt' && f.message.includes('body') && f.observed?.includes('Disallow: /private')));
  assert.ok(find(report, 'probes').some(f => f.message.includes('/_urlcode/metrics') && f.severity === 'high' && f.observed === '200'));
  const expected = await verify(local, target, { expectMetrics: true });
  assert.ok(!find(expected, 'probes').some(f => f.message.includes('metrics')));
});
test('a failing fixture is high and names the case, the route and the statuses', async t => {
  const local = await project(t, routes, files, policies);
  const wrong = await project(t, routes, { ...files, 'f.mjs': 'export default () => new Response("actual", { status: 500 })' }, policies);
  const { target } = await serve(t, wrong);
  const report = await verify(local, target);
  const [failure, ...rest] = find(report, 'fixtures');
  assert.deepEqual(rest, []);
  assert.equal(failure?.severity, 'high'); assert.equal(failure?.route, '/f'); assert.equal(failure?.expected, '200'); assert.equal(failure?.observed, '500');
  assert.match(failure?.message ?? '', /^fixture case \d+ GET \/f/);
});
test('an unreachable target, a bad target and bad options are reported without a run', async t => {
  const root = await project(t, routes, files, policies);
  const report = await verify(root, 'http://127.0.0.1:1', { timeoutMs: 2000 });
  assert.equal(report.pass, false); assert.equal(report.requests, 1); assert.equal(report.version.observed, null);
  assert.deepEqual(find(report, 'transport').map(f => f.observed), ['ECONNREFUSED']);
  await assert.rejects(verify(root, 'https://user:pw@host'), /bare HTTP\(S\) origin/);
  await assert.rejects(verify(root, 'http://127.0.0.1:1/path'));
  await assert.rejects(verify(root, 'http://127.0.0.1:1', { timeoutMs: 1 }), /Timeout/);
  await assert.rejects(verify(root, 'http://127.0.0.1:1', { expectRoutes: 1.5 }), /integer/);
});
// https targets are not exercised here: TLS verification is Node's default
// https.request check; this suite has no trusted certificate to serve and
// --insecure is deliberately absent.
// A minimal project (one plain route, no parameters, no fixtures) so a run
// against these malicious targets is as small as possible. The malicious
// behavior below only applies to the fixed `/_urlcode/*` probes and the
// step-4 unmatched-path probe, which is exactly what `probe()` (the function
// this fix touches) sends; the route-level and generated-case requests
// (sent by the separate, unpatched `hit()` in readiness.ts) get a normal,
// instant reply so this test stays focused on the `probe()` fix.
const minimal: ProjectRoutes = { '/only': { respond: { text: 'ok' } } };
function maliciousProbeTarget(drip: (res: http.ServerResponse) => () => void): http.Server {
  return http.createServer((req, res) => {
    if (!req.url?.startsWith('/_urlcode')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    const stop = drip(res);
    res.on('close', stop);
  });
}
test('a probe fails by its wall-clock deadline even when the deployment keeps the socket busy just under an idle timeout', async t => {
  const root = await project(t, minimal);
  // Each write resets what an *idle* timer would see as activity, so this
  // never goes quiet; only a real overall deadline ends the probe.
  const server = maliciousProbeTarget(res => { const timer = setInterval(() => { try { res.write('x'); } catch { clearInterval(timer); } }, 30); return () => clearInterval(timer); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const start = Date.now();
  const report = await verify(root, target, { timeoutMs: 200 });
  const elapsed = Date.now() - start;
  // Generous ceiling for CI jitter, but far below "never" or "many idle
  // windows": the old idle-only timer would keep this open indefinitely.
  assert.ok(elapsed < 5000, `probe took ${elapsed}ms, expected it to fail near the 200ms deadline`);
  assert.equal(report.pass, false);
  assert.equal(report.version.observed, null);
});
test('an oversized or endless body is cut off at the body limit instead of streaming without bound', async t => {
  const root = await project(t, minimal);
  const chunk = Buffer.alloc(65536, 'x');
  // Far more than BODY_LIMIT (1 MiB) and never ends on its own; a bounded
  // probe must stop reading rather than buffer or wait for EOF.
  const server = maliciousProbeTarget(res => { const timer = setInterval(() => { try { res.write(chunk); } catch { clearInterval(timer); } }, 1); return () => clearInterval(timer); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const start = Date.now();
  const report = await verify(root, target, { timeoutMs: 2000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `probe took ${elapsed}ms, expected the body cap to end it quickly`);
  assert.equal(report.pass, false);
});
test('the CLI exits 1 on findings at or above --fail-on and 0 otherwise', async t => {
  const local = await project(t, routes, files, policies);
  const bare = await project(t, routes, files, { site: policies.site });
  const good = await serve(t, local), bad = await serve(t, bare);
  const run = (...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [cli, 'verify-deployment', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
  const last = (stdout: string): VerifyReport => JSON.parse(stdout.trim().split('\n').at(-1)!) as VerifyReport;
  const pass = await run('--project', local, '--target', good.target, '--expect-routes', '7');
  assert.equal(pass.code, 0, pass.stderr); assert.equal(last(pass.stdout).pass, true);
  const fail = await run('--project', local, '--target', bad.target);
  assert.equal(fail.code, 1); assert.equal(last(fail.stdout).pass, false); assert.ok(fail.stdout.includes('"event":"finding"'));
  const warn = await run('--project', local, '--target', bad.target, '--fail-on', 'none');
  assert.equal(warn.code, 0); assert.equal(last(warn.stdout).failOn, 'none');
  const low = await run('--project', local, '--target', good.target, '--fail-on', 'low');
  assert.equal(low.code, 1);
  for (const args of [['--project', local], ['--project', local, '--target', good.target, '--fail-on', 'severe'], ['--project', local, '--target', good.target, '--timeout-ms', 'soon']]) {
    const bad = await run(...args); assert.equal(bad.code, 1); assert.ok(bad.stderr.includes('"event":"error"'), bad.stderr);
  }
});
