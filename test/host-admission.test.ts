import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { startServer } from '../packages/core/src/server.ts';
import type { ServerOptions } from '../packages/core/src/server.ts';
import { isLoopbackAddress, loopbackHostCheck } from '../packages/core/src/client-address.ts';
import { project } from './helpers.ts';

// fetch and http.request both own the Host header, so these requests are written by hand.
function raw(port: number, head: string, connectHost = '127.0.0.1'): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: connectHost, port }, () => socket.end(head + '\r\n'));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.setTimeout(10000, () => socket.destroy(new Error('HTTP test timeout')));
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString();
      resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0), text });
    });
  });
}
const get = (port: number, hosts: string[], path = '/hello', version = '1.1', connectHost?: string) =>
  raw(port, [`GET ${path} HTTP/${version}`, ...hosts.map(host => `Host: ${host}`), 'Connection: close', ''].join('\r\n'), connectHost);

async function serve(t: test.TestContext, options: ServerOptions = {}) {
  const root = await project(t, { '/hello': { respond: { text: 'hi' } } });
  const events: Record<string, unknown>[] = [];
  const app = await startServer({ project: root, port: 0, log: event => { events.push(event); }, ...options });
  t.after(() => app.close());
  return { app, port: app.address.port, events };
}

test('a loopback bind admits only loopback Host names on the bound port', async t => {
  const { port, events } = await serve(t);
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) {
    const response = await get(port, [host]);
    assert.equal(response.status, 200, host);
    assert.match(response.text, /\r\n\r\nhi$/);
  }
  for (const host of ['evil.example', `evil.example:${port}`, `localhost:${port + 1}`, 'localhost', '127.0.0.1', `localhost.:${port}`, `127.0.0.2:${port}`]) {
    const response = await get(port, [host]);
    assert.equal(response.status, 421, host);
    // A short fixed body; the refused Host is never reflected.
    assert.match(response.text, /\r\n\r\nMisdirected request\n$/);
    assert.ok(!response.text.includes('evil'), host);
  }
  // Probes are behind the same check: a rebinding page must not read them either.
  assert.equal((await get(port, ['evil.example'], '/_urlcode/health')).status, 421);
  assert.equal((await get(port, [`127.0.0.1:${port}`], '/_urlcode/health')).status, 200);
  // Logged like any other pre-routing refusal: a request record with its status and no Host text.
  const refused = events.filter(event => event.event === 'request' && event.status === 421);
  assert.ok(refused.length >= 8);
  assert.ok(!JSON.stringify(events).includes('evil.example'));
});

test('a missing or duplicated Host is refused on a loopback bind', async t => {
  const { port } = await serve(t);
  // HTTP/1.0 may omit Host, so Node's own HTTP/1.1 Host requirement does not reach it.
  assert.equal((await get(port, [], '/hello', '1.0')).status, 421);
  assert.equal((await get(port, [`localhost:${port}`, `localhost:${port}`])).status, 421);
  assert.equal((await get(port, [`localhost:${port}`, 'evil.example'])).status, 421);
  assert.equal((await get(port, [`localhost:${port}`], '/hello', '1.0')).status, 200);
});

test('an absolute-form target must name an admitted authority as well', async t => {
  const { port } = await serve(t);
  assert.equal((await get(port, [`localhost:${port}`], `http://localhost:${port}/hello`)).status, 200);
  assert.equal((await get(port, [`localhost:${port}`], 'http://evil.example/hello')).status, 421);
});

test('the configured origin authority is admitted, with default-port semantics', async t => {
  const { port } = await serve(t, { origin: 'https://site.example' });
  for (const host of ['site.example', 'SITE.example:443', `localhost:${port}`]) assert.equal((await get(port, [host])).status, 200, host);
  for (const host of ['site.example:80', 'site.example:8443', 'other.example']) assert.equal((await get(port, [host])).status, 421, host);
  const { port: other } = await serve(t, { origin: 'http://proxy.example:8080' });
  assert.equal((await get(other, ['proxy.example:8080'])).status, 200);
  assert.equal((await get(other, ['proxy.example'])).status, 421);
});

test('a non-loopback bind is not checked', async t => {
  const { port } = await serve(t, { host: '0.0.0.0' });
  assert.equal((await get(port, ['evil.example'])).status, 200);
  assert.equal((await get(port, [], '/hello', '1.0')).status, 200);
});

test('loopback detection covers 127.0.0.0/8, ::1 and IPv4-mapped loopback only', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(address), true, address);
  for (const address of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isLoopbackAddress(address), false, address);
    assert.equal(loopbackHostCheck({ address, port: 3000 }), undefined, address);
  }
  const check = loopbackHostCheck({ address: '127.0.0.2', port: 80 });
  assert.ok(check);
  // Port 80 is HTTP's default, so a bare name is the same authority; the bound literal is admitted too.
  for (const host of ['localhost', 'localhost:80', '127.0.0.2', '[::1]']) assert.equal(check(['Host', host], '/'), true, host);
  assert.equal(check(['Host', 'localhost:8080'], '/'), false);
});
