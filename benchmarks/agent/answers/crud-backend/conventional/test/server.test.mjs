import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHandler } from '../server.mjs';

test('create, read, replace, delete', async () => {
  const handle = createHandler(), server = createServer((req, res) => handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`, json = { 'content-type': 'application/json' };
  try {
    assert.equal((await (await fetch(`${base}/notes`)).json()).length, 2);
    const created = await fetch(`${base}/notes`, { method: 'POST', headers: json, body: JSON.stringify({ title: 'T', body: 'b' }) });
    assert.equal(created.status, 201); assert.equal((await created.json()).id, 3);
    assert.equal((await fetch(`${base}/notes`, { method: 'POST', headers: json, body: '{"title":"","x":1}' })).status, 422);
    assert.equal((await fetch(`${base}/notes/1`, { method: 'PUT', headers: json, body: JSON.stringify({ title: 'S', body: '' }) })).status, 200);
    assert.equal((await fetch(`${base}/notes/1`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/notes/1`)).status, 404);
    assert.equal((await fetch(`${base}/notes/2`, { method: 'PATCH' })).status, 405);
  } finally { server.close(); }
});
