import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../server.mjs';

test('resolves, rejects and validates', async () => {
  const server = createServer((req, res) => handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/r/docs`, { redirect: 'manual' })).headers.get('location'), 'https://docs.example.com/');
    assert.equal((await fetch(`${base}/r/Bad`)).status, 400);
    const created = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'team', url: 'https://example.com/team' }) });
    assert.equal(created.status, 201);
    const dup = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'docs', url: 'ftp://x' }) });
    assert.deepEqual(await dup.json(), { errors: ['code already exists', 'url must be an https URL'] });
  } finally { server.close(); }
});
