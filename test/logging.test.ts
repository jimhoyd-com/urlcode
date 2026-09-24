import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonLogger, createDevEventFormatter } from '../packages/core/src/logging.ts';
test('slow log collectors do not accumulate unlimited request records', () => {
  const written: unknown[] = [];
  const stream = { writableLength:100,destroyed:false,write:(value: string) => written.push(JSON.parse(value)) };
  const log = createJsonLogger(stream,100);
  for (let i=0;i<10000;i++) log({event:'request',status:200});
  assert.equal(written.length,0);
  stream.writableLength = 0; log({event:'request',status:200});
  assert.deepEqual(written,[{event:'logs_dropped',count:10000},{event:'request',status:200}]);
});
test('asynchronous and synchronous sink failures do not escape the logger', async()=>{
 const {Writable}=await import('node:stream');
 const sink=new Writable({write(_chunk,_encoding,done){done(new Error('collector failed'));}});
 const log=createJsonLogger(sink);log({event:'request'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(sink.destroyed,true);assert.doesNotThrow(()=>log({event:'request'}));
 const broken={write(): never{throw new Error('failed');},writableLength:0};
 assert.doesNotThrow(()=>createJsonLogger(broken)({event:'request'}));
 const shared=new Writable({write(_chunk,_encoding,done){done();}});
 createJsonLogger(shared);createJsonLogger(shared);assert.equal(shared.listenerCount('error'),1);shared.destroy();
});
test('a format function renders known events as one human line and falls back to JSON for the rest (#589)', () => {
  const written: string[] = [];
  const stream = { writableLength:0,destroyed:false,write:(value: string) => written.push(value) };
  const routes = { count: 0 };
  const log = createJsonLogger(stream, 1048576, createDevEventFormatter(routes));
  log({ event:'request', requestId:'a', status:302, durationMs:0.9, method:'GET', route:'/go' });
  assert.equal(written.at(-1), 'GET /go 302 0.9ms\n');
  // minimal request-log carries no method/route: the line degrades to status and duration only.
  log({ event:'request', requestId:'b', status:200, durationMs:1 });
  assert.equal(written.at(-1), '200 1ms\n');
  // An empty project's unmatched request gets a one-line hint, only while routes.count stays 0.
  log({ event:'request', requestId:'c', status:404, durationMs:0.2, method:'GET', route:null });
  assert.equal(written.at(-1), 'GET (unmatched) 404 0.2ms — no routes configured; add one to urlcode.yaml\n');
  routes.count = 3;
  log({ event:'request', requestId:'d', status:404, durationMs:0.2, method:'GET', route:null });
  assert.equal(written.at(-1), 'GET (unmatched) 404 0.2ms\n');
  log({ event:'reload', status:'ok', version:'x', routes:5 });
  assert.equal(written.at(-1), 'Reloaded — 5 routes\n');
  assert.equal(routes.count, 5, 'a successful reload updates the box the request formatter reads');
  log({ event:'reload', status:'rejected' });
  assert.equal(written.at(-1), 'Reload rejected — kept serving the previous version\n');
  log({ event:'watch', status:'failed' });
  assert.equal(written.at(-1), 'Could not watch the project for changes\n');
  // An event this formatter does not know about still falls back to a JSON line.
  log({ event:'function_worker', status:'started', slot:0 });
  assert.deepEqual(JSON.parse(written.at(-1)!), { event:'function_worker', status:'started', slot:0 });
  // logs_dropped always stays JSON, whatever the formatter would have done with it, once output becomes writable again.
  const bounded = { writableLength:100,destroyed:false,write:(value: string) => written.push(value) };
  const boundedLog = createJsonLogger(bounded, 1, createDevEventFormatter({ count:0 }));
  boundedLog({ event:'request', status:200 });
  bounded.writableLength = 0; boundedLog({ event:'request', status:200, durationMs:1 });
  assert.deepEqual(JSON.parse(written.at(-2)!), { event:'logs_dropped', count:1 });
  assert.equal(written.at(-1), '200 1ms\n');
});
