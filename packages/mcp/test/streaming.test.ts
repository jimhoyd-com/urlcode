import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntime, startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import mcp from '../src/extension.ts';
import { createMcpExtension } from '../src/mcp.ts';
import type { McpServerSpec } from '../src/mcp.ts';

// Streamed progress replies over real node:http sockets through core's server. The official SDK serves the protocol
// statelessly (#846): no sessions, no GET stream; the operator's `streaming` option only decides whether an SSE reply
// is passed through as it is produced.
// Tool handlers run in this process, so a test coordinates with one through a shared global keyed per test.
interface Probe { gate: PromiseWithResolvers<void>; started: boolean; finished: boolean; aborted?: unknown; signalSeen: boolean }
const probes = new Map<string, Probe>();
(globalThis as { __mcpStreamProbes?: Map<string, Probe> }).__mcpStreamProbes = probes;
function probe(key: string): Probe {
  const created: Probe = { gate: Promise.withResolvers<void>(), started: false, finished: false, signalSeen: false };
  probes.set(key, created);
  return created;
}
const work = `
const probes = globalThis.__mcpStreamProbes;
const aborted = signal => new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
export default async function work(input, context) {
  const p = probes.get(input.key);
  p.started = true;
  p.signalSeen = context.signal instanceof AbortSignal;
  context.progress(1, 3, 'started');
  await Promise.race([p.gate.promise, aborted(context.signal)]);
  if (context.signal.aborted) { p.aborted = context.signal.reason; return 'stopped'; }
  context.progress(2, 3);
  await new Promise(resolve => setTimeout(resolve, 30));
  context.progress(2, 3);
  context.progress(3, 3, 'done');
  p.finished = true;
  return { done: input.key };
}
`;
const origin = 'https://mcp-stream.example.test';
const spec: McpServerSpec = {
  mount: '/mcp', serverName: 'streaming', serverVersion: '1.0.0',
  tools: {
    work: { description: 'Reports progress', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }, handler: './work.mjs' },
    echo: { description: 'Echoes', inputSchema: { type: 'object', additionalProperties: true }, handler: './echo.mjs' },
  },
};
const allMethods = ['GET', 'POST', 'DELETE', 'HEAD'];

async function site(t: test.TestContext, route: Record<string, unknown> = {}, extraExtensions: Record<string, unknown> = {}): Promise<{ dir: string; pin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-stream-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'app'); await mkdir(dir);
  await writeFile(join(dir, 'work.mjs'), work);
  await writeFile(join(dir, 'echo.mjs'), 'export default function echo(input) { return input; }\n');
  await writeFile(join(dir, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { mcp: { version: '1', config: { servers: { main: spec } } }, ...extraExtensions },
    routes: { '/mcp/*': { extension: 'mcp', methods: allMethods, ...route } } }));
  return { dir, pin: await inspectExtensionRevision(dir) };
}
interface Booted { port: number; registration: RuntimeExtension; close(): Promise<void> }
async function boot(t: test.TestContext, streaming = true, server: Record<string, unknown> = {}, at?: { dir: string; pin: string }): Promise<Booted> {
  const { dir, pin } = at ?? await site(t);
  const registration = createMcpExtension({ projectSha256: pin, streaming });
  const app = await startServer({ project: dir, origin, port: 0, log: () => {}, closeTimeoutMs: 500, extensions: [registration], ...server });
  let closed = false;
  const close = async (): Promise<void> => { if (!closed) { closed = true; await app.close(); } };
  t.after(close);
  return { port: app.address.port, registration, close };
}

interface Answer { status: number; headers: http.IncomingHttpHeaders; body: string }
/** One buffered request over node:http. */
function send(port: number, method: string, headers: Record<string, string> = {}, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, agent: false, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''; res.on('data', (chunk: Buffer) => { text += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
interface SseEvent { id?: string; event?: string; data?: unknown; comment?: string }
interface Stream { status: number; headers: http.IncomingHttpHeaders; events: SseEvent[]; text: () => string; request: http.ClientRequest; ended: Promise<{ complete: boolean }> }
/** Opens a streamed request and resolves at the response head; SSE events are parsed as they arrive. */
function open(port: number, method: string, headers: Record<string, string>, body?: unknown): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, agent: false, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      const events: SseEvent[] = [];
      let raw = '', pending = '';
      res.on('data', (chunk: Buffer) => {
        raw += chunk.toString(); pending += chunk.toString();
        let index: number;
        while ((index = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, index); pending = pending.slice(index + 2);
          const event: SseEvent = {};
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) event.comment = line.slice(1).trim();
            else if (line.startsWith('id: ')) event.id = line.slice(4);
            else if (line.startsWith('event: ')) event.event = line.slice(7);
            else if (line.startsWith('data: ')) event.data = JSON.parse(line.slice(6));
          }
          events.push(event);
        }
      });
      const ended = new Promise<{ complete: boolean }>(done => {
        const finish = (): void => done({ complete: res.complete });
        res.on('end', finish); res.on('close', finish); res.on('error', finish);
      });
      resolve({ status: res.statusCode ?? 0, headers: res.headers, events, text: () => raw, request: req, ended });
    });
    req.on('error', reject);
    req.end(payload);
  });
}
async function until(check: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`); await delay(10); }
}
const messages = (stream: Stream): Record<string, unknown>[] => stream.events.filter(event => event.data !== undefined).map(event => event.data as Record<string, unknown>);
const sse = { accept: 'application/json, text/event-stream' };

const initialize = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const v = { 'mcp-protocol-version': '2025-11-25' };

test('streaming off (the default): no streams declaration, aws accepts it, GET and DELETE answer 405, and a reply is buffered', async t => {
  const at = await site(t);
  const off = createMcpExtension({ projectSha256: at.pin });
  assert.equal(off.streams, undefined, 'the registration does not declare streams');
  assert.equal(createMcpExtension({ projectSha256: at.pin, streaming: false }).streams, undefined);
  const runtime = await createRuntime(at.dir, { target: 'aws', origin, log: () => {}, extensions: [off] });
  await runtime.close();
  const { port } = await boot(t, false, {}, at);
  for (const method of ['GET', 'DELETE']) assert.equal((await send(port, method, { accept: 'text/event-stream' })).status, 405, method);
  const init = await send(port, 'POST', sse, initialize);
  assert.equal(init.status, 200);
  assert.equal(init.headers['mcp-session-id'], undefined, 'the server is stateless');
  // A progress token gets no progress events without streaming: the buffered reply carries only the result.
  const call = await send(port, 'POST', { ...sse, ...v }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 }, _meta: { progressToken: 'p' } } });
  assert.equal(call.status, 200);
  assert.equal(call.headers['content-length'] !== undefined, true, 'a buffered reply has a length');
  const data = call.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);
  assert.deepEqual(data, [{ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"a":1}' }], isError: false } }]);
});

test('streaming on: the registration declares streams and core refuses aws; vercel, which delivers streams, activates', async t => {
  const at = await site(t);
  const on = createMcpExtension({ projectSha256: at.pin, streaming: true });
  assert.equal(on.streams, true);
  await assert.rejects(createRuntime(at.dir, { target: 'aws', origin, log: () => {}, extensions: [on] }), /streaming[\s\S]*Lambda payload format 2\.0|streams responses, which target aws cannot deliver/);
  const vercel = await createRuntime(at.dir, { target: 'vercel', origin, log: () => {}, extensions: [createMcpExtension({ projectSha256: at.pin, streaming: true })] });
  await vercel.close();
});

test('host() passes the streaming option through composeHost, and anything but a boolean is refused', async t => {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = 'c'.repeat(64);
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const dir = await mkdtemp(join(tmpdir(), 'mcp-stream-host-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const on = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [mcp({ streaming: true })]);
  assert.equal(on.extensions![0]!.streams, true);
  const off = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [mcp()]);
  assert.equal(off.extensions![0]!.streams, undefined);
  assert.throws(() => createMcpExtension({ projectSha256: 'c'.repeat(64), streaming: { maxSessions: 10 } as unknown as boolean }), /streaming must be true or false/);
});

test('a tools/call with a progress token streams progress before the result, then ends', async t => {
  const { port } = await boot(t);
  const p = probe('progress');
  const stream = await open(port, 'POST', { ...sse, ...v }, { jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'work', arguments: { key: 'progress' }, _meta: { progressToken: 'tok' } } });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream');
  assert.equal(stream.headers['cache-control'], 'no-store');
  await until(() => messages(stream).length === 1, 'the first progress notification');
  assert.deepEqual(messages(stream)[0], { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok', progress: 1, total: 3, message: 'started' } });
  assert.equal(p.finished, false, 'the tool is still running when its first progress arrives');
  assert.equal(p.signalSeen, true, 'a tool handler receives an AbortSignal');
  p.gate.resolve();
  assert.deepEqual(await stream.ended, { complete: true });
  const all = messages(stream);
  const progress = all.slice(0, -1).map(message => (message.params as { progress: number }).progress);
  assert.equal(progress.at(-1), 3);
  assert.ok(all.slice(0, -1).every(message => message.method === 'notifications/progress'));
  assert.deepEqual(all.at(-1), { jsonrpc: '2.0', id: 'call-1', result: { content: [{ type: 'text', text: '{"done":"progress"}' }], isError: false } });
});

test('without a progress token a tools/call sends only its result', async t => {
  const { port } = await boot(t);
  const plain = await open(port, 'POST', { ...sse, ...v }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } });
  await plain.ended;
  assert.deepEqual(messages(plain), [{ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '{"x":1}' }], isError: false } }]);
});

test('a client disconnect cancels an in-flight streamed tool call', async t => {
  const { port } = await boot(t);
  const p = probe('disconnect');
  const stream = await open(port, 'POST', { ...sse, ...v }, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'work', arguments: { key: 'disconnect' }, _meta: { progressToken: 1 } } });
  await until(() => messages(stream).length === 1, 'the first progress notification');
  stream.request.destroy();
  await until(() => p.aborted !== undefined, 'the tool to see its signal abort');
  assert.equal(p.finished, false);
});
