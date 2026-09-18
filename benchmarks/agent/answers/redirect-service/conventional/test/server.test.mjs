import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../server.mjs';

async function withServer(fn) {
  const server = createServer(handle);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('redirects and health', async () => {
  await withServer(async base => {
    const go = await fetch(`${base}/go`, { redirect: 'manual' });
    assert.equal(go.status, 302); assert.equal(go.headers.get('location'), 'https://example.com/');
    const docs = await fetch(`${base}/docs`, { redirect: 'manual' });
    assert.equal(docs.status, 301);
    const product = await fetch(`${base}/product/abc-1?ref=x`, { redirect: 'manual' });
    assert.equal(product.headers.get('location'), 'https://example.com/products/abc-1?ref=x');
    assert.equal((await fetch(`${base}/product/bad%20id`, { redirect: 'manual' })).status, 400);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    assert.equal((await fetch(`${base}/go`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/missing`)).status, 404);
  });
});
