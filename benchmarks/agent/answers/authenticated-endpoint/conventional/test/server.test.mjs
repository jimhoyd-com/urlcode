import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
process.env.API_TOKEN = 'test-token';
const { handle } = await import('../server.mjs');

test('public is open, me needs the token', async () => {
  const server = createServer(handle);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/public`)).status, 200);
    const denied = await fetch(`${base}/api/me`);
    assert.equal(denied.status, 401); assert.equal(denied.headers.get('www-authenticate'), 'Bearer realm="demo"');
    const ok = await fetch(`${base}/api/me`, { headers: { authorization: 'Bearer test-token' } });
    assert.deepEqual(await ok.json(), { user: 'service-account', scopes: ['read'] });
    assert.equal((await fetch(`${base}/api/me`, { method: 'POST' })).status, 405);
  } finally { server.close(); }
});
