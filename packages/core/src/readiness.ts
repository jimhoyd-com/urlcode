import { request, Agent } from 'node:http';
import type { IncomingMessage, ClientRequest, RequestOptions } from 'node:http';
import { request as secureRequest, Agent as SecureAgent } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { compileTrustedProxies } from './client-address.ts';
import { safeFile } from './config.ts';
import { assert } from './errors.ts';
import { isRecord } from './object-guards.ts';
import { parseTarget, matchRoute, contextFor, redirectLocation } from './router.ts';
import { runCompliance } from './compliance.ts';
import { handlerNames as handlers } from './types.ts';
import type { CompiledRedirect, CompiledRoute, HandlerName, LogFn, PlanInventoryEntry, PolicyInventory } from './types.ts';
import type { ComplianceOptions, ComplianceReport } from './compliance.ts';
import type { CompiledRoutes, RequestContext } from './match.ts';

export type { RouteState, HandlerName } from './types.ts';
/** One configured route as the inventory reports it: a PlanInventoryEntry with the handler kind named. */
export interface RouteInventory extends PlanInventoryEntry {
  handler: HandlerName | undefined;
  /** Always reported here, so a trust change is visible in `routes` and its diff. */
  sandbox: boolean;
  /** Non-blocking `audit` observations about this route (e.g. a webhook-shaped
   * route with no declared `sandbox`/`sandboxReason`); never affects `ready`. */
  advisories?: string[];
}
/** One request case: a generated probe or a `tests/requests.json` fixture. */
export interface RequestCase {
  path: string; method?: string | undefined; status: number; headers?: Record<string, string> | undefined; body?: string | undefined;
  expectHeaders?: Record<string, string> | undefined; expectBody?: string | undefined;
  /** Only inside `steps`: values kept from this step's response for later steps' `{{name}}` references. */
  capture?: Record<string, CaptureSpec> | undefined;
}
/** Where a captured value comes from: a dotted path into a JSON response body, or one response header. */
type CaptureSpec = { json: string } | { header: string };
/** A step that closes and restarts the runtime on the same project and data directory. */
interface RestartStep { restart: true }
/** An ordered fixture: requests that share captured values, optionally with restarts between them. */
interface StepsFixture { steps: (RequestCase | RestartStep)[] }
export type Fixture = RequestCase | StepsFixture;
export const isStepsFixture = (fixture: Fixture): fixture is StepsFixture => 'steps' in fixture;
const isRestartable = (app: AuditableApp): app is RestartableApp => typeof (app as Partial<RestartableApp>).restart === 'function';
const isRestart = (step: RequestCase | RestartStep): step is RestartStep => 'restart' in step;
export interface ProjectPlan { inventory: RouteInventory[]; cases: RequestCase[]; resolve: (path: string) => string | undefined }
/** `captured` holds values from a step's `capture`; callers use it for substitution only and never print it. */
interface HitResult { pass: boolean; status: number; durationMs: number; error?: string; captured?: Record<string, string> }
export interface BenchmarkTarget { protocol: string; hostname: string; port: number | string }
/** A started server as the audit and benchmark see it. structural: the real type is startServer's result in src/server.ts. */
export interface AuditableApp { address: AddressInfo; root: string; testPlan(): ProjectPlan & { policies?: Record<string, PolicyInventory> } }
/** An app that can also close and restart itself on the same project and data directory (fixture `restart` steps). */
export interface RestartableApp extends AuditableApp { restart(): Promise<void> }
export type { ComplianceOptions, ComplianceReport } from './compliance.ts';
/**
 * The deployment under review, as the operator declares it (the CLI takes the `serve` flags
 * `--trusted-proxies` and `--metrics` on `audit`). The audit's own probe server applies neither;
 * they only decide which `deploymentAdvisories` apply.
 */
export interface AuditDeployment { trustedProxies?: string | string[] | undefined; metrics?: boolean | undefined }
/** A non-blocking finding about how the project will be deployed rather than about one route. */
export interface DeploymentAdvisory { code: 'client-throttle-without-trusted-proxies' | 'metrics-on-public-listener'; message: string; routes?: string[] }
interface AuditOptions { expectRoutes?: number | undefined; log?: LogFn | undefined; compliance?: ComplianceOptions | undefined; deployment?: AuditDeployment | undefined }
interface AuditReport {
  elapsedMs: number; ready: boolean;
  /** Empty when `ready`; otherwise one stable code per failed condition:
   * `no-active-routes`, `route-count-mismatch`, `failed-checks`, `uncovered-route-methods`. */
  notReadyReasons: string[];
  /** `configured` is every route in the table, including routes generated from `site` keys; `--expect-routes` compares against it.
   * `declared` + `generated` always equals `configured`. */
  counts: { configured: number; declared: number; generated: number; active: number; disabled: number; expired: number; byHandler: Record<string, number> };
  expectedRoutes: number | null; countMatches: boolean; checks: number; passed: number; failed: number; coveredRouteMethods: number;
  unassertedCases: number[]; uncovered: { route: string; method: string }[];
  /** Route/method pairs excused by a `coveredElsewhere` waiver, with the reason. Shown even when `ready`. */
  waivedRouteMethods: { route: string; method: string; reason: string }[];
  /** Waivers not honored (the route has no normally covered method, e.g. an error-only function route); their pairs stay in `uncovered`. */
  ignoredWaivers: { route: string; method: string; reason: string }[];
  /** Waivers whose pair already has a passing normal-response fixture: remove them. Never blocks `ready`. */
  redundantWaivers: { route: string; method: string; reason: string }[];
  policies: Record<string, PolicyInventory>; compliance: ComplianceReport | null;
  /** Non-blocking `audit` observations, e.g. a route that looks webhook-shaped
   * but declares neither `sandbox: true` nor `sandboxReason`. Never affects `ready`. */
  advisories: { route: string; message: string }[];
  /** Non-blocking deployment findings (see AuditDeployment). Never affects `ready`. */
  deploymentAdvisories: DeploymentAdvisory[];
}
interface BenchmarkOptions { requests?: number | undefined; concurrency?: number | undefined; maxP95Ms?: number | undefined; seconds?: number | undefined; warmup?: number | undefined; target?: string | undefined }
interface BenchmarkReport {
  pass: boolean; requested: number; completed: number; complete: boolean; failed: number; transportErrors: number; shedResponses: number; concurrency: number;
  workloadCases: number; exercisedWorkloadCases: number; workload: string; target: string | null; warmupRequests: number; elapsedMs: number; requestsPerSecond: number;
  p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxP95Ms: number | null; statuses: Record<string, number>; rssMiB: number | null; node: string; platform: string;
}

/** Narrows a compiled route to one that redirects, so redirectLocation can read its spec. */
export const hasRedirect = (route: CompiledRoute): route is CompiledRoute & { redirect: CompiledRedirect } => Boolean(route.redirect);
// Probes identify themselves so an agents policy that denies an empty
// User-Agent does not fail every generated case; fixtures may override it.
export const probeAgent = 'Mozilla/5.0 (compatible; RouteProbe/0.1)';
// Advisory only (docs/AI-AUTHORING.md, "Deciding when a route needs sandbox: true"):
// a route that runs project code, accepts POST with a declared request.body
// policy, and declares neither `sandbox: true` nor `sandboxReason` looks
// plausibly webhook/callback/third-party-input-shaped. This is a nudge to
// record the trust decision, never an inferred verdict — it never fails
// `audit` or changes `ready`. The wording follows the documented criteria:
// untrusted input alone is not a reason to sandbox (#586).
function routeAdvisories(route: CompiledRoute): string[] {
  const advisories: string[] = [];
  const runsCode = Boolean(route.function) || Boolean(route.middleware?.length);
  if (runsCode && route.methods.includes('POST') && route.request?.body && !route.sandbox && !route.sandboxReason) {
    advisories.push("This route accepts POST with a declared request.body policy but declares neither sandbox: true nor sandboxReason; record the trust decision. Untrusted input alone is not a reason to sandbox: validate it with request.body.schema and parameters. Reviewed first-party code stays trusted (the default; the filesystem, node:crypto signature checks, fetch and npm packages exist only there): add to the route: sandboxReason: \"Reviewed first-party code; trusted deliberately.\" Add sandbox: true only when the route's own code is unreviewed or contributed, or must not be able to leak a granted secret, with a sandboxReason saying why.");
  }
  return advisories;
}
export function projectPlan(compiled: CompiledRoutes<CompiledRoute>): ProjectPlan {
  const routes = [...compiled.exact.values(), ...[...compiled.byLength.values()].flat(), ...compiled.mounts];
  const now = Date.now();
  const inventory: RouteInventory[] = routes.map(route => { const advisories = routeAdvisories(route); return { path:route.pattern, handler:handlers.find(key => route[key]), methods:route.methods, middleware:route.middleware?.length || 0,
    policies:[...(route.policy ? Object.keys(route.policy.describe) : []),...(route.extensionPolicyNames??[]).map(name=>`extensions.${name}`)],
    sandbox:route.sandbox === true, ...(route.sandboxReason ? { sandboxReason:route.sandboxReason } : {}),
    ...(route.coveredElsewhere ? { coveredElsewhere:route.coveredElsewhere } : {}),
    ...(route.generated ? { generated:route.generated } : {}),
    ...(advisories.length ? { advisories } : {}),
    state:route.enabled === false ? 'disabled' : route.expiresAt && now >= route.expiresAt ? 'expired' : 'active' }; });
  const cases: RequestCase[] = [];
  for (const [i,route] of routes.entries()) {
    const entry = inventory[i];
    if (!entry) continue;
    if (entry.state !== 'active') {
      if(!route.names.length && !route.static && !route.extension && !route.extensionPolicyNames?.length) cases.push({path:route.pattern,method:'GET',status:entry.state==='disabled'?404:410});
      continue;
    }
    if (route.extension || route.extensionPolicyNames?.length || route.proxy || route.signals?.length || route.match || route.conditional || route.function || route.middleware?.length || route.names.length) continue;
    // Required inputs need intentional fixtures; never invent business data.
    let context: RequestContext;
    try { context = contextFor(route,route.wildcard ? {'**':'sample'} : {},new URLSearchParams(),new Headers()); } catch { continue; }
    if (route.request?.body?.required) continue;
    const files = route.asset instanceof Map ? route.asset : undefined;
    const prefix = route.prefix ?? '';
    const paths = route.wildcard ? [prefix + 'sample'] : route.static && files ? [...files.keys()].map(key => prefix + key.split('/').map(encodeURIComponent).join('/')) : [route.pattern];
    for (const path of paths) for (const method of route.methods) {
      if (!['GET','HEAD'].includes(method)) continue;
      const test: RequestCase = {path,method,status:(route.redirect ? route.redirect.status || 302 : route.reply?.status || 200)};
      if (hasRedirect(route)) test.expectHeaders = {location:redirectLocation(route,context,new URLSearchParams())};
      const asset=route.static ? files?.get(decodeURIComponent(path.slice(prefix.length))) : route.asset instanceof Map ? undefined : route.asset;
      if(asset) test.expectHeaders={'content-type':asset.type,etag:asset.etag,'content-length':String(asset.body.length)};
      if (route.reply && method !== 'HEAD') test.expectBody = Buffer.from(route.reply.body).toString('utf8');
      if (method === 'HEAD') test.expectBody = '';
      cases.push(test);
    }
  }
  return {inventory,cases,resolve:path => matchRoute(compiled,parseTarget(path))?.route.pattern};
}
// Bounds for ordered fixtures. A fixture file is data a project author (or an agent) wrote;
// none of these limits is a security boundary, they keep a mistake from becoming an unbounded run.
const MAX_STEPS = 50, MAX_RESTARTS = 5, MAX_TOTAL_RESTARTS = 20, MAX_CAPTURES = 16, MAX_CAPTURE_BYTES = 4096, MAX_CAPTURE_BODY = 1024 * 1024;
const nameShape = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/, pathShape = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, control = /[\x00-\x1f\x7f]/;
const templates = (text: string): string[] => [...text.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/g)].map(m => m[1] ?? '');
const templated = (test: RequestCase): string[] => [test.path, test.body, test.expectBody, ...Object.values(test.headers ?? {}), ...Object.values(test.expectHeaders ?? {})].filter((v): v is string => v !== undefined);
function checkCase(test: unknown, inSteps: boolean): asserts test is RequestCase {
  assert(isRecord(test), 'Invalid request test');
  // A step path may start with a {{name}} (a captured Location); it is checked again once filled in.
  assert(typeof test.path === 'string' && (test.path.startsWith('/') || (inSteps && test.path.startsWith('{{'))) && !test.path.startsWith('//') && !/[\r\n]/.test(test.path), 'Test path must be local');
  assert(Number.isInteger(test.status) && typeof test.status === 'number' && test.status >= 200 && test.status <= 599, 'Test must declare an HTTP status');
  assert(!test.method || (typeof test.method === 'string' && ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(test.method)), 'Invalid test method');
  assert(test.body === undefined || typeof test.body === 'string', 'Test body must be text');
  assert(test.expectBody === undefined || typeof test.expectBody === 'string', 'Expected body must be text');
  for (const headers of [test.headers,test.expectHeaders]) assert(headers === undefined || (isRecord(headers) && Object.values(headers).every(v => typeof v === 'string')), 'Test headers must be string mappings');
  assert(inSteps || test.capture === undefined, 'capture is only valid inside steps');
  if (test.capture !== undefined) {
    assert(isRecord(test.capture) && Object.keys(test.capture).length <= MAX_CAPTURES, `capture must be a mapping of at most ${MAX_CAPTURES} names`);
    for (const [name,spec] of Object.entries(test.capture)) {
      assert(nameShape.test(name), 'Capture names use letters, digits and underscores (at most 32, not starting with a digit)');
      assert(isRecord(spec) && Object.keys(spec).length === 1, 'A capture is exactly one of {json: "a.b.0.c"} or {header: "name"}');
      if (typeof spec.json === 'string') assert(spec.json.length <= 256 && pathShape.test(spec.json), 'Capture json path is dotted keys and array indexes, such as items.0.id');
      else assert(typeof spec.header === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(spec.header), 'A capture is exactly one of {json: "a.b.0.c"} or {header: "name"}');
    }
  }
}
export async function readFixtures(root: string, optional = false): Promise<Fixture[]> {
  if(optional) {
    try {await lstat(join(root,'tests/requests.json'));}
    catch(error){if(error instanceof Error && 'code' in error && error.code==='ENOENT')return [];throw error;}
  }
  const file=await safeFile(root,'tests/requests.json');
  const bytes = await readFile(file);
  assert(bytes.length <= 16*1024*1024, 'Request fixture file exceeds 16 MiB');
  const cases: unknown = JSON.parse(bytes.toString('utf8'));
  assert(Array.isArray(cases) && cases.length <= 10000 && (optional || cases.length), 'Request tests must be an array (maximum 10000)');
  let requests = 0, restarts = 0;
  for (const test of cases as unknown[]) {
    if (!(isRecord(test) && 'steps' in test)) { checkCase(test,false); requests++; continue; }
    assert(Object.keys(test).length === 1 && Array.isArray(test.steps) && test.steps.length >= 1 && test.steps.length <= MAX_STEPS, `steps must be the only key and hold 1-${MAX_STEPS} steps`);
    const known = new Set<string>(); let here = 0;
    for (const step of test.steps as unknown[]) {
      if (isRecord(step) && 'restart' in step) {
        assert(step.restart === true && Object.keys(step).length === 1, 'A restart step is exactly {"restart": true}');
        assert(++here <= MAX_RESTARTS && ++restarts <= MAX_TOTAL_RESTARTS, `At most ${MAX_RESTARTS} restarts per fixture and ${MAX_TOTAL_RESTARTS} per file`);
        continue;
      }
      checkCase(step,true); requests++;
      for (const name of templated(step).flatMap(templates)) assert(known.has(name), 'A {{name}} reference needs an earlier step in the same fixture to capture it');
      for (const name of Object.keys(step.capture ?? {})) known.add(name);
    }
  }
  assert(requests <= 10000, 'Request tests exceed 10000 requests in total');
  return cases as Fixture[]; // trust boundary: fixture JSON, validated field by field above
}
/** Single-request fixtures only: the benchmark replays these and cannot run ordered steps. */
async function readCases(root: string, optional = false): Promise<RequestCase[]> {
  return (await readFixtures(root,optional)).filter((fixture): fixture is RequestCase => !isStepsFixture(fixture));
}
/** One request a fixture run sent: `test` is the request as sent (captured values filled in), `original` as written. Print `original`, never `test`. */
interface FixtureStep { case: number; fixture: number; test: RequestCase; original: RequestCase; result: HitResult }
interface FixtureHost {
  app: AuditableApp; agent: Agent; target?: BenchmarkTarget | undefined;
  /** Close and restart the runtime on the same project and data directory. Absent: the host cannot restart. */
  restart?: (() => Promise<void>) | undefined;
  /** Called with the 1-based fixture number and a reason when a fixture with a restart step is skipped because the host cannot restart. Absent: such a fixture is refused with an error. */
  skipped?: ((fixture: number, reason: string) => void) | undefined;
}
const fill = (text: string, values: Map<string,string>): string | undefined => {
  let missing = false;
  const out = text.replace(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/g, (_, name: string) => { const v = values.get(name); if (v === undefined) missing = true; return v ?? ''; });
  return missing ? undefined : out;
};
function resolveStep(test: RequestCase, values: Map<string,string>): RequestCase | undefined {
  const map = (headers: Record<string,string> | undefined): Record<string,string> | undefined | null => {
    if (headers === undefined) return undefined;
    const out: Record<string,string> = {};
    for (const [k,v] of Object.entries(headers)) { const f = fill(v,values); if (f === undefined) return null; out[k] = f; }
    return out;
  };
  const path = fill(test.path,values), body = test.body === undefined ? undefined : fill(test.body,values), expectBody = test.expectBody === undefined ? undefined : fill(test.expectBody,values);
  const headers = map(test.headers), expectHeaders = map(test.expectHeaders);
  if (path === undefined || !path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path) || headers === null || expectHeaders === null || (test.body !== undefined && body === undefined) || (test.expectBody !== undefined && expectBody === undefined)) return undefined;
  return { ...test, path, headers, body, expectHeaders, expectBody };
}
/** Runs every fixture in file order. A step after a failed step in the same fixture is reported failed with error `skipped` and never sent, so a broken chain cannot pass. */
export async function runFixtures(fixtures: Fixture[], host: FixtureHost, visit: (step: FixtureStep) => void | Promise<void>, firstCase = 1): Promise<void> {
  let n = firstCase;
  for (const [f,fixture] of fixtures.entries()) {
    if (!isStepsFixture(fixture)) { await visit({case:n++,fixture:f+1,test:fixture,original:fixture,result:await hit(host.app,fixture,host.agent,host.target)}); continue; }
    if (fixture.steps.some(isRestart) && host.restart === undefined) {
      const reason = 'contains a restart step, which needs a runtime this host can close and restart';
      assert(host.skipped !== undefined, `Fixture ${f+1} ${reason}`);
      host.skipped(f+1,reason); continue;
    }
    const values = new Map<string,string>(); let broken = false;
    for (const step of fixture.steps) {
      if (isRestart(step)) { if (!broken) { try { await host.restart?.(); } catch { broken = true; } } continue; }
      const resolved = broken ? undefined : resolveStep(step,values);
      let result: HitResult = {pass:false,status:0,durationMs:0,error:'skipped'};
      if (resolved) {
        const sent = await hit(host.app,resolved,host.agent,host.target);
        if (sent.pass) for (const [name,value] of Object.entries(sent.captured ?? {})) values.set(name,value);
        const {captured: _kept, ...visible} = sent; result = visible;
      } else if (!broken) result = {pass:false,status:0,durationMs:0,error:'unresolved'};
      if (!result.pass) broken = true;
      await visit({case:n++,fixture:f+1,test:resolved ?? step,original:step,result});
    }
  }
}
function extract(spec: CaptureSpec, headers: IncomingMessage['headers'], body: Buffer): string | undefined {
  let value: unknown;
  if ('header' in spec) value = headers[spec.header.toLowerCase()];
  else {
    if (body.length > MAX_CAPTURE_BODY) return undefined;
    try { value = JSON.parse(body.toString('utf8')); } catch { return undefined; }
    for (const key of spec.json.split('.')) {
      if (Array.isArray(value)) value = /^\d+$/.test(key) ? value[Number(key)] : undefined;
      else if (isRecord(value) && Object.hasOwn(value,key)) value = value[key];
      else return undefined;
    }
  }
  const text = typeof value === 'string' ? value : (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean' ? String(value) : undefined;
  return text !== undefined && text.length > 0 && Buffer.byteLength(text) <= MAX_CAPTURE_BYTES && !control.test(text) ? text : undefined;
}
export function benchmarkTarget(value: string): BenchmarkTarget {
  let url: URL;
  try { url=new URL(value); } catch { assert(false,'Target must be an absolute HTTP(S) origin'); }
  assert(['http:','https:'].includes(url.protocol) && url.origin===value.replace(/\/$/,'') && !url.username && !url.password,
    'Target must be a bare HTTP(S) origin without path or credentials');
  return {protocol:url.protocol,hostname:url.hostname,port:url.port || (url.protocol==='https:'?443:80)};
}
export function hit(app: AuditableApp,test: RequestCase,agent: Agent,target?: BenchmarkTarget): Promise<HitResult> {
  return new Promise(resolve => {
    const began=performance.now();
    const fail=()=>resolve({pass:false,status:0,durationMs:performance.now()-began,error:'transport'});
    let req: ClientRequest|undefined;
    try {
      const send=target?.protocol==='https:' ? secureRequest : request;
      const options: RequestOptions=target
        ? {host:target.hostname,port:target.port,path:test.path,method:test.method || 'GET',headers:{host:target.hostname,'user-agent':probeAgent,...(test.headers || {})},agent,timeout:10000}
        : {host:'127.0.0.1',port:app.address.port,path:test.path,method:test.method || 'GET',headers:{'user-agent':probeAgent,...(test.headers || {})},agent,timeout:10000};
      req=send(options,(res: IncomingMessage)=>{
        let size=0;const chunks: Buffer[]=[];
        res.on('data',(chunk: Buffer)=>{size+=chunk.length;if(size>16*1024*1024)res.destroy(new Error('Response limit'));else if(test.expectBody!==undefined || (test.capture && size<=MAX_CAPTURE_BODY))chunks.push(chunk);});
        res.on('error',fail);
        res.on('end',()=>{
          const status=res.statusCode ?? 0,durationMs=performance.now()-began,body=Buffer.concat(chunks);
          let pass=status===test.status && Object.entries(test.expectHeaders || {}).every(([k,v])=>res.headers[k.toLowerCase()]===v) && (test.expectBody===undefined || body.toString()===test.expectBody);
          if(!pass || !test.capture)return resolve({status,durationMs,pass});
          // Values are kept only for later steps; a missing one fails the step without saying what the response held.
          const captured: Record<string,string>={};
          for(const [name,spec] of Object.entries(test.capture)){const value=extract(spec,res.headers,body);if(value===undefined){pass=false;break;}captured[name]=value;}
          resolve(pass?{status,durationMs,pass,captured}:{status,durationMs,pass,error:'capture'});
        });
      });
      req.on('error',fail);req.on('timeout',()=>req?.destroy(new Error('Timeout')));req.end(test.body);
    } catch { req?.destroy();fail(); }
  });
}
// `compliance` is the option object for runCompliance (profile, rules, ignore,
// origin, host); absent, the report carries `compliance: null` and readiness
// is unchanged. A compliance verdict is reported beside readiness, never
// folded into it: the exit code decision belongs to the caller.
export function deploymentAdvisories(policies: Record<string, PolicyInventory>, deployment: AuditDeployment = {}): DeploymentAdvisory[] {
  const found: DeploymentAdvisory[] = [];
  // Parsed the way the server parses it, so a malformed list fails here rather than silencing the finding.
  const trusted = compileTrustedProxies(deployment.trustedProxies ?? []).length > 0;
  const clientThrottled = Object.entries(policies).filter(([,policy]) => policy.throttle && policy.throttle.partition !== 'route' && policy.throttle.target !== 'delegated').map(([route]) => route).sort();
  if (clientThrottled.length && !trusted) found.push({ code: 'client-throttle-without-trusted-proxies', routes: clientThrottled,
    message: 'A throttle partitions by client, but no trusted proxies are declared. Behind a load balancer or reverse proxy every caller then resolves to the proxy address and shares one budget. Start the server with --trusted-proxies naming those proxies (and pass the same flag to audit); a server that takes connections directly from clients needs nothing.' });
  if (deployment.metrics) found.push({ code: 'metrics-on-public-listener',
    message: '--metrics serves /_urlcode/metrics on the same listener as public traffic. Block that path at the proxy or network edge, or scrape through a private network path only.' });
  return found;
}
export async function auditProject(app: AuditableApp, {expectRoutes,log=()=>{},compliance,deployment}: AuditOptions = {}): Promise<AuditReport> {
  const began=performance.now();
  const plan=app.testPlan(), fixtures=await readFixtures(app.root,true);
  const metadata=new Map(plan.inventory.map(r=>[r.path,r]));
  const covered=new Set<string>(), unassertedCases: number[]=[];let passed=0,failed=0,checks=0;
  const agent=new Agent({keepAlive:true,maxSockets:1});
  // One accounting for generated cases and fixture steps, single or ordered: a step counts as
  // a check, and covers a route/method only when it passes and asserts the response. Coverage
  // uses the route the substituted path actually matched.
  const record=(n: number,test: RequestCase,result: HitResult,source: 'generated'|'fixture'): void=>{
    checks++;const method=test.method || 'GET';
    let route: string|undefined;try {route=plan.resolve(test.path);} catch { /* Invalid-path negative fixture. */ }
    const meta=route===undefined?undefined:metadata.get(route);
    // Error-only fixtures cannot prove a function's normal path works.
    const assertsResponse=test.expectBody!==undefined || Object.keys(test.expectHeaders || {}).length>0;
    if(result.pass && meta?.state==='active' && result.status<400 && !assertsResponse)unassertedCases.push(n);
    if(result.pass && assertsResponse && meta?.state==='active' && (result.status<400 || (meta.handler==='respond' && source==='generated')))covered.add(JSON.stringify([route,method]));
    if(result.pass)passed++;else failed++;
    log({event:'check',case:n,source,pass:result.pass,status:result.status,expectedStatus:test.status});
  };
  try {
    for (const [i,test] of plan.cases.entries()) record(i+1,test,await hit(app,test,agent),'generated');
    const restart=isRestartable(app)?()=>app.restart():undefined;
    await runFixtures(fixtures,{app,agent,restart},step=>record(step.case,step.test,step.result,'fixture'),plan.cases.length+1);
  } finally {agent.destroy();}
  const missing=plan.inventory.filter(r=>r.state==='active').flatMap(r=>r.methods.filter(m=>!covered.has(JSON.stringify([r.path,m]))).map(method=>({route:r.path,method})));
  const waivedRouteMethods: AuditReport['waivedRouteMethods']=[],ignoredWaivers: AuditReport['ignoredWaivers']=[],redundantWaivers: AuditReport['redundantWaivers']=[];
  const uncovered=missing.filter(({route,method})=>{
    const reason=metadata.get(route)?.coveredElsewhere?.[method];
    if(reason===undefined)return true;
    // A waiver excuses a missing fixture only where the route is otherwise shown to work normally.
    const proven=[...covered].some(key=>(JSON.parse(key) as [string,string])[0]===route);
    (proven?waivedRouteMethods:ignoredWaivers).push({route,method,reason});
    return !proven;
  });
  for(const r of plan.inventory)if(r.state==='active')for(const [method,reason] of Object.entries(r.coveredElsewhere??{}))if(covered.has(JSON.stringify([r.path,method])))redundantWaivers.push({route:r.path,method,reason});
  const counts: AuditReport['counts']={configured:plan.inventory.length,declared:plan.inventory.filter(r=>!r.generated).length,generated:plan.inventory.filter(r=>r.generated).length,active:0,disabled:0,expired:0,byHandler:{}};
  for(const route of plan.inventory){counts[route.state]++;const handler=String(route.handler);counts.byHandler[handler]=(counts.byHandler[handler]||0)+1;}
  const countMatches=expectRoutes===undefined || counts.configured===expectRoutes;
  const advisories=plan.inventory.flatMap(route=>(route.advisories??[]).map(message=>({route:route.path,message})));
  // The per-route capability table: which policies apply and whether this
  // host enforces, compiles or delegates each one. Refusals never get here.
  const notReadyReasons=[...(counts.active>0?[]:['no-active-routes']),...(countMatches?[]:['route-count-mismatch']),...(failed?['failed-checks']:[]),...(uncovered.length?['uncovered-route-methods']:[])];
  return {elapsedMs:performance.now()-began,ready:!notReadyReasons.length,notReadyReasons,counts,expectedRoutes:expectRoutes ?? null,countMatches,checks,passed,failed,coveredRouteMethods:covered.size,unassertedCases,uncovered,waivedRouteMethods,ignoredWaivers,redundantWaivers,policies:plan.policies ?? {},compliance:compliance?await runCompliance(app,compliance):null,advisories,deploymentAdvisories:deploymentAdvisories(plan.policies ?? {},deployment)};
}
export async function benchmarkProject(app: AuditableApp,{requests=1000,concurrency=2,maxP95Ms,seconds=30,warmup=0,target}: BenchmarkOptions={}): Promise<BenchmarkReport> {
  assert(Number.isInteger(requests)&&requests>=1&&requests<=100000,'Requests must be 1–100000');
  assert(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=32,'Concurrency must be 1–32');
  assert(Number.isInteger(seconds)&&seconds>=1&&seconds<=300,'Seconds must be 1–300');
  assert(Number.isInteger(warmup)&&warmup>=0&&warmup<=10000,'Warmup must be 0–10000 requests');
  assert(maxP95Ms===undefined || (Number.isFinite(maxP95Ms)&&maxP95Ms>0),'Latency budget must be positive');
  const destination=target?benchmarkTarget(target):undefined;
  const plan=app.testPlan();const fixtures=await readCases(app.root,true);
  const cases=[...plan.cases,...fixtures].filter(c=>['GET','HEAD'].includes(c.method||'GET')&&c.status<400);
  assert(cases.length>0,'No GET/HEAD workload: add representative successful request fixtures');
  const workload=(index: number): RequestCase=>{const found=cases[index%cases.length];assert(found,'Empty workload');return found;};
  // A deployment behind TLS or a proxy is a different system from a local
  // snapshot; the workload is the same, the measurement is not interchangeable.
  const agent=destination?.protocol==='https:'
    ? new SecureAgent({keepAlive:true,maxSockets:concurrency})
    : new Agent({keepAlive:true,maxSockets:concurrency});
  const times: number[]=[],statuses: Record<string,number>={};
  let next=0,failed=0,transportErrors=0,elapsedMs: number;
  try {
    // Warm-up requests are sent and discarded: a cold snapshot, an empty
    // connection pool and a just-started worker are not what a budget is about.
    let warmed=0;
    await Promise.all(Array.from({length:Math.min(concurrency,Math.max(warmup,1))},async()=>{
      while(warmed<warmup){const index=warmed++;await hit(app,workload(index),agent,destination);}
    }));
    const began=performance.now();
    await Promise.all(Array.from({length:concurrency},async()=>{
      while(next<requests && performance.now()-began<seconds*1000){
        const index=next++;const result=await hit(app,workload(index),agent,destination);
        times.push(result.durationMs);
        if(!result.pass){failed++;if(result.status===0)transportErrors++;}
        statuses[result.status]=(statuses[result.status]||0)+1;
      }
    }));
    elapsedMs=performance.now()-began;
  } finally {agent.destroy();}
  times.sort((a,b)=>a-b);
  const percentile=(q: number)=>times[Math.max(0,Math.ceil(times.length*q)-1)] ?? null;
  const p95Ms=percentile(.95), complete=times.length===requests;
  const shed=Object.entries(statuses).filter(([status])=>['503','504'].includes(status)).reduce((n,[,count])=>n+count,0);
  return {pass:complete&&!failed&&(maxP95Ms===undefined||(p95Ms!==null&&p95Ms<=maxP95Ms)),requested:requests,completed:times.length,complete,failed,transportErrors,shedResponses:shed,concurrency,
    workloadCases:cases.length,exercisedWorkloadCases:Math.min(times.length,cases.length),
    workload:`${destination?'remote':'local'} GET/HEAD only; redirects not followed`,
    target:destination?`${destination.protocol}//${destination.hostname}:${destination.port}`:null,
    warmupRequests:warmup,elapsedMs,requestsPerSecond:times.length/elapsedMs*1000,
    p50Ms:percentile(.5),p95Ms,p99Ms:percentile(.99),maxP95Ms:maxP95Ms??null,statuses,
    // In target mode this process is the load generator, not the server: its
    // memory says nothing about the deployment under test.
    rssMiB:destination?null:process.memoryUsage().rss/2**20,node:process.version,platform:process.platform};
}
