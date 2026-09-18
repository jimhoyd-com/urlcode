import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../server.mjs';

test('page, submissions, honeypot and validation', async () => {
  const server = createServer((req, res) => handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/contact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/contact`)).headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal((await post({ name: 'Ada', email: 'ada@example.com', message: 'Hi' })).status, 201);
    assert.equal((await post({ name: 'Bot', email: 'b@x', message: 'Buy', website: 'x' })).status, 200);
    assert.deepEqual(await (await post({ name: 'Ada', email: 'nope', message: '' })).json(), { errors: ['email must be an address', 'message must be 1-2000 characters'] });
    assert.equal((await fetch(`${base}/contact`, { method: 'DELETE' })).status, 405);
  } finally { server.close(); }
});
