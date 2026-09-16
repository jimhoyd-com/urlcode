import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonLogger } from '../src/logging.js';
test('slow log collectors do not accumulate unlimited request records', () => {
  const written = [];
  const stream = { writableLength:100,destroyed:false,write:value => written.push(JSON.parse(value)) };
  const log = createJsonLogger(stream,100);
  for (let i=0;i<10000;i++) log({event:'request',status:200});
  assert.equal(written.length,0);
  stream.writableLength = 0; log({event:'request',status:200});
  assert.deepEqual(written,[{event:'logs_dropped',count:10000},{event:'request',status:200}]);
});
