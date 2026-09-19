import { request, Agent } from 'node:http';
import type { IncomingMessage, ClientRequest, RequestOptions } from 'node:http';
import { request as secureRequest, Agent as SecureAgent } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { safeFile } from './config.ts';
import { assert } from './errors.ts';
import { parseTarget, matchRoute, contextFor, redirectLocation } from './router.ts';
import { runCompliance } from './compliance.ts';
import type { CompiledRedirect, CompiledRoute, LogFn, PlanInventoryEntry, PolicyInventory } from './types.ts';
import type { ComplianceOptions, ComplianceReport } from './compliance.ts';
import type { CompiledRoutes, RequestContext } from './match.ts';

export type { RouteState } from './types.ts';
export type HandlerName = 'extension' | 'proxy' | 'conditional' | 'redirect' | 'function' | 'page' | 'static' | 'download' | 'respond';
/** One configured route as the inventory reports it: a PlanInventoryEntry with the handler kind named. */
export interface RouteInventory extends PlanInventoryEntry {
  handler: HandlerName | undefined;
  /** Non-blocking `audit` observations about this route (e.g. a webhook-shaped
   * route with no declared `sandbox`/`sandboxReason`); never affects `ready`. */
  advisories?: string[];
}
/** One request case: a generated probe or a `tests/requests.json` fixture. */
export interface RequestCase {
  path: string; method?: string | undefined; status: number; headers?: Record<string, string> | undefined; body?: string | undefined;
  expectHeaders?: Record<string, string> | undefined; expectBody?: string | undefined;
}
export interface ProjectPlan { inventory: RouteInventory[]; cases: RequestCase[]; resolve: (path: string) => string | undefined }
export interface HitResult { pass: boolean; status: number; durationMs: number; error?: string }
export interface BenchmarkTarget { protocol: string; hostname: string; port: number | string }
/** A started server as the audit and benchmark see it. structural: the real type is startServer's result in src/server.ts. */
export interface AuditableApp { address: AddressInfo; root: string; testPlan(): ProjectPlan & { policies?: Record<string, PolicyInventory> } }
export type { ComplianceOptions, ComplianceReport } from './compliance.ts';
export interface AuditOptions { expectRoutes?: number | undefined; log?: LogFn | undefined; compliance?: ComplianceOptions | undefined }
export interface AuditReport {
  elapsedMs: number; ready: boolean;
  counts: { configured: number; active: number; disabled: number; expired: number; byHandler: Record<string, number> };
  expectedRoutes: number | null; countMatches: boolean; checks: number; passed: number; failed: number; coveredRouteMethods: number;
  unassertedCases: number[]; uncovered: { route: string; method: string }[]; policies: Record<string, PolicyInventory>; compliance: ComplianceReport | null;
  /** Non-blocking `audit` observations, e.g. a route that looks webhook-shaped
   * but declares neither `sandbox: true` nor `sandboxReason`. Never affects `ready`. */
  advisories: { route: string; message: string }[];
}
export interface BenchmarkOptions { requests?: number | undefined; concurrency?: number | undefined; maxP95Ms?: number | undefined; seconds?: number | undefined; warmup?: number | undefined; target?: string | undefined }
export interface BenchmarkReport {
  pass: boolean; requested: number; completed: number; complete: boolean; failed: number; transportErrors: number; shedResponses: number; concurrency: number;
  workloadCases: number; exercisedWorkloadCases: number; workload: string; target: string | null; warmupRequests: number; elapsedMs: number; requestsPerSecond: number;
  p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxP95Ms: number | null; statuses: Record<string, number>; rssMiB: number | null; node: string; platform: string;
}

const handlers = ['extension','proxy','conditional','redirect','function','page','static','download','respond'] as const satisfies readonly HandlerName[];
/** Narrows a compiled route to one that redirects, so redirectLocation can read its spec. */
export const hasRedirect = (route: CompiledRoute): route is CompiledRoute & { redirect: CompiledRedirect } => Boolean(route.redirect);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// Probes identify themselves so an agents policy that denies an empty
// User-Agent does not fail every generated case; fixtures may override it.
export const probeAgent = 'Mozilla/5.0 (compatible; RouteProbe/0.1)';
// Advisory only (docs/AI-AUTHORING.md, "Deciding when a route needs sandbox: true"):
// a route that runs project code, accepts POST with a declared request.body
// policy, and declares neither `sandbox: true` nor `sandboxReason` looks
// plausibly webhook/callback/third-party-input-shaped. This is a nudge to
// look, never an inferred verdict — it never fails `audit` or changes `ready`.
function routeAdvisories(route: CompiledRoute): string[] {
  const advisories: string[] = [];
  const runsCode = Boolean(route.function) || Boolean(route.middleware?.length);
  if (runsCode && route.methods.includes('POST') && route.request?.body && !route.sandbox && !route.sandboxReason) {
    advisories.push("This route accepts POST with a declared request.body policy but declares neither sandbox: true nor sandboxReason; consider whether this route needs sandbox: true.");
  }
  return advisories;
}
export function projectPlan(compiled: CompiledRoutes<CompiledRoute>): ProjectPlan {
  const routes = [...compiled.exact.values(), ...[...compiled.byLength.values()].flat(), ...compiled.mounts];
  const now = Date.now();
  const inventory: RouteInventory[] = routes.map(route => { const advisories = routeAdvisories(route); return { path:route.pattern, handler:handlers.find(key => route[key]), methods:route.methods, middleware:route.middleware?.length || 0,
    policies:[...(route.policy ? Object.keys(route.policy.describe) : []),...(route.extensionPolicyNames??[]).map(name=>`extensions.${name}`)],
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
    try { context = contextFor(route,{},new URLSearchParams(),new Headers()); } catch { continue; }
    if (route.request?.body?.required) continue;
    const files = route.asset instanceof Map ? route.asset : undefined;
    const prefix = route.prefix ?? '';
    const paths = route.static && files ? [...files.keys()].map(key => prefix + key.split('/').map(encodeURIComponent).join('/')) : [route.pattern];
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
export async function readCases(root: string, optional = false): Promise<RequestCase[]> {
  if(optional) {
    try {await lstat(join(root,'tests/requests.json'));}
    catch(error){if(error instanceof Error && 'code' in error && error.code==='ENOENT')return [];throw error;}
  }
  const file=await safeFile(root,'tests/requests.json');
  const bytes = await readFile(file);
  assert(bytes.length <= 16*1024*1024, 'Request fixture file exceeds 16 MiB');
  const cases: unknown = JSON.parse(bytes.toString('utf8'));
  assert(Array.isArray(cases) && cases.length <= 10000 && (optional || cases.length), 'Request tests must be an array (maximum 10000)');
  for (const test of cases as unknown[]) {
    assert(isRecord(test), 'Invalid request test');
    assert(typeof test.path === 'string' && test.path.startsWith('/') && !test.path.startsWith('//') && !/[\r\n]/.test(test.path), 'Test path must be local');
    assert(Number.isInteger(test.status) && typeof test.status === 'number' && test.status >= 200 && test.status <= 599, 'Test must declare an HTTP status');
    assert(!test.method || (typeof test.method === 'string' && ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(test.method)), 'Invalid test method');
    assert(test.body === undefined || typeof test.body === 'string', 'Test body must be text');
    assert(test.expectBody === undefined || typeof test.expectBody === 'string', 'Expected body must be text');
    for (const headers of [test.headers,test.expectHeaders]) assert(headers === undefined || (isRecord(headers) && Object.values(headers).every(v => typeof v === 'string')), 'Test headers must be string mappings');
  }
  return cases as RequestCase[]; // trust boundary: fixture JSON, validated field by field above
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
        res.on('data',(chunk: Buffer)=>{size+=chunk.length;if(size>16*1024*1024)res.destroy(new Error('Response limit'));else if(test.expectBody!==undefined)chunks.push(chunk);});
        res.on('error',fail);
        res.on('end',()=>resolve({status:res.statusCode ?? 0,durationMs:performance.now()-began,
          pass:res.statusCode===test.status && Object.entries(test.expectHeaders || {}).every(([k,v])=>res.headers[k.toLowerCase()]===v) && (test.expectBody===undefined || Buffer.concat(chunks).toString()===test.expectBody)}));
      });
      req.on('error',fail);req.on('timeout',()=>req?.destroy(new Error('Timeout')));req.end(test.body);
    } catch { req?.destroy();fail(); }
  });
}
// `compliance` is the option object for runCompliance (profile, rules, ignore,
// origin, host); absent, the report carries `compliance: null` and readiness
// is unchanged. A compliance verdict is reported beside readiness, never
// folded into it: the exit code decision belongs to the caller.
export async function auditProject(app: AuditableApp, {expectRoutes,log=()=>{},compliance}: AuditOptions = {}): Promise<AuditReport> {
  const began=performance.now();
  const plan=app.testPlan(), fixtures=await readCases(app.root,true);
  const metadata=new Map(plan.inventory.map(r=>[r.path,r]));
  const cases=[...plan.cases,...fixtures], covered=new Set<string>(), unassertedCases: number[]=[];let passed=0,failed=0;
  const agent=new Agent({keepAlive:true,maxSockets:1});
  try {
    for (const [i,test] of cases.entries()) {
      const result=await hit(app,test,agent);const method=test.method || 'GET';
      let route: string|undefined;try {route=plan.resolve(test.path);} catch { /* Invalid-path negative fixture. */ }
      const meta=route===undefined?undefined:metadata.get(route);
      // Error-only fixtures cannot prove a function's normal path works.
      const assertsResponse=test.expectBody!==undefined || Object.keys(test.expectHeaders || {}).length>0;
      if(result.pass && meta?.state==='active' && result.status<400 && !assertsResponse)unassertedCases.push(i+1);
      if(result.pass && assertsResponse && meta?.state==='active' && (result.status<400 || (meta.handler==='respond' && i<plan.cases.length)))covered.add(JSON.stringify([route,method]));
      if(result.pass)passed++;else failed++;
      log({event:'check',case:i+1,source:i<plan.cases.length?'generated':'fixture',pass:result.pass,status:result.status,expectedStatus:test.status});
    }
  } finally {agent.destroy();}
  const uncovered=plan.inventory.filter(r=>r.state==='active').flatMap(r=>r.methods.filter(m=>!covered.has(JSON.stringify([r.path,m]))).map(method=>({route:r.path,method})));
  const counts: AuditReport['counts']={configured:plan.inventory.length,active:0,disabled:0,expired:0,byHandler:{}};
  for(const route of plan.inventory){counts[route.state]++;const handler=String(route.handler);counts.byHandler[handler]=(counts.byHandler[handler]||0)+1;}
  const countMatches=expectRoutes===undefined || counts.configured===expectRoutes;
  const advisories=plan.inventory.flatMap(route=>(route.advisories??[]).map(message=>({route:route.path,message})));
  // The per-route capability table: which policies apply and whether this
  // host enforces, compiles or delegates each one. Refusals never get here.
  return {elapsedMs:performance.now()-began,ready:countMatches && !failed && !uncovered.length && counts.active>0,counts,expectedRoutes:expectRoutes ?? null,countMatches,checks:cases.length,passed,failed,coveredRouteMethods:covered.size,unassertedCases,uncovered,policies:plan.policies ?? {},compliance:compliance?await runCompliance(app,compliance):null,advisories};
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
