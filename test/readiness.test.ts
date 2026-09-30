import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { project,redirect,param } from './helpers.ts';
import type { ProjectFiles, ProjectRoutes } from './helpers.ts';
import { startServer } from '../packages/core/src/server.ts';
import { auditProject,deploymentAdvisories } from '../packages/core/src/readiness.ts';
async function appFor(t: TestContext,routes: ProjectRoutes,files: ProjectFiles={}) {
 const root=await project(t,routes,files);const app=await startServer({project:root,port:0,log:()=>{}});t.after(()=>app.close());return app;
}
test('audit reconciles configured/active/disabled/expired counts and checks native routes',async t=>{
 const app=await appFor(t,{'/go':redirect(),'/off':{...redirect(),enabled:false},'/old':{...redirect(),expires:'2000-01-01T00:00:00Z'},'/status':{respond:{json:{ok:true}}},'/assets/*':{static:{directory:'public'}}},{'public/a.txt':'A','public/b.txt':'B'});
 const report=await auditProject(app,{expectRoutes:5});assert.equal(report.ready,true);assert.deepEqual(report.notReadyReasons,[]);assert.equal(report.counts.configured,5);assert.equal(report.counts.active,3);assert.equal(report.counts.disabled,1);assert.equal(report.counts.expired,1);assert.equal(report.checks,10);assert.equal(report.passed,10);
 const wrong=await auditProject(app,{expectRoutes:6});assert.equal(wrong.ready,false);assert.equal(wrong.countMatches,false);assert.deepEqual(wrong.notReadyReasons,['route-count-mismatch']);
});
test('audit --expect-routes counts routes generated from site keys and reports the split',async t=>{
 const root=await project(t,{'/status':{respond:{json:{ok:true}}}},{},{site:{robots:{disallow:['/private']}}});
 const app=await startServer({project:root,port:0,log:()=>{}});t.after(()=>app.close());
 const report=await auditProject(app,{expectRoutes:2});
 assert.equal(report.countMatches,true);assert.equal(report.counts.configured,2);assert.equal(report.counts.declared,1);assert.equal(report.counts.generated,1);
 assert.equal((await auditProject(app,{expectRoutes:1})).countMatches,false);
});
// #955: the project commits its route count once, in tests/audit.json; every audit run without the flag reads it.
test('audit reads the committed tests/audit.json when no --expect-routes is given, and the flag wins',async t=>{
 const routes={'/status':{respond:{json:{ok:true}}}};
 const committed=await appFor(t,routes,{'tests/audit.json':JSON.stringify({expectRoutes:2})});
 const report=await auditProject(committed);
 assert.deepEqual([report.expectedRoutes,report.expectedRoutesFrom,report.countMatches,report.notReadyReasons],[2,'tests/audit.json',false,['route-count-mismatch']]);
 const flagged=await auditProject(committed,{expectRoutes:1});
 assert.deepEqual([flagged.expectedRoutes,flagged.expectedRoutesFrom,flagged.ready],[1,'--expect-routes',true]);
 const none=await auditProject(await appFor(t,routes));
 assert.deepEqual([none.expectedRoutes,none.expectedRoutesFrom,none.ready],[null,null,true]);
 for(const bad of ['{"expectRoutes":-1}','{"expectRoutes":1,"extra":true}','[1]','nope']){
  const app=await appFor(t,routes,{'tests/audit.json':bad});
  await assert.rejects(auditProject(app),(error:Error&{details?:{code?:string}})=>error.details?.code==='invalid-audit-expectation'&&/tests\/audit\.json/.test(error.message),bad);
 }
});
test('audit requires concrete function/parameter fixtures and covers methods separately',async t=>{
 const routes={'/hello/{id}':{parameters:[param('id')],function:{source:'hello.mjs'}}};
 const files={'hello.mjs':'export default () => new Response("hello")'};
 const missing=await appFor(t,routes,files);const report=await auditProject(missing);assert.equal(report.ready,false);assert.deepEqual(report.uncovered.map(x=>x.method),['GET','HEAD']);assert.deepEqual(report.notReadyReasons,['uncovered-route-methods']);
 const fixtures=[{path:'/hello/Ada',status:200,expectBody:'hello'},{path:'/hello/Ada',method:'HEAD',status:200,expectBody:''}];
 const app=await appFor(t,routes,{...files,'tests/requests.json':JSON.stringify(fixtures)});assert.equal((await auditProject(app)).ready,true);
});
test('wrong bodies and shadowed parameter fixtures cannot create false readiness',async t=>{
 const app=await appFor(t,{'/item/{id}':{parameters:[param('id')],function:{source:'f.mjs'}},'/item/exact':redirect()},{'f.mjs':'export default () => new Response("wrong")','tests/requests.json':JSON.stringify([{path:'/item/x',status:200,expectBody:'expected'},{path:'/item/exact',status:302}])});
 const report=await auditProject(app);assert.equal(report.ready,false);assert.equal(report.failed,1);assert.deepEqual(report.notReadyReasons,['failed-checks','uncovered-route-methods']);assert.equal(report.uncovered.length,2);assert.ok(report.uncovered.every(r=>r.route==='/item/{id}'));
});
test('negative fixtures and empty projects do not qualify as ready',async t=>{
 const app=await appFor(t,{'/f':{function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("broken",{status:500})','tests/requests.json':JSON.stringify([{path:'/f',status:500}])});
 assert.equal((await auditProject(app)).ready,false);
 assert.deepEqual((await auditProject(await appFor(t,{}))).notReadyReasons,['no-active-routes']);
});
test('status-only success is not enough to cover a function response',async t=>{
 const app=await appFor(t,{'/f':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("wrong-business-result")','tests/requests.json':JSON.stringify([{path:'/f',status:200}])});
 const report=await auditProject(app);assert.equal(report.ready,false);assert.equal(report.passed,1);assert.deepEqual(report.unassertedCases,[1]);assert.equal(report.uncovered.length,1);
});
test('audit advises, but never fails, on a webhook-shaped route missing sandbox/sandboxReason',async t=>{
 const webhookFile={'f.mjs':'export default () => new Response("ok")','tests/requests.json':JSON.stringify([{path:'/hook',method:'POST',status:200,expectBody:'ok'}])};
 const flagged=await appFor(t,{'/hook':{methods:['POST'],request:{body:{ POST: {maxBytes:65536} }},function:{source:'f.mjs'}}},webhookFile);
 const flaggedReport=await auditProject(flagged);
 assert.deepEqual(flaggedReport.advisories,[{route:'/hook',message:"This route accepts POST with a declared request.body.POST policy but declares neither sandbox: true nor sandboxReason; record the trust decision. Untrusted input alone is not a reason to sandbox: validate it with request.body.POST.schema and parameters. Reviewed first-party code stays trusted (the default; the filesystem, node:crypto signature checks, fetch and npm packages exist only there): add to the route: sandboxReason: \"Reviewed first-party code; trusted deliberately.\" Add sandbox: true only when the route's own code is unreviewed or contributed, or must not be able to leak a granted secret, with a sandboxReason saying why."}]);
 // #586: following the advisory for a signed webhook must not lead to a sandbox that cannot verify the signature.
 assert.doesNotMatch(flaggedReport.advisories[0]!.message,/isolates untrusted input/);
 assert.equal(flaggedReport.ready,true,'an advisory never blocks readiness');

 const sandboxed=await appFor(t,{'/hook':{methods:['POST'],sandbox:true,request:{body:{ POST: {maxBytes:65536} }},function:{source:'f.mjs'}}},webhookFile);
 assert.deepEqual((await auditProject(sandboxed)).advisories,[],'sandbox: true silences the advisory');

 const explained=await appFor(t,{'/hook':{methods:['POST'],sandboxReason:'Reviewed first-party code; trusted deliberately.',request:{body:{ POST: {maxBytes:65536} }},function:{source:'f.mjs'}}},webhookFile);
 assert.deepEqual((await auditProject(explained)).advisories,[],'a declared sandboxReason silences the advisory even with sandbox: false');

 const noBody=await appFor(t,{'/hook':{methods:['POST'],function:{source:'f.mjs'}}},webhookFile);
 assert.deepEqual((await auditProject(noBody)).advisories,[],'no declared request.body policy: nothing to flag');

 const getOnly=await appFor(t,{'/hook':{methods:['GET'],request:{body:{ GET: {maxBytes:65536} }},function:{source:'f.mjs'}}},webhookFile);
 assert.deepEqual((await auditProject(getOnly)).advisories,[],'GET routes are not webhook-shaped');
});

const waiverFiles={'f.mjs':'export default () => new Response("ok")','tests/requests.json':JSON.stringify([{path:'/f',status:200,expectBody:'ok'}])};
test('coveredElsewhere waives one method, lists it with its reason, and keeps ready visible',async t=>{
 const app=await appFor(t,{'/f':{methods:['GET','POST'],coveredElsewhere:{POST:'store tests cover it'},function:{source:'f.mjs'}}},waiverFiles);
 const report=await auditProject(app);
 assert.equal(report.ready,true);assert.deepEqual(report.uncovered,[]);
 assert.deepEqual(report.waivedRouteMethods,[{route:'/f',method:'POST',reason:'store tests cover it',basis:'route-covered'}]);
 const bare=await auditProject(await appFor(t,{'/f':{methods:['GET','POST'],function:{source:'f.mjs'}}},waiverFiles));
 assert.equal(bare.ready,false);assert.deepEqual(bare.uncovered,[{route:'/f',method:'POST'}]);assert.deepEqual(bare.waivedRouteMethods,[]);
});
test('a waiver cannot hide an error-only function route or a route with no fixture',async t=>{
 const errorOnly=await appFor(t,{'/f':{methods:['GET'],coveredElsewhere:{GET:'nope'},function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("x",{status:500})','tests/requests.json':JSON.stringify([{path:'/f',status:500}])});
 const a=await auditProject(errorOnly);assert.equal(a.ready,false);assert.deepEqual(a.uncovered,[{route:'/f',method:'GET'}]);assert.deepEqual(a.waivedRouteMethods,[]);assert.equal(a.ignoredWaivers.length,1);
 const none=await appFor(t,{'/f':{methods:['GET'],coveredElsewhere:{GET:'nope'},function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("x")'});
 assert.equal((await auditProject(none)).ready,false);
});
test('a waiver on a pair that already has a passing fixture is reported as redundant',async t=>{
 const app=await appFor(t,{'/f':{coveredElsewhere:{GET:'also covered'},function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("ok")','tests/requests.json':JSON.stringify([{path:'/f',status:200,expectBody:'ok'},{path:'/f',method:'HEAD',status:200,expectBody:''}])});
 const report=await auditProject(app);assert.equal(report.ready,true);assert.deepEqual(report.redundantWaivers,[{route:'/f',method:'GET',reason:'also covered'}]);assert.deepEqual(report.waivedRouteMethods,[]);
});
test('coveredElsewhere rejects empty reasons, unknown methods and non-route methods',async t=>{
 for(const waiver of [{POST:''},{POST:'   '},{POST:'r'},{FETCH:'r'},{}]){
  const root=await project(t,{'/f':{methods:['GET'],coveredElsewhere:waiver,function:{source:'f.mjs'}}},waiverFiles);
  await assert.rejects(startServer({project:root,port:0,log:()=>{}}));
 }
});
test('the published coverage-waiver example audits ready with the waiver listed',async t=>{
 const {fileURLToPath}=await import('node:url');
 const app=await startServer({project:fileURLToPath(new URL('../examples/coverage-waiver',import.meta.url)),port:0,log:()=>{}});t.after(()=>app.close());
 const report=await auditProject(app);assert.equal(report.ready,true);assert.equal(report.waivedRouteMethods.length,1);assert.deepEqual(report.uncovered,[]);
});

test('audit names a client throttle without trusted proxies and metrics on the public listener (#575)',async t=>{
 const throttled={policies:{throttle:{quota:100,window:60}}};
 const app=await appFor(t,{'/go':{...redirect(),...throttled},'/pooled':{...redirect(),policies:{throttle:{quota:100,window:60,partition:'route'}}},'/free':redirect()});
 const report=await auditProject(app);
 assert.deepEqual(report.deploymentAdvisories.map(a=>[a.code,a.routes]),[['client-throttle-without-trusted-proxies',['/go']]]);
 assert.equal(report.ready,report.notReadyReasons.length===0,'advisories never change readiness');
 const declared=await auditProject(app,{deployment:{trustedProxies:'10.0.0.0/8',metrics:true}});
 assert.deepEqual(declared.deploymentAdvisories.map(a=>a.code),['metrics-on-public-listener']);
 assert.deepEqual(deploymentAdvisories({'/x':{throttle:{partition:'route',target:'native'}}}),[]);
 assert.throws(()=>deploymentAdvisories({},{trustedProxies:'not-an-address'}),/Invalid trusted proxy/);
});
