import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonLogger } from '../src/logging.ts';
test('slow log collectors do not accumulate unlimited request records', () => {
  const written = [];
  const stream = { writableLength:100,destroyed:false,write:value => written.push(JSON.parse(value)) };
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
 const broken={write(){throw new Error('failed');},writableLength:0};
 assert.doesNotThrow(()=>createJsonLogger(broken)({event:'request'}));
 const shared=new Writable({write(_chunk,_encoding,done){done();}});
 createJsonLogger(shared);createJsonLogger(shared);assert.equal(shared.listenerCount('error'),1);shared.destroy();
});
