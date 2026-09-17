import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.ts';
import { benchmarkProject, benchmarkTarget } from '../src/readiness.ts';
import { project, redirect } from './helpers.ts';

// A benchmark that can only measure a server it started itself cannot answer the
// question that matters: how the real deployment behaves behind its own proxy.
test('a benchmark can measure a separately running deployment', async t => {
  const root = await project(t,{'/go':redirect()});
  const deployment = await startServer({project:root,port:0,log:()=>{}});
  t.after(() => deployment.close());
  // A second runtime supplies the workload plan; load goes to the first.
  const planner = await startServer({project:root,port:0,log:()=>{}});
  t.after(() => planner.close());

  let served = 0;
  deployment.server.on('request',() => served++);

  const report = await benchmarkProject(planner,{
    requests:20,concurrency:2,warmup:4,
    target:`http://127.0.0.1:${deployment.address.port}`});

  assert.equal(report.pass,true,JSON.stringify(report));
  assert.equal(report.completed,20);
  assert.equal(report.target,`http://127.0.0.1:${deployment.address.port}`);
  assert.match(report.workload,/^remote /);
  assert.equal(report.warmupRequests,4);
  // Warm-up traffic reaches the deployment but never enters the measurement.
  assert.equal(served,24);
  // This process is the load generator; reporting its memory would mislead.
  assert.equal(report.rssMiB,null);
});

test('a local benchmark still reports the runtime it measured', async t => {
  const root = await project(t,{'/go':redirect()});
  const app = await startServer({project:root,port:0,log:()=>{}});
  t.after(() => app.close());
  const report = await benchmarkProject(app,{requests:10,concurrency:1,warmup:2});
  assert.equal(report.target,null);
  assert.match(report.workload,/^local /);
  assert.equal(typeof report.rssMiB,'number');
  assert.equal(report.warmupRequests,2);
});

test('shed responses and transport errors are counted separately', async t => {
  const root = await project(t,{'/go':redirect()});
  const app = await startServer({project:root,port:0,log:()=>{}});
  t.after(() => app.close());
  // Nothing listens here, so every request is a transport failure rather than
  // a response the deployment chose to shed.
  const report = await benchmarkProject(app,{requests:4,concurrency:1,target:'http://127.0.0.1:1'});
  assert.equal(report.pass,false);
  assert.equal(report.failed,4);
  assert.equal(report.transportErrors,4);
  assert.equal(report.shedResponses,0);
});

test('a target must be a bare HTTP(S) origin', async t => {
  for (const value of ['not-a-url','ftp://example.com','https://example.com/path','https://user:pw@example.com','']) {
    assert.throws(() => benchmarkTarget(value),/Target must be/,`accepted ${value}`);
  }
  assert.deepEqual(benchmarkTarget('https://links.example'),{protocol:'https:',hostname:'links.example',port:443});
  assert.deepEqual(benchmarkTarget('http://127.0.0.1:3000'),{protocol:'http:',hostname:'127.0.0.1',port:'3000'});

  const root = await project(t,{'/go':redirect()});
  const app = await startServer({project:root,port:0,log:()=>{}});
  t.after(() => app.close());
  await assert.rejects(benchmarkProject(app,{requests:2,target:'https://example.com/path'}),/Target must be/);
  await assert.rejects(benchmarkProject(app,{requests:2,warmup:-1}),/Warmup must be/);
});
