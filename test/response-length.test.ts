import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { startServer } from '../packages/core/src/server.ts';
import { prepareResponse, writeResponse, byteLength } from '../packages/core/src/http-response.ts';
import type { HandlerResult, ResponseWriter } from '../packages/core/src/http-response.ts';
import { project, request } from './helpers.ts';
import type { TestContext } from 'node:test';

const JS_EMBED_CHAR_MAP: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function escapeUnsafeChars(value: string): string {
  return value.replace(/[<>/\\\b\f\n\r\t\0\u2028\u2029]/g, char => JS_EMBED_CHAR_MAP[char] ?? char);
}

// A body that is itself a complete HTTP response. If a stated length ever
// framed less than the body, a client would read it as the next response.
const inner = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\ninner';
const text = 'héllo ☃ 😀';

interface Parsed { status: number; headers: Record<string, string>; body: string }
// Reads pipelined responses off one socket, framing each by its content-length.
function pipeline(port: number, raw: string, expected: number): Promise<Parsed[]> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buffer = Buffer.alloc(0); const parsed: Parsed[] = [];
    const finish = (): void => { clearTimeout(timer); socket.destroy(); resolve(parsed); };
    const timer = setTimeout(finish, 3000);
    socket.on('error', reject);
    socket.on('close', finish);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const [line = '', ...lines] = buffer.subarray(0, end).toString('latin1').split('\r\n');
        const headers: Record<string, string> = {};
        for (const header of lines) { const at = header.indexOf(':'); headers[header.slice(0, at).trim().toLowerCase()] = header.slice(at + 1).trim(); }
        const length = Number(headers['content-length'] ?? 0);
        if (buffer.length < end + 4 + length) return;
        parsed.push({ status: Number(line.split(' ')[1]), headers, body: buffer.subarray(end + 4, end + 4 + length).toString('utf8') });
        buffer = buffer.subarray(end + 4 + length);
        if (parsed.length === expected) { finish(); return; }
      }
    });
    socket.write(raw);
  });
}
const get = (path: string): string => `GET ${path} HTTP/1.1\r\nhost: localhost\r\n\r\n`;

async function sandboxed(t: TestContext, files: Record<string, string>): Promise<number> {
  const routes = Object.fromEntries(Object.keys(files).map(file => [`/${file.replace('.mjs', '')}`, { sandbox: true, function: { source: file } }]));
  // Headroom above the number of routes: a worker that just answered a
  // refused (502) response may still be respawning when the next pipelined
  // request arrives on a slow runner, and a tight pool reads that as
  // capacity exhaustion rather than the isolation fault under test.
  const server = await startServer({ project: await project(t, routes, files), port: 0, workers: 4, log: () => {} });
  t.after(() => server.close());
  return server.address.port;
}

test('content-length is the body byte length for GET, whatever length the result states', () => {
  const options = { requestId: 'r', method: 'GET' };
  const length = (result: HandlerResult): string | undefined => prepareResponse(result, options).headers.find(([key]) => key === 'content-length')?.[1];
  assert.equal(length({ status: 200, headers: [], body: inner, contentLength: 0 }), String(Buffer.byteLength(inner)));
  assert.equal(length({ status: 200, headers: [], body: Buffer.from('abc'), contentLength: 99 }), '3');
  assert.equal(length({ status: 200, headers: [], body: text }), String(Buffer.byteLength(text)));
  assert.equal(length({ status: 200, headers: [], body: undefined, contentLength: 7 }), '0');
  for (const sample of ['', 'a', 'é', '☃', '😀', '\ud800', '\udc00x', 'a\ud83dz']) assert.equal(byteLength(sample), Buffer.byteLength(sample), JSON.stringify(sample));
});

test('HEAD states the length GET would send and carries no body', () => {
  const head = prepareResponse({ status: 200, headers: [], body: undefined, contentLength: 12 }, { requestId: 'r', method: 'HEAD' });
  assert.equal(head.body, undefined);
  assert.ok(head.headers.some(([key, value]) => key === 'content-length' && value === '12'));
  const measured = prepareResponse({ status: 200, headers: [], body: text }, { requestId: 'r', method: 'HEAD' });
  assert.ok(measured.headers.some(([key, value]) => key === 'content-length' && value === String(Buffer.byteLength(text))));
  assert.throws(() => prepareResponse({ status: 200, headers: [], body: undefined, contentLength: -1 }, { requestId: 'r', method: 'HEAD' }), /Invalid function response/);
});

test('the Node writer enforces the stated length', () => {
  const writer: ResponseWriter = { statusCode: 0, headersSent: false, setHeader() {}, getHeaderNames: () => [], removeHeader() {}, end() {}, destroy() {} };
  writeResponse(writer, { status: 200, headers: [], body: 'ok' }, { requestId: 'r', method: 'GET' });
  assert.equal(writer.strictContentLength, true);
});

test('a pipelined keep-alive request receives its own response after a result stating a short length', async t => {
  const server = http.createServer((req, res) => {
    const result: HandlerResult = req.url === '/first' ? { status: 200, headers: [['content-type', 'text/plain']], body: inner, contentLength: 0 } : { status: 200, headers: [], body: 'second' };
    writeResponse(res, result, { requestId: 'r', method: req.method ?? 'GET' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const responses = await pipeline((server.address() as AddressInfo).port, get('/first') + get('/second'), 2);
  assert.equal(responses.length, 2);
  assert.equal(responses[0]?.body, inner);
  assert.equal(responses[1]?.body, 'second');
});

test('a sandboxed function cannot rewrite its recorded result', async t => {
  const port = await sandboxed(t, {
    'rewrite.mjs': `export default () => {
      globalThis.__output = JSON.stringify({status:200,headers:[],body:${JSON.stringify(inner)},contentLength:0});
      globalThis.__state = 'done';
      return new Promise(() => {});
    }`,
    'redefine.mjs': `export default () => {
      Object.defineProperty(globalThis,'__output',{value:'{}'});
      return new Response('unreachable');
    }`,
  });
  for (const path of ['/rewrite', '/redefine']) assert.equal((await request({ address: { port } }, path)).status, 502, path);
});

test('a sandboxed module cannot replace the invocation entry point', async t => {
  const root = await project(t, { '/': { sandbox: true, function: { source: 'f.mjs' } } },
    { 'f.mjs': `globalThis.__invoke = () => {}; export default () => new Response('ok');` });
  await assert.rejects(startServer({ project: root, port: 0, log: () => {} }), /Function initialization failed/);
});

test('a sandboxed GET response stating a length is refused; HEAD keeps the GET length', async t => {
  const port = await sandboxed(t, {
    // Adds contentLength to the serialized result through an inherited toJSON.
    'stated.mjs': `export default () => {
      Object.prototype.toJSON = function () {
        if (this && typeof this.status === 'number' && 'body' in this) { const copy = {}; for (const key of Object.keys(this)) copy[key] = this[key]; copy.contentLength = 0; return copy; }
        return this;
      };
      return new Response(${JSON.stringify(inner)});
    }`,
    'text.mjs': `export default () => new Response(${escapeUnsafeChars(JSON.stringify(text))});`,
  });
  const stated = await pipeline(port, get('/stated') + get('/text'), 2);
  assert.equal(stated[0]?.status, 502);
  assert.ok(!stated.some(response => response.body === 'inner'));

  const [plain, follow] = await pipeline(port, get('/text') + get('/text'), 2);
  assert.equal(plain?.body, text); assert.equal(follow?.body, text);
  assert.equal(plain?.headers['content-length'], String(Buffer.byteLength(text)));
  const head = await request({ address: { port } }, '/text', { method: 'HEAD' });
  assert.equal(head.bytes.length, 0);
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(text)));
});
