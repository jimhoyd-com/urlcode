import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { TestContext } from 'node:test';
import { startServer } from '../packages/core/src/server.ts';
import type { Server, ServerOptions } from '../packages/core/src/server.ts';
import { parseCidr, resolveClient, compileTrustedProxies } from '../packages/core/src/client-address.ts';
import { project, redirect, request } from './helpers.ts';

async function serve(t: TestContext, root: string, options: Partial<ServerOptions> = {}): Promise<Server> {
  const app = await startServer({ project: root, port: 0, log: () => {}, ...options }); t.after(() => app.close()); return app;
}
function raw(app: Server, text: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(app.address.port, '127.0.0.1', () => socket.end(text));
    const chunks: Buffer[] = []; socket.on('data', (c: Buffer) => chunks.push(c)); socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(chunks).toString()));
  });
}

test('HEAD states the length GET would send on declared and function responses (RFC 9110 §8.6)', async t => {
  const root = await project(t, { '/r': { respond: { text: 'hello world' } } });
  const app = await serve(t, root);
  const get = await request(app, '/r'), head = await request(app, '/r', { method: 'HEAD' });
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(head.body, '');
});

test('request targets: 414 for over-long, absolute-form accepted, asterisk-form refused (RFC 9112 §3)', async t => {
  const root = await project(t, { '/go': redirect() });
  const app = await serve(t, root);
  assert.equal((await request(app, '/' + 'a'.repeat(9000))).status, 414);
  const absolute = await raw(app, 'GET http://example.test/go?x=1 HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
  assert.match(absolute, /^HTTP\/1\.1 302/);
  const bare = await raw(app, 'GET http://example.test HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
  assert.match(bare, /^HTTP\/1\.1 404/);
  const star = await raw(app, 'OPTIONS * HTTP/1.1\r\nHost: example.test\r\nConnection: close\r\n\r\n');
  assert.match(star, /^HTTP\/1\.1 400/);
});

test('oversized header fields answer 431, not 400 (RFC 6585 §5)', async t => {
  const root = await project(t, { '/go': redirect() });
  const app = await serve(t, root);
  const reply = await raw(app, `GET /go HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`);
  assert.match(reply, /^HTTP\/1\.1 431/);
});

test('forwarded entries with ports and embedded IPv4 in IPv6 ranges resolve correctly', () => {
  const trusted = compileTrustedProxies('10.0.0.0/8, 64:ff9b::/96');
  assert.equal(resolveClient('10.0.0.1', '203.0.113.5:1234, 10.0.0.2', trusted), '203.0.113.5');
  assert.equal(resolveClient('10.0.0.1', 'garbage, 10.0.0.2', trusted), '10.0.0.2');
  assert.deepEqual([...parseCidr('64:ff9b::1.2.3.4/96').bytes.slice(12)], [1, 2, 3, 4]);
  assert.equal(resolveClient('64:ff9b::1.2.3.4', '198.51.100.7', trusted), '198.51.100.7');
});
