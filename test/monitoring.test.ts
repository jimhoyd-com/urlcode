import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.ts';
import { project, redirect, request } from './helpers.ts';

const docs = await readFile(new URL('../docs/MONITORING.md', import.meta.url),'utf8');

// Monitoring recipes are only useful if the fields they key on are the fields the
// runtime emits. These tests capture real events and hold the documentation to them.
test('request records carry the documented fields and no request text', async t => {
  const events: Record<string, unknown>[] = [];
  const root = await project(t,{'/u/{id}':{parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],...redirect()}});
  const app = await startServer({project:root,port:0,requestLog:'detailed',log:event=>events.push(event)});
  t.after(() => app.close());
  assert.equal((await request(app,'/u/customer-7?token=secret')).status,302);
  const record = events.find(event => event.event === 'request');
  assert.ok(record,'no request record was emitted');
  for (const field of ['requestId','status','durationMs','method','route']) {
    assert.ok(field in record,`request record is missing ${field}`);
    assert.ok(docs.includes(field),`MONITORING.md does not document request field ${field}`);
  }
  assert.equal(record.route,'/u/{id}');
  assert.ok(!JSON.stringify(events).includes('customer-7'));
  assert.ok(!JSON.stringify(events).includes('secret'));
});

test('reload and worker records carry the documented fields', async t => {
  const events: Record<string, unknown>[] = [];
  const root = await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("ok");'});
  const app = await startServer({project:root,port:0,log:event=>events.push(event)});
  t.after(() => app.close());

  const started = events.find(event => event.event === 'function_worker' && event.status === 'started');
  assert.ok(started,'no function_worker record was emitted');
  assert.ok('slot' in started);

  assert.equal(await app.reload(),true);
  const reload = events.find(event => event.event === 'reload');
  assert.ok(reload,'no reload record was emitted');
  for (const field of ['status','version','routes']) assert.ok(field in reload,`reload record is missing ${field}`);
  assert.equal(reload.status,'ok');

  // A reload that cannot compile must report rejected rather than go silent.
  await writeFile(join(app.root,'urlcode.yaml'),'version: "1"\nroutes: { "/": { redirect: { url: "not a url" } } }\n');
  assert.equal(await app.reload(),false);
  assert.equal(events.filter(event => event.event === 'reload').at(-1)?.status,'rejected');

  for (const name of ['function_worker','reload','logs_dropped','link_store_worker','management_request','watch']) {
    assert.ok(docs.includes(name),`MONITORING.md does not document the ${name} event`);
  }
});

test('readiness separates liveness from serving capacity', async t => {
  const root = await project(t,{'/go':redirect()});
  const app = await startServer({project:root,port:0,log:()=>{}});
  t.after(() => app.close());
  const health = await request(app,'/_urlcode/health');
  const ready = await request(app,'/_urlcode/ready');
  assert.equal(health.status,200);
  assert.equal(ready.status,200);
  for (const body of [health.body,ready.body]) {
    const parsed = JSON.parse(body);
    for (const field of ['status','version','routes']) assert.ok(field in parsed,`probe body is missing ${field}`);
  }
  assert.ok(docs.includes('/_urlcode/ready') && docs.includes('/_urlcode/health'));
});

test('every operational event the runtime emits is documented', async () => {
  // The first check runs documentation -> code. This one runs code ->
  // documentation, which is the direction that catches a new event landing
  // without a line explaining what an operator should do about it.
  const dir = fileURLToPath(new URL('../src', import.meta.url));
  const emitted = new Set<string>();
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.ts')) continue;
    for (const [,name] of (await readFile(join(dir,file),'utf8')).matchAll(/event:\s*'([a-z_-]+)'/g)) emitted.add(name ?? '');
  }
  // Command and build-tool output, not operational records an operator scrapes
  // from a server. Nothing here is ever emitted by a serving process.
  const cliOutput = new Set(['listening','link-management-listening','link-store-initialized','added','created','valid','error','test','check','finding',
    'link-export-begin','link-export-complete','link-import-complete','prerendered','native-project','prerender-passes']);
  const undocumented = [...emitted].filter(name => !cliOutput.has(name) && !docs.includes(name));
  assert.deepEqual(undocumented,[],`MONITORING.md does not document: ${undocumented.join(', ')}`);
  assert.ok(emitted.has('request') && emitted.has('link_observer'),'event scan found nothing; the pattern has drifted');
});

test('the example alert rules are valid YAML naming real signals', async () => {
  const { parseYaml } = await import('../src/config.ts');
  const file = fileURLToPath(new URL('../examples/monitoring/prometheus-rules.yaml', import.meta.url));
  interface AlertRule { alert?: unknown; expr?: unknown; annotations?: { summary?: unknown } }
  const rules = parseYaml(await readFile(file,'utf8')) as { groups: { rules: AlertRule[] }[] };
  const alerts = rules.groups.flatMap(group => group.rules);
  assert.ok(alerts.length >= 4,'expected several alert rules');
  for (const alert of alerts) {
    assert.ok(typeof alert.alert === 'string' && alert.expr,'every rule needs a name and an expression');
    assert.ok(alert.annotations?.summary,`${alert.alert} has no summary`);
    assert.ok(docs.includes(alert.alert),`MONITORING.md does not explain ${alert.alert}`);
  }
});
