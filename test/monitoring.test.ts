import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../packages/core/src/server.ts';
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
  // Fields are documented in OBSERVABILITY.md's catalogue, which test/observability.test.ts holds to `events`.
  for (const field of ['requestId','status','durationMs','method','route']) assert.ok(field in record,`request record is missing ${field}`);
  assert.equal(record.route,'/u/{id}');
  assert.ok(!JSON.stringify(events).includes('customer-7'));
  assert.ok(!JSON.stringify(events).includes('secret'));
});

test('reload and worker records carry the documented fields', async t => {
  const events: Record<string, unknown>[] = [];
  const root = await project(t,{'/':{sandbox:true,function:{source:'f.mjs'}}},{'f.mjs':'export default () => new Response("ok");'});
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

  for (const name of ['function_worker','reload','logs_dropped','watch']) {
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
  // Unauthenticated probes disclose status only by default; version/route
  // count are opt-in (--health-details, or implied by --metrics).
  for (const body of [health.body,ready.body]) {
    const parsed = JSON.parse(body);
    assert.ok('status' in parsed,'probe body is missing status');
    for (const field of ['version','routes']) assert.ok(!(field in parsed),`probe body unexpectedly discloses ${field} without healthDetails`);
  }
  assert.ok(docs.includes('/_urlcode/ready') && docs.includes('/_urlcode/health'));
});

test('health details are opt-in and gate on the healthDetails/metrics option', async t => {
  const root = await project(t,{'/go':redirect()});
  const app = await startServer({project:root,port:0,log:()=>{},healthDetails:true});
  t.after(() => app.close());
  const health = await request(app,'/_urlcode/health');
  const ready = await request(app,'/_urlcode/ready');
  for (const body of [health.body,ready.body]) {
    const parsed = JSON.parse(body);
    for (const field of ['status','version','routes']) assert.ok(field in parsed,`probe body is missing ${field}`);
  }
});

test('the log record table covers every cataloged event and copies none of its fields', async () => {
  const { events } = await import('../packages/core/src/observability.ts');
  const table = docs.split('## Log records')[1]?.split('\n## ')[0] ?? '';
  const missing = Object.keys(events).filter(name => !table.includes('`' + name + '`'));
  assert.deepEqual(missing,[],`MONITORING.md log records do not explain: ${missing.join(', ')}`);
  assert.ok(table.includes('OBSERVABILITY.md#event-catalogue'),'MONITORING.md log records must link the catalogue');
  assert.ok(!/^\| Event \| Fields \|/m.test(table),'MONITORING.md keeps a second copy of the event fields; link the catalogue instead');
});

test('the example alert rules are valid YAML naming real signals', async () => {
  const { parseYaml } = await import('../packages/core/src/config.ts');
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
