import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
process.env.WEBHOOK_TOKEN = 'test-token';
const { handle } = await import('../server.mjs');

test('acknowledges valid events and rejects the rest', async () => {
  const server = createServer((req, res) => handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  try {
    const ok = await post('/hooks/github', '{"event":"push"}', { 'x-webhook-token': 'test-token' });
    assert.equal(ok.status, 202); assert.deepEqual(await ok.json(), { received: true, source: 'github', event: 'push' });
    assert.equal((await post('/hooks/github', '{"event":"push"}')).status, 401);
    assert.equal((await post('/hooks/other', '{}', { 'x-webhook-token': 'test-token' })).status, 404);
    assert.equal((await post('/hooks/github', '{}', { 'x-webhook-token': 'test-token' })).status, 422);
    assert.equal((await fetch(`${base}/hooks/github`)).status, 405);
  } finally { server.close(); }
});
