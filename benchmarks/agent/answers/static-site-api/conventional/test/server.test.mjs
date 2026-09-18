import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handle } from '../server.mjs';

test('pages, assets and the version endpoint', async () => {
  const server = createServer((req, res) => handle(req, res));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/`)).headers.get('content-type'), 'text/html; charset=utf-8');
    const css = await fetch(`${base}/assets/site.css`);
    assert.equal(css.headers.get('cache-control'), 'public, max-age=3600'); assert.equal(await css.text(), 'body{font-family:system-ui}\n');
    assert.equal((await fetch(`${base}/assets/nope.css`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/api/version`)).json(), { name: 'acme-site', version: '1.0.0' });
    assert.equal((await fetch(`${base}/index.html`)).status, 404);
  } finally { server.close(); }
});
