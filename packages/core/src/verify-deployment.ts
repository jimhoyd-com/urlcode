import { request, Agent } from 'node:http';
import type { IncomingMessage, ClientRequest, RequestOptions } from 'node:http';
import { request as secureRequest, Agent as SecureAgent } from 'node:https';
import { randomBytes } from 'node:crypto';
import { assert } from './errors.ts';
import { isRecord } from './object-guards.ts';
import { createRuntime } from './runtime.ts';
import type { RuntimeOptions } from './runtime.ts';
import { benchmarkTarget, hit, readFixtures, runFixtures, isStepsFixture, probeAgent } from './readiness.ts';
import type { AuditableApp, BenchmarkTarget, RequestCase } from './readiness.ts';
import { runCompliance, severities } from './compliance.ts';
import type { ComplianceOptions, ComplianceReport, Severity } from './compliance.ts';
import { loadDocument } from './config.ts';
import { applySite } from './site.ts';
import { effectivePolicies, compileErrorPolicy, errorHeaders } from './policies.ts';
import * as security from './policies/security.ts';
import { DEFAULT_TYPES as compressibleTypes } from './policies/compression.ts';
import { lists as bundledAgents } from '../../../data/agents/index.js';
import type { HeaderPair } from './http-response.ts';
import type { LogFn, PolicyInventory, RouteConfig } from './types.ts';

// Deployment verification: does the running deployment behind `--target`
// match what this project declares? Everything here is inferred from HTTP
// responses to a bounded set of requests. There is no infrastructure access,
// no credential and no `--insecure`: a certificate Node rejects is a finding,
// not an option. A passing run says the deployment answers the way the local
// snapshot would; it says nothing about the host, the proxy or the network.
export type { Severity } from './compliance.ts';
export type FailOn = Severity | 'none';
export type CheckName = 'probes' | 'fixtures' | 'security' | 'cache' | 'compression' | 'agents' | 'throttle' | 'site' | 'methods' | 'errors' | 'head' | 'transport';
export interface VerifyFinding { check: CheckName; severity: Severity; route?: string; message: string; expected?: string; observed?: string }
export interface VerifyOptions extends Pick<RuntimeOptions, 'permissions'> {
  target: string; origin?: string | undefined; expectRoutes?: number | undefined; timeoutMs?: number | undefined; expectMetrics?: boolean | undefined;
  failOn?: FailOn | undefined; compliance?: ComplianceOptions | undefined; complianceWarn?: boolean | undefined; log?: LogFn | undefined;
}
export interface VerifyReport {
  target: string; version: { local: string; observed: string | null }; routes: { local: number; observed: number | null; expected: number | null };
  requests: number; checks: number; findings: VerifyFinding[]; counts: Record<Severity, number>; notes: string[];
  failOn: FailOn; pass: boolean; compliance: ComplianceReport | null;
}
interface Probe { path: string; method?: string; headers?: Record<string, string> }
interface Answer { status: number; headers: Record<string, string>; body: Buffer; error?: string }

export const failLevels: readonly FailOn[] = Object.freeze([...severities, 'none']);
const CONCURRENCY = 4;
const MAX_REQUESTS = 10000;
const BODY_LIMIT = 1048576;
const SNIPPET = 200;
const siteTypes: Record<string, string> = { 'site.robots': 'text/plain', 'site.sitemap': 'application/xml', 'site.securityTxt': 'text/plain', 'site.llms': 'text/plain', 'site.notFound': 'text/html' };
const snippet = (body: Buffer): string => body.length > SNIPPET ? `${body.length} bytes: ${body.subarray(0, SNIPPET).toString('utf8')}` : body.toString('utf8');
const tlsCode = /CERT|TLS|SSL|SELF_SIGNED/;

// One request, one answer. Bodies are read up to 1 MiB and never logged
// beyond the snippet a failing assertion carries. Redirects are not followed
// and a transport error is reported as text, never thrown.
//
// `timeout` on a Node request/response is an *idle* timer: it only fires
// once a socket has gone quiet, so a deployment that drips one byte just
// under that interval keeps resetting it and can hold this probe open
// indefinitely. A single wall-clock deadline covering the whole request
// (connect through body) closes that gap. Past `BODY_LIMIT` the response is
// destroyed rather than left to keep streaming into a discard loop: this
// probe only ever needs a bounded snippet, never the rest of an oversized
// or endless body.
function probe(target: BenchmarkTarget, { path, method = 'GET', headers = {} }: Probe, agent: Agent, timeoutMs: number): Promise<Answer> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (answer: Answer): void => { if (settled) return; settled = true; clearTimeout(deadline); resolve(answer); };
    const fail = (error: unknown): void => {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : 'transport';
      finish({ status: 0, headers: {}, body: Buffer.alloc(0), error: code });
    };
    let req: ClientRequest | undefined;
    const deadline = setTimeout(() => { req?.destroy(new Error('timeout')); }, timeoutMs);
    try {
      const options: RequestOptions = { host: target.hostname, port: target.port, path, method, agent, timeout: timeoutMs,
        headers: { host: target.hostname, 'user-agent': probeAgent, 'accept-encoding': 'identity', ...headers } };
      req = (target.protocol === 'https:' ? secureRequest : request)(options, (res: IncomingMessage) => {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) out[key] = Array.isArray(value) ? value.join(', ') : value;
        const chunks: Buffer[] = []; let size = 0;
        const done = (): void => finish({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks) });
        res.on('data', (chunk: Buffer) => {
          if (size < BODY_LIMIT) chunks.push(chunk);
          size += chunk.length;
          if (size > BODY_LIMIT) res.destroy();
        });
        res.on('error', fail);
        res.on('end', done);
        // A body cut off by the BODY_LIMIT destroy() above ends here, not on
        // 'end'; the snippet already collected is still a valid answer.
        res.on('close', () => { if (!settled) done(); });
      });
      req.on('error', fail); req.on('timeout', () => req?.destroy(new Error('timeout'))); req.end();
    } catch (error) { req?.destroy(); fail(error); }
  });
}

async function each<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => { while (next < items.length) await fn(items[next++]!); }));
}

// The security headers a response on `pattern` must carry: the profile minus
// unset, plus set, with a YAML response header keeping its declared value on
// a success (the runtime applies YAML headers before the profile fills gaps;
// a 405 or an error never gets them). HSTS follows the origin, so an https
// target expects it and an http target does not.
function expectedSecurity(config: security.SecurityConfig, pattern: string, route: RouteConfig, origin: string, status: number): HeaderPair[] {
  const state = security.compile(config, { route: { pattern } });
  const declared: HeaderPair[] = status < 400 ? Object.entries(route.response?.headers ?? {}).flatMap(([key, value]) => typeof value === 'string' ? [[key.toLowerCase(), value] as HeaderPair] : []) : [];
  const keys = new Set([...state.profile.map(([key]) => key), ...state.overrideKeys]);
  return security.onResponse(state, { origin }, { status, headers: declared }).headers.filter(([key]) => keys.has(key.toLowerCase()));
}
const mediaMatches = (types: readonly string[], header: string | undefined): boolean => {
  const type = (header ?? '').split(';')[0]!.trim().toLowerCase();
  return Boolean(type) && types.some(candidate => candidate.endsWith('/*') ? type.startsWith(candidate.slice(0, -1).toLowerCase()) : type === candidate.toLowerCase());
};
// A User-Agent the bundled deny lists must refuse: the first entry of the
// first bundled deny list that no bundled allow list also matches.
function deniedAgent(agents: PolicyInventory['agents']): string | undefined {
  const allow = (agents?.allow ?? []).flatMap(list => bundledAgents[list.name]?.patterns.map(([, pattern]) => new RegExp(pattern, 'i')) ?? []);
  for (const list of agents?.deny ?? []) {
    for (const [entry, pattern] of bundledAgents[list.name]?.patterns ?? []) {
      const agent = `Mozilla/5.0 (compatible; ${entry})`;
      if (new RegExp(pattern, 'i').test(agent) && !allow.some(re => re.test(agent))) return agent;
    }
  }
  return undefined;
}

export async function verifyDeployment(project: string, { target, origin, expectRoutes, timeoutMs = 10000, expectMetrics = false, failOn = 'high', compliance, complianceWarn = false, log = () => {}, permissions }: VerifyOptions): Promise<VerifyReport> {
  const destination = benchmarkTarget(target);
  const targetOrigin = target.replace(/\/$/, '');
  assert(failLevels.includes(failOn), `Use --fail-on ${failLevels.join('|')}`);
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 120000, 'Timeout must be 100-120000 ms');
  assert(expectRoutes === undefined || (Number.isSafeInteger(expectRoutes) && expectRoutes >= 0), 'Expected route count must be an integer');
  const publicOrigin = origin ?? targetOrigin;
  const findings: VerifyFinding[] = [], notes: string[] = [];
  let checks = 0, requests = 0;
  const check = (ok: boolean, finding: VerifyFinding): boolean => { checks++; if (!ok) { findings.push(finding); log({ event: 'finding', ...finding }); } return ok; };
  const agent = destination.protocol === 'https:' ? new SecureAgent({ keepAlive: true, maxSockets: CONCURRENCY }) : new Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  const send = async (p: Probe): Promise<Answer> => { requests++; return probe(destination, p, agent, timeoutMs); };
  // The local snapshot is the declaration: its version, its plan, its policies.
  const runtime = await createRuntime(project, { local: true, origin: publicOrigin, permissions, log: () => {} });
  const version: VerifyReport['version'] = { local: runtime.version, observed: null };
  const routes: VerifyReport['routes'] = { local: runtime.count, observed: null, expected: expectRoutes ?? null };
  let complianceReport: ComplianceReport | null = null;
  try {
    const plan = runtime.testPlan(), fixtures = await readFixtures(runtime.root, true);
    const loaded = await loadDocument(runtime.root);
    await applySite(loaded, { origin: publicOrigin, log: () => {} });
    const fixtureRequests = fixtures.reduce((sum, fixture) => sum + (isStepsFixture(fixture) ? fixture.steps.filter(step => !('restart' in step)).length : 1), 0);
    const literal = plan.inventory.filter(route => route.state === 'active' && !route.path.includes('{'));
    assert(4 + plan.cases.length + fixtureRequests + literal.length * 4 <= MAX_REQUESTS, `Verification would send more than ${MAX_REQUESTS} requests`);
    check(expectRoutes === undefined || plan.inventory.length === expectRoutes, { check: 'probes', severity: 'high', message: 'configured route count differs from --expect-routes', expected: String(expectRoutes), observed: String(plan.inventory.length) });

    // 1. Probes. A transport failure on the health probe ends the run: nothing
    // else can be said about a deployment that does not answer.
    const health = await send({ path: '/_urlcode/health' });
    if (health.error !== undefined) {
      const tls = destination.protocol === 'https:' && tlsCode.test(health.error);
      check(false, { check: 'transport', severity: 'high', message: tls ? 'TLS certificate rejected by Node\'s default verification' : 'target did not answer the health probe', observed: health.error });
      return finish();
    }
    const parse = (answer: Answer): Record<string, unknown> | undefined => { try { const json: unknown = JSON.parse(answer.body.toString('utf8')); return isRecord(json) ? json : undefined; } catch { return undefined; } };
    const healthJson = parse(health);
    check(health.status === 200 && healthJson?.status === 'ok' && typeof healthJson.version === 'string' && typeof healthJson.routes === 'number',
      { check: 'probes', severity: 'high', message: '/_urlcode/health must answer 200 with {status:"ok",version,routes}', expected: '200', observed: `${health.status} ${snippet(health.body)}` });
    const ready = await send({ path: '/_urlcode/ready' }), readyJson = parse(ready);
    check(ready.status === 200 && readyJson?.status === 'ok', { check: 'probes', severity: 'high', message: '/_urlcode/ready must answer 200 (the deployment reports itself degraded or is not URLCode)', expected: '200', observed: `${ready.status} ${snippet(ready.body)}` });
    if (typeof readyJson?.version === 'string') version.observed = readyJson.version;
    if (typeof readyJson?.routes === 'number') routes.observed = readyJson.routes;
    check(version.observed === version.local, { check: 'probes', severity: 'high', message: 'deployed snapshot version differs from the local project (a different deployment or an unpublished change)', expected: version.local, observed: version.observed ?? 'none' });
    check(routes.observed === routes.local, { check: 'probes', severity: 'high', message: 'deployed route count differs from the local project', expected: String(routes.local), observed: routes.observed === null ? 'none' : String(routes.observed) });
    const metrics = await send({ path: '/_urlcode/metrics' });
    if (expectMetrics) check(metrics.status === 200, { check: 'probes', severity: 'medium', message: '/_urlcode/metrics expected but not served', expected: '200', observed: String(metrics.status) });
    else check(metrics.status === 404, { check: 'probes', severity: 'high', message: '/_urlcode/metrics is publicly reachable; keep it internal or pass --expect-metrics', expected: '404', observed: String(metrics.status) });

    // 2. Fixtures and generated cases, exactly as `urlcode test --target`
    // would send them: sequentially, through hit(), against the target.
    const stub: AuditableApp = { address: { address: '127.0.0.1', family: 'IPv4', port: 0 }, root: runtime.root, testPlan: () => plan };
    // A fixture with a restart step cannot run here: a live deployment is not ours to close and
    // start. It is skipped as a whole, never partly, and named in the report and the log.
    const record = (n: number, source: string, test: RequestCase, original: RequestCase, result: Awaited<ReturnType<typeof hit>>): void => {
      let route: string | undefined; try { route = plan.resolve(test.path); } catch { /* an invalid-path negative fixture */ }
      // The label prints the fixture as written: a substituted path may hold a captured value.
      const label = `${source} case ${n} ${original.method ?? 'GET'} ${original.path}`;
      check(result.pass, { check: 'fixtures', severity: 'high', ...(route === undefined ? {} : { route }), message: result.error ? `${label}: ${result.error} error` : `${label}: response did not match the case`, expected: String(test.status), observed: String(result.status) });
    };
    for (const [i, test] of plan.cases.entries()) { requests++; record(i + 1, 'generated', test, test, await hit(stub, test, agent, destination)); }
    await runFixtures(fixtures, {
      app: stub, agent, target: destination,
      skipped: (fixture, reason) => { notes.push(`fixture ${fixture} ${reason}; none of its requests were sent and it was not verified`); log({ event: 'skipped', check: 'fixtures', fixture, reason: 'restart' }); },
    }, step => { if (step.result.error !== 'skipped' && step.result.error !== 'unresolved') requests++; record(step.case, 'fixture', step.test, step.original, step.result); }, plan.cases.length + 1);

    // 3. Declared versus observed, per active literal route.
    await each(literal, async route => {
      const config = loaded.routes[route.path] ?? {};
      const effective = effectivePolicies(loaded.document, config);
      const inventory = plan.policies[route.path] ?? {};
      const hasGet = route.methods.includes('GET');
      let path = route.path;
      if (route.path.endsWith('/*')) {
        const file = plan.cases.find(test => test.path.startsWith(route.path.slice(0, -1)) && (test.method ?? 'GET') === 'GET');
        if (!file) return; path = file.path;
      }
      const answer = await send({ path });
      if (answer.error !== undefined) { check(false, { check: 'transport', severity: 'high', route: route.path, message: `GET ${path}: ${answer.error} error` }); return; }
      const { status, headers } = answer;
      if (!hasGet) check(status === 405 && headers.allow === route.methods.join(', '), { check: 'methods', severity: 'medium', route: route.path, message: 'a method the route does not declare must answer 405 with Allow', expected: `405 Allow: ${route.methods.join(', ')}`, observed: `${status} Allow: ${headers.allow ?? 'none'}` });
      else if (config.methods && !route.methods.includes('OPTIONS')) {
        const refused = await send({ path, method: 'OPTIONS' });
        check(refused.status === 405 && refused.headers.allow === route.methods.join(', '), { check: 'methods', severity: 'medium', route: route.path, message: 'OPTIONS on a declared-methods route must answer 405 with Allow', expected: `405 Allow: ${route.methods.join(', ')}`, observed: `${refused.status} Allow: ${refused.headers.allow ?? 'none'}` });
      }
      if (effective.security) for (const [key, value] of expectedSecurity(effective.security, route.path, config, targetOrigin, status)) {
        const hsts = key === 'strict-transport-security';
        check(headers[key] === value, { check: hsts ? 'transport' : 'security', severity: 'high', route: route.path, message: hsts ? 'HSTS missing: the deployment must be started with --origin https://... to emit it' : `security header ${key} differs from the declared profile`, expected: value, observed: headers[key] ?? 'none' });
      }
      const decorated = status < 400 || status === 405;
      const cache = inventory.cache;
      if (cache?.target === 'native' && decorated && route.handler !== 'function' && typeof cache.cacheControl === 'string' && !['explicit response header', 'asset handler'].includes(cache.cacheControl)) {
        check(headers['cache-control'] === cache.cacheControl, { check: 'cache', severity: 'medium', route: route.path, message: `Cache-Control differs from the ${cache.strategy} strategy`, expected: cache.cacheControl, observed: headers['cache-control'] ?? 'none' });
        if (cache.cdnCacheControl) check(headers['cdn-cache-control'] === cache.cdnCacheControl, { check: 'cache', severity: 'medium', route: route.path, message: 'CDN-Cache-Control differs from the declared strategy', expected: cache.cdnCacheControl, observed: headers['cdn-cache-control'] ?? 'none' });
      }
      const throttle = inventory.throttle;
      if (throttle?.target === 'native' && decorated) {
        const expected = throttle.quota !== undefined && throttle.window !== undefined ? `"default";q=${throttle.quota};w=${throttle.window}` : undefined;
        check(expected === undefined ? headers['ratelimit-policy'] !== undefined : headers['ratelimit-policy'] === expected, { check: 'throttle', severity: 'medium', route: route.path, message: 'RateLimit-Policy differs from the declared throttle', expected: expected ?? 'present', observed: headers['ratelimit-policy'] ?? 'none' });
      }
      const compression = inventory.compression;
      if (compression?.target === 'delegated') notes.push(`${route.path}: compression is delegated to the platform on the ${compression.target} target and was not verified`);
      else if (compression?.target === 'native' && status === 200) {
        const types = effective.compression?.types ?? compressibleTypes, minBytes = compression.minBytes ?? effective.compression?.minBytes ?? 1024;
        const secrets = Object.keys(config.secrets ?? {}).length > 0 && effective.compression?.allowWithSecrets !== true;
        const candidate = mediaMatches(types, headers['content-type']) && Number(headers['content-length'] ?? 0) >= minBytes && !/no-transform/i.test(headers['cache-control'] ?? '') && headers['set-cookie'] === undefined && !secrets && !headers['content-encoding'];
        if (candidate) {
          const encodings = compression.encodings ?? effective.compression?.encodings ?? ['br', 'gzip'];
          const encoded = await send({ path, headers: { 'accept-encoding': encodings.join(', ') } });
          check(encodings.some(coding => coding === encoded.headers['content-encoding']), { check: 'compression', severity: 'medium', route: route.path, message: 'a compressible response was served identity despite the declared compression policy', expected: `Content-Encoding in ${encodings.join(', ')}`, observed: encoded.headers['content-encoding'] ?? 'none' });
        }
      }
      const agents = inventory.agents;
      if (agents?.target === 'native' && agents.mode === 'enforce') {
        const denied = deniedAgent(agents);
        if (denied === undefined) notes.push(`${route.path}: agents policy denies no bundled list, so no denial was verified`);
        else {
          const refused = await send({ path, headers: { 'user-agent': denied } });
          check(refused.status === agents.status, { check: 'agents', severity: 'high', route: route.path, message: 'a User-Agent on the denied bundled list was not refused with the configured status', expected: String(agents.status), observed: String(refused.status) });
        }
      }
      if (route.generated !== undefined) {
        const type = route.generated === 'site.favicon' ? config.page?.contentType : siteTypes[route.generated];
        check(status === 200 && type !== undefined && (headers['content-type'] ?? '').toLowerCase().startsWith(type), { check: 'site', severity: 'medium', route: route.path, message: `${route.generated} must be served with its content type`, expected: `200 ${type ?? 'unknown'}`, observed: `${status} ${headers['content-type'] ?? 'none'}` });
        if (['site.robots', 'site.securityTxt'].includes(route.generated) && config.respond?.text !== undefined) {
          check(answer.body.toString('utf8') === config.respond.text, { check: 'site', severity: 'medium', route: route.path, message: `${route.generated} body differs from the generated file`, expected: snippet(Buffer.from(config.respond.text)), observed: snippet(answer.body) });
        }
      }
      if (route.handler === 'respond' && hasGet && status === 200) {
        const head = await send({ path, method: 'HEAD' });
        check(head.status === 200 && head.headers['content-length'] === headers['content-length'] && head.body.length === 0, { check: 'head', severity: 'medium', route: route.path, message: 'HEAD must answer with the Content-Length GET states and no body', expected: `200 Content-Length: ${headers['content-length'] ?? 'none'}`, observed: `${head.status} Content-Length: ${head.headers['content-length'] ?? 'none'}` });
      }
    });

    // 4. An unmatched path answers 404 with the project-level security
    // headers and the runtime's fixed error headers, which is also how a
    // non-URLCode answerer (a CDN error page, a different app) shows itself.
    const missing = await send({ path: `/_urlcode-verify-${randomBytes(6).toString('hex')}` });
    check(missing.status === 404 && missing.headers['x-content-type-options'] === 'nosniff' && missing.headers['cache-control'] === 'no-store', { check: 'errors', severity: 'high', message: 'an unmatched path must answer the runtime\'s 404 (nosniff, no-store)', expected: '404 nosniff no-store', observed: `${missing.status} ${missing.headers['x-content-type-options'] ?? 'none'} ${missing.headers['cache-control'] ?? 'none'}` });
    for (const [key, value] of errorHeaders(compileErrorPolicy(loaded.document), targetOrigin)) {
      const hsts = key === 'strict-transport-security';
      check(missing.headers[key] === value, { check: hsts ? 'transport' : 'errors', severity: 'high', message: hsts ? 'HSTS missing on error responses: start the deployment with --origin https://...' : `error responses lack the project-level security header ${key}`, expected: value, observed: missing.headers[key] ?? 'none' });
    }
    for (const [pattern, config] of Object.entries(loaded.routes)) {
      if (typeof config.redirect?.url === 'string' && config.redirect.url.startsWith('http:')) check(false, { check: 'transport', severity: 'low', route: pattern, message: 'redirect destination is plain http:', observed: config.redirect.url });
    }
    // 5. Compliance over the declared configuration, with the target as the
    // origin under review unless the operator states another.
    if (compliance) complianceReport = await runCompliance(runtime, { ...compliance, origin: compliance.origin ?? targetOrigin });
    return finish();
  } finally { agent.destroy(); await runtime.close(); }

  function finish(): VerifyReport {
    const order = new Map(severities.map((s, i) => [s, i]));
    findings.sort((a, b) => order.get(a.severity)! - order.get(b.severity)! || a.check.localeCompare(b.check) || (a.route ?? '').localeCompare(b.route ?? ''));
    const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of findings) counts[finding.severity]++;
    // Severity order counts down from high = 0, so "at or above" is index <= threshold and none is -1.
    const threshold = failOn === 'none' ? -1 : order.get(failOn)!;
    const failing = findings.some(finding => order.get(finding.severity)! <= threshold);
    const pass = !failing && (complianceReport === null || complianceReport.pass || complianceWarn);
    return { target: targetOrigin, version, routes, requests, checks, findings, counts, notes, failOn, pass, compliance: complianceReport };
  }
}
