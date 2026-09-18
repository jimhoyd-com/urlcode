import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../server.mjs';

test('lists, filters and fetches products', async () => {
  const server = createServer(handle);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await (await fetch(`${base}/api/products`)).json()).length, 3);
    assert.equal((await (await fetch(`${base}/api/products?category=lighting`)).json()).length, 1);
    assert.equal((await fetch(`${base}/api/products?category=toys`)).status, 400);
    assert.equal((await (await fetch(`${base}/api/products/2`)).json()).name, 'Fountain pen');
    assert.equal((await fetch(`${base}/api/products/9`)).status, 404);
    assert.equal((await fetch(`${base}/api/products`, { method: 'POST' })).status, 405);
  } finally { server.close(); }
});
