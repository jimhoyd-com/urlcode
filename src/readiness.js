import { request, Agent } from 'node:http';
import { join } from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import { safeFile } from './config.js';
import { assert } from './errors.js';
import { parseTarget, matchRoute, contextFor, redirectLocation } from './router.js';

const handlers = ['redirect','function','page','static','download','respond','link'];
export function projectPlan(compiled) {
  const routes = [...compiled.exact.values(), ...[...compiled.byLength.values()].flat(), ...compiled.mounts];
  const now = Date.now();
  const inventory = routes.map(route => ({ path:route.pattern, handler:handlers.find(key => route[key]), methods:route.methods, middleware:route.middleware?.length || 0,
    state:route.enabled === false ? 'disabled' : route.expiresAt && now >= route.expiresAt ? 'expired' : 'active' }));
  const cases = [];
  for (const [i,route] of routes.entries()) {
    if (inventory[i].state !== 'active') {
      if(!route.names.length && !route.static) cases.push({path:route.pattern,method:'GET',status:inventory[i].state==='disabled'?404:410});
      continue;
    }
    if (route.function || route.link || route.middleware?.length || route.names.length) continue;
    // Required inputs need intentional fixtures; never invent business data.
    let context;
    try { context = contextFor(route,{},new URLSearchParams(),new Headers()); } catch { continue; }
    if (route.request?.body?.required) continue;
    const paths = route.static ? [...route.asset.keys()].map(key => route.prefix + key.split('/').map(encodeURIComponent).join('/')) : [route.pattern];
    for (const path of paths) for (const method of route.methods) {
      if (!['GET','HEAD'].includes(method)) continue;
      const test = {path,method,status:(route.redirect ? route.redirect.status || 302 : route.reply?.status || 200)};
      if (route.redirect) test.expectHeaders = {location:redirectLocation(route,context,new URLSearchParams())};
      const asset=route.static ? route.asset.get(decodeURIComponent(path.slice(route.prefix.length))) : route.asset;
      if(asset) test.expectHeaders={'content-type':asset.type,etag:asset.etag,'content-length':String(asset.body.length)};
      if (route.reply && method !== 'HEAD') test.expectBody = route.reply.body.toString();
      if (method === 'HEAD') test.expectBody = '';
      cases.push(test);
    }
  }
  return {inventory,cases,resolve:path => matchRoute(compiled,parseTarget(path))?.route.pattern};
}
export async function readCases(root, optional = false) {
  if(optional) {
    try {await lstat(join(root,'tests/requests.json'));}
    catch(error){if(error.code==='ENOENT')return [];throw error;}
  }
  const file=await safeFile(root,'tests/requests.json');
  const bytes = await readFile(file);
  assert(bytes.length <= 16*1024*1024, 'Request fixture file exceeds 16 MiB');
  const cases = JSON.parse(bytes);
  assert(Array.isArray(cases) && cases.length <= 10000 && (optional || cases.length), 'Request tests must be an array (maximum 10000)');
  for (const test of cases) {
    assert(test && typeof test === 'object' && !Array.isArray(test), 'Invalid request test');
    assert(typeof test.path === 'string' && test.path.startsWith('/') && !test.path.startsWith('//') && !/[\r\n]/.test(test.path), 'Test path must be local');
    assert(Number.isInteger(test.status) && test.status >= 200 && test.status <= 599, 'Test must declare an HTTP status');
    assert(!test.method || ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(test.method), 'Invalid test method');
    assert(test.body === undefined || typeof test.body === 'string', 'Test body must be text');
    assert(test.expectBody === undefined || typeof test.expectBody === 'string', 'Expected body must be text');
    for (const headers of [test.headers,test.expectHeaders]) assert(headers === undefined || (headers && typeof headers === 'object' && !Array.isArray(headers) && Object.values(headers).every(v => typeof v === 'string')), 'Test headers must be string mappings');
  }
  return cases;
}
export function hit(app,test,agent) {
  return new Promise(resolve => {
    const began=performance.now();
    const fail=()=>resolve({pass:false,status:0,durationMs:performance.now()-began,error:'transport'});
    let req;
    try {
      req=request({host:'127.0.0.1',port:app.address.port,path:test.path,method:test.method || 'GET',headers:test.headers || {},agent,timeout:10000},res=>{
        let size=0;const chunks=[];
        res.on('data',chunk=>{size+=chunk.length;if(size>16*1024*1024)res.destroy(new Error('Response limit'));else if(test.expectBody!==undefined)chunks.push(chunk);});
        res.on('error',fail);
        res.on('end',()=>resolve({status:res.statusCode,durationMs:performance.now()-began,
          pass:res.statusCode===test.status && Object.entries(test.expectHeaders || {}).every(([k,v])=>res.headers[k.toLowerCase()]===v) && (test.expectBody===undefined || Buffer.concat(chunks).toString()===test.expectBody)}));
      });
      req.on('error',fail);req.on('timeout',()=>req.destroy(new Error('Timeout')));req.end(test.body);
    } catch { req?.destroy();fail(); }
  });
}
export async function auditProject(app, {expectRoutes,log=()=>{}} = {}) {
  const began=performance.now();
  const plan=app.testPlan(), fixtures=await readCases(app.root,true);
  const metadata=new Map(plan.inventory.map(r=>[r.path,r]));
  const cases=[...plan.cases,...fixtures], covered=new Set(), unassertedCases=[];let passed=0,failed=0;
  const agent=new Agent({keepAlive:true,maxSockets:1});
  try {
    for (const [i,test] of cases.entries()) {
      const result=await hit(app,test,agent);const method=test.method || 'GET';
      let route;try {route=plan.resolve(test.path);} catch { /* Invalid-path negative fixture. */ }
      const meta=metadata.get(route);
      // Error-only fixtures cannot prove a function's normal path works.
      const assertsResponse=test.expectBody!==undefined || Object.keys(test.expectHeaders || {}).length>0;
      if(result.pass && meta?.state==='active' && result.status<400 && !assertsResponse)unassertedCases.push(i+1);
      if(result.pass && assertsResponse && meta?.state==='active' && (result.status<400 || (meta.handler==='respond' && i<plan.cases.length)))covered.add(JSON.stringify([route,method]));
      if(result.pass)passed++;else failed++;
      log({event:'check',case:i+1,source:i<plan.cases.length?'generated':'fixture',pass:result.pass,status:result.status,expectedStatus:test.status});
    }
  } finally {agent.destroy();}
  const uncovered=plan.inventory.filter(r=>r.state==='active').flatMap(r=>r.methods.filter(m=>!covered.has(JSON.stringify([r.path,m]))).map(method=>({route:r.path,method})));
  const counts={configured:plan.inventory.length,active:0,disabled:0,expired:0,byHandler:{}};
  for(const route of plan.inventory){counts[route.state]++;counts.byHandler[route.handler]=(counts.byHandler[route.handler]||0)+1;}
  const countMatches=expectRoutes===undefined || counts.configured===expectRoutes;
  return {dynamicLinks:plan.dynamicLinks,elapsedMs:performance.now()-began,ready:countMatches && !failed && !uncovered.length && counts.active>0,counts,expectedRoutes:expectRoutes ?? null,countMatches,checks:cases.length,passed,failed,coveredRouteMethods:covered.size,unassertedCases,uncovered};
}
export async function benchmarkProject(app,{requests=1000,concurrency=2,maxP95Ms,seconds=30}={}) {
  assert(Number.isInteger(requests)&&requests>=1&&requests<=100000,'Requests must be 1–100000');
  assert(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=32,'Concurrency must be 1–32');
  assert(Number.isInteger(seconds)&&seconds>=1&&seconds<=300,'Seconds must be 1–300');
  assert(maxP95Ms===undefined || (Number.isFinite(maxP95Ms)&&maxP95Ms>0),'Latency budget must be positive');
  const plan=app.testPlan();const fixtures=await readCases(app.root,true);
  const cases=[...plan.cases,...fixtures].filter(c=>['GET','HEAD'].includes(c.method||'GET')&&c.status<400);
  assert(cases.length>0,'No GET/HEAD workload: add representative successful request fixtures');
  const agent=new Agent({keepAlive:true,maxSockets:concurrency}),times=[],statuses={};
  let next=0,failed=0;const began=performance.now();
  try {await Promise.all(Array.from({length:concurrency},async()=>{
    while(next<requests && performance.now()-began<seconds*1000){
      const index=next++;const result=await hit(app,cases[index%cases.length],agent);
      times.push(result.durationMs);if(!result.pass)failed++;statuses[result.status]=(statuses[result.status]||0)+1;
    }
  }));}finally{agent.destroy();}
  const elapsedMs=performance.now()-began;times.sort((a,b)=>a-b);
  const percentile=q=>times[Math.max(0,Math.ceil(times.length*q)-1)] ?? null;
  const p95Ms=percentile(.95), complete=times.length===requests;
  return {pass:complete&&!failed&&(maxP95Ms===undefined||p95Ms<=maxP95Ms),requested:requests,completed:times.length,complete,failed,concurrency,
    workloadCases:cases.length,exercisedWorkloadCases:Math.min(times.length,cases.length),workload:'local GET/HEAD only; redirects not followed',warmupRequests:0,elapsedMs,requestsPerSecond:times.length/elapsedMs*1000,
    p50Ms:percentile(.5),p95Ms,p99Ms:percentile(.99),maxP95Ms:maxP95Ms??null,statuses,rssMiB:process.memoryUsage().rss/2**20,node:process.version,platform:process.platform};
}
