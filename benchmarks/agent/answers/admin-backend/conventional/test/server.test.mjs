import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
process.env.ADMIN_USER = 'admin'; process.env.ADMIN_PASSWORD = 'pw';
const { handle } = await import('../server.mjs');

test('basic auth gate and admin endpoints', async () => {
  const server = createServer((req, res) => handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`, auth = { authorization: 'Basic ' + Buffer.from('admin:pw').toString('base64') };
  try {
    assert.equal((await fetch(`${base}/admin/`)).status, 401);
    assert.equal((await fetch(`${base}/admin/`, { headers: auth })).headers.get('content-type'), 'text/html; charset=utf-8');
    assert.deepEqual(await (await fetch(`${base}/admin/api/stats`, { headers: auth })).json(), { users: 3, active: 2 });
    assert.deepEqual(await (await fetch(`${base}/admin/api/users/2/disable`, { method: 'POST', headers: auth })).json(), { id: 2, name: 'grace', active: false });
    assert.equal((await fetch(`${base}/admin/api/users/9/disable`, { method: 'POST', headers: auth })).status, 404);
  } finally { server.close(); }
});
