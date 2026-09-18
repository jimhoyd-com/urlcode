import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../server.mjs';

test('downloads, public files, ranges and etags', async () => {
  const server = createServer((req, res) => handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await fetch(`${base}/downloads/report`);
    assert.equal(report.headers.get('content-disposition'), 'attachment; filename=quarterly-report.csv');
    assert.equal(await report.text(), 'id,name\n1,ada\n2,grace\n');
    assert.equal((await fetch(`${base}/downloads/report`, { headers: { 'if-none-match': report.headers.get('etag') } })).status, 304);
    const range = await fetch(`${base}/downloads/report`, { headers: { range: 'bytes=0-1' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), 'id');
    assert.equal((await fetch(`${base}/public/notes.txt`)).headers.get('cache-control'), 'public, max-age=3600');
    assert.equal((await fetch(`${base}/public/nope.txt`)).status, 404);
  } finally { server.close(); }
});
