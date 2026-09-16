import test from 'node:test';
import assert from 'node:assert/strict';
import { project,redirect,param } from './helpers.js';
import { startServer } from '../src/server.js';
import { auditProject,benchmarkProject } from '../src/readiness.js';
async function appFor(t,routes,files={}) {
 const root=await project(t,routes,files);const app=await startServer({project:root,port:0,log:()=>{}});t.after(()=>app.close());return app;
}
test('audit reconciles configured/active/disabled/expired counts and checks native routes',async t=>{
 const app=await appFor(t,{'/go':redirect(),'/off':{...redirect(),enabled:false},'/old':{...redirect(),expires:'2000-01-01T00:00:00Z'},'/status':{respond:{json:{ok:true}}},'/assets/*':{static:{directory:'public'}}},{'public/a.txt':'A','public/b.txt':'B'});
 const report=await auditProject(app,{expectRoutes:5});assert.equal(report.ready,true);assert.equal(report.counts.configured,5);assert.equal(report.counts.active,3);assert.equal(report.counts.disabled,1);assert.equal(report.counts.expired,1);assert.equal(report.checks,10);assert.equal(report.passed,10);
 const wrong=await auditProject(app,{expectRoutes:6});assert.equal(wrong.ready,false);assert.equal(wrong.countMatches,false);
});
test('audit requires concrete function/parameter fixtures and covers methods separately',async t=>{
 const routes={'/hello/{id}':{parameters:[param('id')],function:{source:'hello.mjs'}}};
 const files={'hello.mjs':'export default () => new Response("hello")'};
 const missing=await appFor(t,routes,files);const report=await auditProject(missing);assert.equal(report.ready,false);assert.deepEqual(report.uncovered.map(x=>x.method),['GET','HEAD']);
 const fixtures=[{path:'/hello/Ada',status:200,expectBody:'hello'},{path:'/hello/Ada',method:'HEAD',status:200,expectBody:''}];
 const app=await appFor(t,routes,{...files,'tests/requests.json':JSON.stringify(fixtures)});assert.equal((await auditProject(app)).ready,true);
});
test('wrong bodies and shadowed parameter fixtures cannot create false readiness',async t=>{
 const app=await appFor(t,{'/item/{id}':{parameters:[param('id')],function:{source:'f.mjs'}},'/item/exact':redirect()},{'f.mjs':'export default () => new Response("wrong")','tests/requests.json':JSON.stringify([{path:'/item/x',status:200,expectBody:'expected'},{path:'/item/exact',status:302}])});
 const report=await auditProject(app);assert.equal(report.ready,false);assert.equal(report.failed,1);assert.equal(report.uncovered.length,2);assert.ok(report.uncovered.every(r=>r.route==='/item/{id}'));
});
test('negative fixtures and empty projects do not qualify as ready',async t=>{
 const app=await appFor(t,{'/f':{function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("broken",{status:500})','tests/requests.json':JSON.stringify([{path:'/f',status:500}])});
 assert.equal((await auditProject(app)).ready,false);
 assert.equal((await auditProject(await appFor(t,{}))).ready,false);
});
test('benchmark is local, checks responses, reports counts/latency, and enforces thresholds',async t=>{
 const app=await appFor(t,{'/go':redirect('https://destination.invalid/not-followed')});
 const report=await benchmarkProject(app,{requests:20,concurrency:2});assert.equal(report.pass,true);assert.equal(report.completed,20);assert.equal(report.statuses[302],20);assert.ok(report.p99Ms>=report.p50Ms);
 const slow=await benchmarkProject(app,{requests:2,maxP95Ms:0.000001});assert.equal(slow.pass,false);
 for(const options of [{requests:0},{concurrency:100},{seconds:0}])await assert.rejects(benchmarkProject(app,options));
});
test('benchmark excludes POST fixtures and reports wrong response assertions',async t=>{
 const app=await appFor(t,{'/f':{methods:['GET','POST'],function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("actual")','tests/requests.json':JSON.stringify([{path:'/f',method:'POST',status:200},{path:'/f',status:200,expectBody:'expected'}])});
 const report=await benchmarkProject(app,{requests:3,concurrency:1});assert.equal(report.workloadCases,1);assert.equal(report.failed,3);assert.equal(report.pass,false);
});

test('benchmark scheduling budget reports an incomplete run instead of claiming success',async t=>{
 const app=await appFor(t,{'/slow':{function:{source:'slow.mjs'}}},{'slow.mjs':'export default async () => { await new Promise(r=>setTimeout(r,100)); return new Response("ok"); }','tests/requests.json':JSON.stringify([{path:'/slow',status:200,expectBody:'ok'}])});
 const report=await benchmarkProject(app,{requests:1000,concurrency:1,seconds:1});assert.equal(report.complete,false);assert.equal(report.pass,false);assert.ok(report.completed>0&&report.completed<1000);
});
test('status-only success is not enough to cover a function response',async t=>{
 const app=await appFor(t,{'/f':{methods:['GET'],function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("wrong-business-result")','tests/requests.json':JSON.stringify([{path:'/f',status:200}])});
 const report=await auditProject(app);assert.equal(report.ready,false);assert.equal(report.passed,1);assert.deepEqual(report.unassertedCases,[1]);assert.equal(report.uncovered.length,1);
});
