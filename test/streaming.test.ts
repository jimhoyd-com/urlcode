import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../packages/core/src/server.ts';
import type { Server, ServerOptions } from '../packages/core/src/server.ts';
import { createRuntime } from '../packages/core/src/runtime.ts';
import { createVercelHandler } from '../packages/core/src/vercel.ts';
import { createLambdaHandler } from '../packages/core/src/aws.ts';
import { buildCloudflare } from '../packages/core/src/build-cloudflare.ts';
import { buildStatic } from '../packages/core/src/build-static.ts';
import { getCapabilities, analyzeProjectCapabilities } from '../packages/core/src/capabilities.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { inspectExtensionRevision } from '../packages/core/src/extensions.ts';
import type { ExtensionRequest, HandlerResult, RuntimeExtension } from '../packages/core/src/extensions.ts';
import { resolveStreamLimits, defaultStreamLimits } from '../packages/core/src/http-stream.ts';
import { project, request } from './helpers.ts';
import type { Addressed } from './helpers.ts';
import type { TestContext } from 'node:test';

// Streamed responses (RIM-STREAM-001) over real node:http sockets. Trusted functions run in this process, so a
// test coordinates with its producer through one shared global keyed per test.
interface Probe { gate: PromiseWithResolvers<void>; started: boolean; returned: boolean; pulls: number; aborted?: unknown; signalSeen: boolean }
const probes = new Map<string, Probe>();
(globalThis as { __urlcodeStreamProbes?: Map<string, Probe> }).__urlcodeStreamProbes = probes;
function probe(key: string): Probe {
  const created: Probe = { gate: Promise.withResolvers<void>(), started: false, returned: false, pulls: 0, signalSeen: false };
  probes.set(key, created);
  return created;
}
// One module serves every function test; the route's args pick the probe and the producer's shape.
const producer = `
const probes = globalThis.__urlcodeStreamProbes;
const waitAbort = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
export default (request, context) => {
  const p = probes.get(context.args.key);
  p.signalSeen = context.signal instanceof AbortSignal;
  const mode = context.args.mode;
  async function* body() {
    p.started = true;
    try {
      if (mode === 'gate') { yield 'first\\n'; await p.gate.promise; yield 'second\\n'; return; }
      if (mode === 'hold') { yield 'open\\n'; await waitAbort(context.signal); return; }
      if (mode === 'finite') { yield 'a'; await new Promise(r => setTimeout(r, 200)); yield 'b'; return; }
      if (mode === 'big') { const chunk = new Uint8Array(65536).fill(120); for (;;) { p.pulls++; yield chunk; } }
      if (mode === 'throw-late') { yield 'partial\\n'; throw new Error('secret-producer-detail'); }
      if (mode === 'throw-early') { throw new Error('secret-producer-detail'); }
      if (mode === 'ticks') { for (;;) { yield '.'; await new Promise(r => setTimeout(r, 300)); if (context.signal.aborted) return; } }
      if (mode === 'bytes') { yield 'aaaaaa'; yield 'bbbbbb'; await waitAbort(context.signal); return; }
      if (mode === 'gap') { yield 'a'; await new Promise(r => setTimeout(r, 1500)); yield 'b'; return; }
      if (mode === 'empty') return;
    } finally { p.returned = true; p.aborted = context.signal.reason; }
  }
  if (mode === 'lazy') {
    return new Response(new ReadableStream({ pull(c) { p.started = true; c.enqueue(new TextEncoder().encode('x')); c.close(); } }, { highWaterMark: 0 }),
      { headers: { 'content-type': 'text/plain; charset=utf-8', 'x-produced': 'yes' } });
  }
  return new Response(ReadableStream.from(body()), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
`;
function route(key: string, mode: string, extra: object = {}): object {
  return { stream: true, methods: ['GET', 'HEAD'], function: { source: 'stream.mjs', args: { key, mode } }, ...extra };
}
async function serve(t: TestContext, routes: Record<string, object>, options: Partial<ServerOptions> = {}, events: Record<string, unknown>[] = []): Promise<Server> {
  const root = await project(t, routes, { 'stream.mjs': producer });
  const app = await startServer({ project: root, port: 0, log: event => events.push(event), requestLog: 'detailed', ...options });
  t.after(() => app.close());
  return app;
}
interface Reader { status: number; headers: http.IncomingHttpHeaders; response: http.IncomingMessage; request: http.ClientRequest; chunks: string[]; ended: Promise<{ complete: boolean; body: string }> }
/** Opens a request and resolves at the response head; chunks are collected as they arrive. */
function open(app: Addressed, path: string, method = 'GET'): Promise<Reader> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: app.address.port, path, method, agent: false }, res => {
      const chunks: string[] = [];
      const ended = new Promise<{ complete: boolean; body: string }>(done => {
        res.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
        const finish = (): void => done({ complete: res.complete, body: chunks.join('') });
        res.on('end', finish); res.on('close', finish); res.on('error', finish);
      });
      resolve({ status: res.statusCode ?? 0, headers: res.headers, response: res, request: req, chunks, ended });
    });
    req.on('error', reject);
    req.end();
  });
}
/** The raw bytes of one response read to the connection's end, for checking chunked framing (a node:http client drops
 * the body buffered before an early close). */
function raw(app: Addressed, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(app.address.port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${app.address.port}\r\n\r\n`));
    let text = '';
    socket.on('data', chunk => { text += chunk.toString(); });
    socket.on('close', () => resolve(text)); socket.on('error', reject);
  });
}
const requestIdOf = (text: string): string | undefined => /\r\nx-request-id: ([^\r]+)\r\n/.exec(text)?.[1];
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`); await delay(10); }
}
const streamEvent = (events: Record<string, unknown>[], requestId: unknown) => events.find(event => event.event === 'stream' && event.requestId === requestId);

test('a declared trusted function streams chunks before the producer finishes', async t => {
  const events: Record<string, unknown>[] = [];
  const p = probe('incremental');
  const app = await serve(t, { '/live': route('incremental', 'gate') }, {}, events);
  const reader = await open(app, '/live');
  assert.equal(reader.status, 200);
  assert.equal(reader.headers['transfer-encoding'], 'chunked');
  assert.equal(reader.headers['content-length'], undefined);
  // The usual decoration is on the head, before any chunk.
  assert.equal(reader.headers['x-content-type-options'], 'nosniff');
  assert.equal(reader.headers['cache-control'], 'no-store');
  assert.match(String(reader.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  await until(() => reader.chunks.join('') === 'first\n', 'the first chunk');
  assert.equal(p.returned, false, 'the producer is still running when the first chunk arrives');
  assert.equal(p.signalSeen, true, 'a trusted function context carries an AbortSignal');
  p.gate.resolve();
  const ended = await reader.ended;
  assert.deepEqual(ended, { complete: true, body: 'first\nsecond\n' });
  await until(() => streamEvent(events, reader.headers['x-request-id']) !== undefined, 'the stream record');
  const record = streamEvent(events, reader.headers['x-request-id'])!;
  assert.equal(record.reason, 'complete');
  assert.equal(record.bytes, 13);
  assert.equal(record.status, 200);
  assert.equal(record.route, '/live');
  assert.equal(record.method, 'GET');
  assert.equal(typeof record.durationMs, 'number');
  // The request record is still written once, when the head is committed.
  assert.equal(events.filter(event => event.event === 'request' && event.requestId === reader.headers['x-request-id']).length, 1);
});

test('a stream waits for the client to drain before pulling the producer again', async t => {
  const p = probe('backpressure');
  const app = await serve(t, { '/big': route('backpressure', 'big') }, { streamMaxBytes: 268435456, streamIdleTimeoutMs: 10000 });
  const socket = net.connect(app.address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.pause();
  socket.write(`GET /big HTTP/1.1\r\nHost: localhost:${app.address.port}\r\n\r\n`);
  await until(() => p.pulls > 0, 'the first pull');
  // Let the socket buffers fill, then the pull count must stop moving.
  await delay(500);
  const stalled = p.pulls;
  await delay(400);
  assert.equal(p.pulls, stalled, 'the producer kept being pulled while the client read nothing');
  assert.ok(stalled < 1024, `pulled ${stalled} chunks of 64 KiB without the client reading`);
  // Reading again resumes the producer.
  socket.on('data', () => {});
  socket.resume();
  await until(() => p.pulls > stalled + 10, 'the producer to resume');
});

test('a client disconnect cancels the producer and aborts its signal', async t => {
  const events: Record<string, unknown>[] = [];
  const p = probe('disconnect');
  const app = await serve(t, { '/hold': route('disconnect', 'hold') }, {}, events);
  const reader = await open(app, '/hold');
  await until(() => reader.chunks.length > 0, 'the first chunk');
  reader.request.destroy();
  await until(() => p.returned, 'the producer to be cancelled');
  assert.equal(p.aborted, 'client-closed');
  await until(() => streamEvent(events, reader.headers['x-request-id']) !== undefined, 'the stream record');
  assert.equal(streamEvent(events, reader.headers['x-request-id'])!.reason, 'client-closed');
});

test('a producer error after the head ends the response truncated and never reaches the client', async t => {
  const events: Record<string, unknown>[] = [];
  probe('late');
  const app = await serve(t, { '/late': route('late', 'throw-late') }, {}, events);
  const text = await raw(app, '/late');
  assert.match(text, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(text, /\r\ntransfer-encoding: chunked\r\n/i);
  assert.ok(text.endsWith('\r\n\r\n8\r\npartial\n\r\n'), 'the body must stop after the chunk it sent, with no terminating chunk');
  assert.ok(!text.includes('secret'));
  const id = requestIdOf(text);
  await until(() => streamEvent(events, id) !== undefined, 'the stream record');
  assert.equal(streamEvent(events, id)!.reason, 'error');
  assert.ok(!JSON.stringify(events).includes('secret-producer-detail'), 'the event log never carries what the producer threw');
});

test('a producer error before the first chunk is answered by the ordinary error path', async t => {
  const events: Record<string, unknown>[] = [];
  probe('early');
  const app = await serve(t, { '/early': route('early', 'throw-early') }, {}, events);
  const answer = await request(app, '/early');
  assert.equal(answer.status, 502);
  assert.equal(answer.body, 'Function execution failed\n');
  assert.ok(answer.headers['content-length']);
  assert.ok(!answer.body.includes('secret'));
  assert.equal(events.find(event => event.event === 'request')?.status, 502);
  assert.equal(events.some(event => event.event === 'stream'), false);
});

test('an empty stream completes with the head and an empty body', async t => {
  probe('empty');
  const app = await serve(t, { '/empty': route('empty', 'empty') });
  const answer = await request(app, '/empty');
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '');
});

test('each stream limit ends the stream with its own reason and aborts the producer', async t => {
  const events: Record<string, unknown>[] = [];
  const idle = probe('idle'), duration = probe('duration'), bytes = probe('bytes');
  const app = await serve(t, {
    '/idle': route('idle', 'hold'), '/duration': route('duration', 'ticks'), '/bytes': route('bytes', 'bytes'),
  }, { streamIdleTimeoutMs: 1000, streamMaxDurationMs: 1500, streamMaxBytes: 10 }, events);
  const [a, b, c] = await Promise.all([raw(app, '/idle'), raw(app, '/duration'), raw(app, '/bytes')]);
  for (const text of [a, b, c]) assert.ok(!text.endsWith('0\r\n\r\n'), 'a stream ended by a limit must not look complete');
  assert.ok(a.endsWith('\r\n\r\n5\r\nopen\n\r\n'));
  assert.ok(c.endsWith('\r\n\r\n6\r\naaaaaa\r\n'), 'the chunk that would pass the byte limit is never sent');
  const ids = [a, b, c].map(requestIdOf);
  await until(() => ids.every(id => streamEvent(events, id)), 'three stream records');
  assert.equal(streamEvent(events, ids[0])!.reason, 'idle-timeout');
  assert.equal(streamEvent(events, ids[1])!.reason, 'max-duration');
  assert.equal(streamEvent(events, ids[2])!.reason, 'max-bytes');
  assert.equal(streamEvent(events, ids[2])!.bytes, 6);
  await until(() => idle.returned && duration.returned && bytes.returned, 'every producer to stop');
  assert.equal(idle.aborted, 'idle-timeout');
  assert.equal(bytes.aborted, 'max-bytes');
});

test('concurrent streams have their own limit, and a stream leaves the in-flight request budget', async t => {
  const events: Record<string, unknown>[] = [];
  probe('first'); const second = probe('second');
  const app = await serve(t, { '/first': route('first', 'hold'), '/second': route('second', 'hold'), '/plain': { respond: { text: 'ok' } } },
    { maxStreams: 1, maxInFlightRequests: 1 }, events);
  const first = await open(app, '/first');
  await until(() => first.chunks.length > 0, 'the first stream');
  // The open stream holds no in-flight admission, so an ordinary request is still served.
  assert.equal((await request(app, '/plain')).status, 200);
  const refused = await request(app, '/second');
  assert.equal(refused.status, 503);
  assert.equal(refused.body, 'Stream capacity unavailable\n');
  // Refused before its first pull: the producer never starts, or, if its body source already started, is stopped.
  await delay(100);
  assert.ok(!second.started || second.returned, 'the refused producer kept running');
  assert.equal(events.find(event => event.event === 'stream_refused')?.reason, 'capacity');
  first.request.destroy();
});

test('the request timeout does not end a healthy stream that is quiet for longer', async t => {
  probe('gap');
  const app = await serve(t, { '/gap': route('gap', 'gap') }, { requestTimeoutMs: 1000, headersTimeoutMs: 1000, streamIdleTimeoutMs: 3000 });
  const reader = await open(app, '/gap');
  assert.deepEqual(await reader.ended, { complete: true, body: 'ab' });
});

test('HEAD answers the head only and never pulls the body', async t => {
  const p = probe('head');
  const app = await serve(t, { '/lazy': route('head', 'lazy') });
  const answer = await request(app, '/lazy', { method: 'HEAD' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '');
  assert.equal(answer.headers['x-produced'], 'yes');
  assert.equal(answer.headers['content-length'], undefined);
  assert.equal(p.started, false, 'the body was pulled for HEAD');
  assert.equal((await request(app, '/lazy')).body, 'x');
});

test('shutdown lets a stream finish within the grace period and ends the rest at the deadline', async t => {
  const events: Record<string, unknown>[] = [];
  const finite = probe('finite'), held = probe('held');
  const root = await project(t, { '/finite': route('finite', 'finite'), '/held': route('held', 'hold') }, { 'stream.mjs': producer });
  const app = await startServer({ project: root, port: 0, log: event => events.push(event), closeTimeoutMs: 1000 });
  const a = await open(app, '/finite'), b = await open(app, '/held');
  await until(() => a.chunks.length > 0 && b.chunks.length > 0, 'both streams');
  const started = Date.now();
  await app.close();
  assert.ok(Date.now() - started < 5000, 'close waited far past its grace period');
  assert.deepEqual(await a.ended, { complete: true, body: 'ab' });
  assert.equal((await b.ended).complete, false);
  assert.ok(finite.returned);
  assert.equal(held.aborted, 'shutdown');
  assert.equal(streamEvent(events, b.headers['x-request-id'])?.reason, 'shutdown');
});

test('a reload lets an open stream finish on the retired runtime', async t => {
  const p = probe('reload');
  const app = await serve(t, { '/live': route('reload', 'gate') });
  const reader = await open(app, '/live');
  await until(() => reader.chunks.length > 0, 'the first chunk');
  assert.equal(await app.reload(), true);
  p.gate.resolve();
  assert.deepEqual(await reader.ended, { complete: true, body: 'first\nsecond\n' });
});

test('a route that declares no streaming keeps buffering a function body exactly as before', async t => {
  const root = await project(t, { '/buffered': { function: { source: 'f.mjs' } } },
    { 'f.mjs': 'export default () => new Response(ReadableStream.from((async function* () { yield new TextEncoder().encode("a"); yield new TextEncoder().encode("b"); })()), { headers: { "content-type": "text/plain" } });' });
  const app = await startServer({ project: root, port: 0, log: () => {} });
  t.after(() => app.close());
  const answer = await request(app, '/buffered');
  assert.equal(answer.body, 'ab');
  assert.equal(answer.headers['content-length'], '2');
  assert.equal(answer.headers['transfer-encoding'], undefined);
});

test('a buffered response is byte-identical on the wire, head and body', async t => {
  const root = await project(t, { '/hello': { respond: { json: { ok: true } } } });
  const app = await startServer({ project: root, port: 0, log: () => {}, trustRequestId: true });
  t.after(() => app.close());
  const raw = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(app.address.port, '127.0.0.1', () => socket.end(`GET /hello HTTP/1.1\r\nHost: localhost:${app.address.port}\r\nX-Request-Id: fixed-id\r\nConnection: close\r\n\r\n`));
    let text = ''; socket.on('data', chunk => { text += chunk.toString(); }); socket.on('end', () => resolve(text)); socket.on('error', reject);
  });
  const withoutDate = raw.replace(/\r\nDate: [^\r]+/, '');
  assert.equal(withoutDate, 'HTTP/1.1 200 OK\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: 11\r\nx-request-id: fixed-id\r\nx-content-type-options: nosniff\r\ncache-control: no-store\r\nConnection: close\r\n\r\n{"ok":true}');
});

test('stream: true is refused with sandbox: true and without a function', async t => {
  const sandboxed = await project(t, { '/s': { stream: true, sandbox: true, function: { source: 'f.mjs' } } }, { 'f.mjs': 'export default () => new Response("x");' });
  await assert.rejects(createRuntime(sandboxed, { log: () => {} }), /stream: true cannot be combined with sandbox: true/);
  const bare = await project(t, { '/r': { stream: true, respond: { text: 'x' } } });
  await assert.rejects(createRuntime(bare, { log: () => {} }), /stream: true needs a function route/);
});

// --- Extensions -------------------------------------------------------------------------------------------------
const origin = 'https://streams.example.test';
const declarations = { live: { version: '1', config: {} } };
interface ExtensionProbe { started: boolean; returned: boolean; closed: boolean; signal?: AbortSignal | undefined; gate: PromiseWithResolvers<void> }
function extension(root: string, pin: string, state: ExtensionProbe, extra: Partial<RuntimeExtension> = {}): RuntimeExtension {
  void root;
  return {
    name: 'live', version: '1', projectSha256: pin, targets: ['node', 'aws', 'vercel'], streams: true,
    schema: { type: 'object' },
    activate() {
      return {
        handle(request: ExtensionRequest): HandlerResult {
          state.signal = request.signal;
          async function* events(): AsyncGenerator<string> {
            state.started = true;
            try { yield 'event: ready\ndata: 1\n\n'; await state.gate.promise; yield 'data: 2\n\n'; }
            finally { state.returned = true; }
          }
          return { status: 200, headers: [['content-type', 'text/event-stream']], stream: events() };
        },
        close() { state.closed = true; },
      };
    },
    ...extra,
  };
}
const extensionState = (): ExtensionProbe => ({ started: false, returned: false, closed: false, gate: Promise.withResolvers<void>() });
async function extensionProject(t: TestContext): Promise<{ root: string; pin: string }> {
  const root = await project(t, { '/live/*': { extension: 'live', methods: ['GET', 'HEAD'] } }, {}, { extensions: declarations });
  return { root, pin: await inspectExtensionRevision(root) };
}

test('an extension registered with streams: true streams through the extension path', async t => {
  const { root, pin } = await extensionProject(t);
  const state = extensionState();
  const app = await startServer({ project: root, port: 0, origin, log: () => {}, extensions: [extension(root, pin, state)] });
  const reader = await open(app, '/live/events');
  assert.equal(reader.headers['content-type'], 'text/event-stream');
  assert.equal(reader.headers['cache-control'], 'no-store');
  await until(() => reader.chunks.join('').includes('ready'), 'the first event');
  assert.ok(state.signal instanceof AbortSignal);
  // Close waits for the open stream before closing the extension.
  const closing = app.close();
  await delay(50);
  assert.equal(state.closed, false, 'the extension closed under an open stream');
  state.gate.resolve();
  assert.deepEqual(await reader.ended, { complete: true, body: 'event: ready\ndata: 1\n\ndata: 2\n\n' });
  await closing;
  assert.equal(state.closed, true);
});

test('HEAD on a streaming extension never starts its producer', async t => {
  const { root, pin } = await extensionProject(t);
  const state = extensionState();
  const app = await startServer({ project: root, port: 0, origin, log: () => {}, extensions: [extension(root, pin, state)] });
  t.after(() => app.close());
  const answer = await request(app, '/live/events', { method: 'HEAD' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body, '');
  assert.equal(state.started, false);
});

test('a stream from an extension that did not declare streams is the generic 502, logged', async t => {
  const { root, pin } = await extensionProject(t);
  const state = extensionState();
  const events: Record<string, unknown>[] = [];
  const app = await startServer({ project: root, port: 0, origin, log: event => events.push(event), extensions: [extension(root, pin, state, { streams: false })] });
  t.after(() => app.close());
  const answer = await request(app, '/live/events');
  assert.equal(answer.status, 502);
  assert.equal(answer.body, 'Invalid function response\n');
  const refused = events.find(event => event.event === 'stream_refused');
  assert.equal(refused?.reason, 'undeclared');
  assert.equal(refused?.route, '/live/*');
  assert.equal(state.started, false, 'an undeclared stream is never pulled');
});

test('the Vercel adapter streams a declared extension response', async t => {
  const { root, pin } = await extensionProject(t);
  const state = extensionState();
  const handler = createVercelHandler({ project: root, origin, extensions: [extension(root, pin, state)] });
  const server = http.createServer((req, res) => { void handler(req, res).catch(() => { if (!res.headersSent) res.destroy(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  const reader = await open({ address }, '/live/events');
  assert.equal(reader.headers['transfer-encoding'], 'chunked');
  await until(() => reader.chunks.join('').includes('ready'), 'the first event');
  assert.equal(state.returned, false);
  state.gate.resolve();
  assert.deepEqual(await reader.ended, { complete: true, body: 'event: ready\ndata: 1\n\ndata: 2\n\n' });
});

test('aws refuses a streaming extension before serving', async t => {
  const { root, pin } = await extensionProject(t);
  const state = extensionState();
  await assert.rejects(createRuntime(root, { target: 'aws', origin, log: () => {}, extensions: [extension(root, pin, state)] }), /streaming[\s\S]*Lambda payload format 2\.0/);
  const handler = createLambdaHandler({ project: root, origin, extensions: [extension(root, pin, state)] });
  const errors = t.mock.method(console, 'error', () => {});
  const answer = await handler({ version: '2.0', rawPath: '/live/events', rawQueryString: '', headers: {}, requestContext: { http: { method: 'GET', sourceIp: '127.0.0.1' } } });
  assert.equal(answer.statusCode, 500);
  assert.ok(errors.mock.callCount() > 0);
  assert.equal(state.started, false);
});

test('cloudflare and static builds refuse a streaming route before serving', async t => {
  const root = await project(t, { '/live': route('build', 'gate') }, { 'stream.mjs': producer });
  await assert.rejects(buildCloudflare(root, { out: root + '/dist-cf' }), /capability: streaming[\s\S]*no streamed-response lowering/);
  await assert.rejects(buildStatic(root, { out: root + '/dist-static' }), /capability: streaming[\s\S]*no response can be written while it is produced/);
});

test('capabilities report streaming as native, delegated or refused per target', async t => {
  const row = getCapabilities().capabilities.find(entry => entry.capability === 'streaming');
  assert.ok(row);
  assert.equal(row.targets['self-hosted']?.support, 'native');
  assert.equal(row.targets.vercel?.support, 'delegated');
  for (const target of ['aws', 'cloudflare', 'static'] as const) assert.equal(row.targets[target]?.support, 'refused');
  const root = await project(t, { '/live': route('capabilities', 'gate') }, { 'stream.mjs': producer });
  const loaded = await loadDocument(root);
  assert.ok(analyzeProjectCapabilities(loaded, 'self-hosted').requirements.some(item => item.capability === 'streaming' && item.support === 'native'));
  const { root: mount, pin } = await extensionProject(t);
  const registrations = [extension(mount, pin, extensionState())];
  const vercel = analyzeProjectCapabilities(await loadDocument(mount), 'vercel', registrations);
  assert.equal(vercel.compatible, true);
  assert.equal(vercel.requirements.find(item => item.capability === 'streaming')?.support, 'delegated');
  assert.equal(analyzeProjectCapabilities(await loadDocument(mount), 'aws', registrations).compatible, false);
});

test('stream limits are validated operator settings with safe defaults', () => {
  assert.deepEqual(resolveStreamLimits(), { ...defaultStreamLimits });
  assert.throws(() => resolveStreamLimits({ maxStreams: 0 }), /Stream limit/);
  assert.throws(() => resolveStreamLimits({ idleTimeoutMs: 10 }), /idle timeout/);
  assert.throws(() => resolveStreamLimits({ maxDurationMs: 1.5 }), /duration/);
  assert.throws(() => resolveStreamLimits({ maxBytes: 268435457 }), /byte limit/);
});
