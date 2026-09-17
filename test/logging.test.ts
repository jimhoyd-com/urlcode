import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonLogger } from '../src/logging.ts';
import type { Writable } from 'node:stream';
// The logger only touches write, writableLength, destroyed and (optionally) on,
// so a test sink is a partial stream. Boundary cast until createJsonLogger
// declares that narrower contract instead of the full Writable.
const asSink = (partial: { write(value: string): unknown; writableLength: number; destroyed?: boolean }): Writable => partial as unknown as Writable;
test('slow log collectors do not accumulate unlimited request records', () => {
  const written: unknown[] = [];
  const stream = { writableLength:100,destroyed:false,write:(value: string) => written.push(JSON.parse(value)) };
  const log = createJsonLogger(asSink(stream),100);
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
 assert.doesNotThrow(()=>createJsonLogger(asSink(broken))({event:'request'}));
 const shared=new Writable({write(_chunk,_encoding,done){done();}});
 createJsonLogger(shared);createJsonLogger(shared);assert.equal(shared.listenerCount('error'),1);shared.destroy();
});
