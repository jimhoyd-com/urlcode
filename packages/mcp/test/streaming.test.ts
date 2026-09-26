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
import type { ExtensionRequest, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import mcp from '../src/extension.ts';
import { createMcpExtension, mcpSessionRegistry } from '../src/mcp.ts';
import type { McpServerSpec, McpStreamingOptions } from '../src/mcp.ts';
import { resolveStreamingOptions } from '../src/sessions.ts';

// The optional Streamable HTTP transport parts (issue #659), over real node:http sockets through core's server.
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
async function boot(t: test.TestContext, streaming: boolean | McpStreamingOptions = true, server: Record<string, unknown> = {}, at?: { dir: string; pin: string }): Promise<Booted> {
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
async function initialize(port: number, headers: Record<string, string> = {}): Promise<string> {
  const answer = await send(port, 'POST', { ...sse, ...headers }, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  assert.equal(answer.status, 200);
  const id = answer.headers['mcp-session-id'];
  assert.equal(typeof id, 'string');
  return id as string;
}
const session = (id: string, extra: Record<string, string> = {}): Record<string, string> => ({ 'mcp-session-id': id, 'mcp-protocol-version': '2025-11-25', ...extra });

test('streaming off (the default): no streams declaration, GET and DELETE answer 405, no session id, and aws accepts the registration', async t => {
  const at = await site(t);
  const off = createMcpExtension({ projectSha256: at.pin });
  assert.equal(off.streams, undefined, 'the registration does not declare streams');
  assert.equal(createMcpExtension({ projectSha256: at.pin, streaming: false }).streams, undefined);
  const runtime = await createRuntime(at.dir, { target: 'aws', origin, log: () => {}, extensions: [off] });
  await runtime.close();
  const { port } = await boot(t, false, {}, at);
  for (const method of ['GET', 'DELETE']) {
    const answer = await send(port, method, { accept: 'text/event-stream' });
    assert.equal(answer.status, 405, method);
    assert.equal(answer.headers.allow, 'POST');
  }
  const init = await send(port, 'POST', sse, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(init.headers['mcp-session-id'], undefined);
  assert.equal(init.headers['content-type'], 'application/json; charset=utf-8');
  // A progress token with an SSE Accept still gets the plain JSON reply, and no session is required.
  const call = await send(port, 'POST', sse, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 }, _meta: { progressToken: 'p' } } });
  assert.equal(call.status, 200);
  assert.deepEqual(JSON.parse(call.body), { jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{"a":1}' }], isError: false } });
});

test('streaming on: the registration declares streams, core refuses aws with the streaming reason and activation refuses vercel', async t => {
  const at = await site(t);
  const on = createMcpExtension({ projectSha256: at.pin, streaming: true });
  assert.equal(on.streams, true);
  await assert.rejects(createRuntime(at.dir, { target: 'aws', origin, log: () => {}, extensions: [on] }), /streaming[\s\S]*Lambda payload format 2\.0|streams responses, which target aws cannot deliver/);
  await assert.rejects(createRuntime(at.dir, { target: 'vercel', origin, log: () => {}, extensions: [createMcpExtension({ projectSha256: at.pin, streaming: true })] }), /mcp streaming keeps sessions in this process's memory, which target vercel/);
});

test('host() passes the streaming option through composeHost; the options are validated with safe defaults', async t => {
  const previous = process.env.PROJECT_SHA256;
  process.env.PROJECT_SHA256 = 'c'.repeat(64);
  t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
  const dir = await mkdtemp(join(tmpdir(), 'mcp-stream-host-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const on = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [mcp({ streaming: { maxSessions: 10 } })]);
  assert.equal(on.extensions![0]!.streams, true);
  const off = await composeHost(pathToFileURL(join(dir, 'host.mjs')), [mcp()]);
  assert.equal(off.extensions![0]!.streams, undefined);
  assert.deepEqual(resolveStreamingOptions(true), { maxSessions: 1000, sessionIdleTimeoutMs: 1_800_000, keepAliveMs: 15_000, replayMaxEvents: 64, replayMaxBytes: 65_536 });
  assert.equal(resolveStreamingOptions(undefined), undefined);
  assert.throws(() => resolveStreamingOptions({ maxSessions: 0 }), /maxSessions must be an integer from 1/);
  assert.throws(() => resolveStreamingOptions({ keepAliveMs: 1.5 }), /keepAliveMs/);
  assert.throws(() => resolveStreamingOptions({ keepAliveMs: 5000, sessionIdleTimeoutMs: 5000 }), /below sessionIdleTimeoutMs/);
  assert.throws(() => resolveStreamingOptions({ unknown: 1 } as McpStreamingOptions), /not known/);
});

test('sessions: initialize issues a random visible-ASCII id; a missing id is 400, an unknown one 404, and DELETE ends it', async t => {
  const { port } = await boot(t);
  const id = await initialize(port);
  assert.match(id, /^[\x21-\x7e]{43}$/);
  assert.notEqual(await initialize(port), id, 'every initialize issues a new session');
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.deepEqual(JSON.parse((await send(port, 'POST', session(id), ping)).body), { jsonrpc: '2.0', id: 1, result: {} });
  const missing = await send(port, 'POST', { 'mcp-protocol-version': '2025-11-25' }, ping);
  assert.equal(missing.status, 400);
  assert.equal(missing.body, 'Missing Mcp-Session-Id header');
  assert.equal((await send(port, 'POST', { 'mcp-protocol-version': '2025-11-25' }, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 400, 'a notification needs its session too');
  assert.equal((await send(port, 'POST', session(id), { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const unknown = await send(port, 'POST', session('not-a-session'), ping);
  assert.equal(unknown.status, 404);
  assert.equal((await send(port, 'GET', { ...session('not-a-session'), accept: 'text/event-stream' })).status, 404);
  assert.equal((await send(port, 'DELETE', { 'mcp-protocol-version': '2025-11-25' })).status, 400);
  assert.equal((await send(port, 'GET', { ...session(id), accept: 'application/json' })).status, 406, 'the GET stream needs an event-stream Accept');
  const ended = await send(port, 'DELETE', session(id));
  assert.equal(ended.status, 204);
  assert.equal((await send(port, 'POST', session(id), ping)).status, 404, 'an ended session answers 404, so the client re-initializes');
  assert.equal((await send(port, 'DELETE', session(id))).status, 404);
  assert.equal((await send(port, 'PUT', session(id))).status, 405);
});

test('sessions are bounded: the least recently used one is evicted, and an idle one expires', async t => {
  const { port } = await boot(t, { maxSessions: 2, sessionIdleTimeoutMs: 1000, keepAliveMs: 200 });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const first = await initialize(port);
  const second = await initialize(port);
  assert.equal((await send(port, 'POST', session(first), ping)).status, 200, 'using first makes second the least recently used');
  const third = await initialize(port);
  assert.equal((await send(port, 'POST', session(second), ping)).status, 404, 'the least recently used session was evicted');
  assert.equal((await send(port, 'POST', session(first), ping)).status, 200);
  assert.equal((await send(port, 'POST', session(third), ping)).status, 200);
  await delay(1200);
  assert.equal((await send(port, 'POST', session(first), ping)).status, 404, 'an idle session expires');
});

test('a session is bound to the principal that created it: another caller gets 404 for its id', async t => {
  const at = await site(t, { policies: { extensions: { badge: {} } } }, { badge: { version: '1', config: {} } });
  const badge: RuntimeExtension = {
    name: 'badge', version: '1', projectSha256: at.pin, targets: ['node'], providesPrincipal: true,
    schema: { type: 'object' }, policySchema: { type: 'object' },
    activate: () => ({
      handle: () => ({ status: 404, headers: [] }),
      authorize(_policy: unknown, request: ExtensionRequest) {
        const match = /^Badge (\S+)$/.exec(request.headers.get('authorization') ?? '');
        if (!match) return { status: 401, headers: [], body: 'no badge' };
        request.setPrincipal!({ id: match[1]! });
        return undefined;
      },
    }),
  };
  const registration = createMcpExtension({ projectSha256: at.pin, streaming: true });
  const app = await startServer({ project: at.dir, origin, port: 0, log: () => {}, extensions: [badge, registration] });
  t.after(() => app.close());
  const port = app.address.port;
  const alice = await initialize(port, { authorization: 'Badge alice' });
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await send(port, 'POST', session(alice, { authorization: 'Badge alice' }), ping)).status, 200);
  assert.equal((await send(port, 'POST', session(alice, { authorization: 'Badge bob' }), ping)).status, 404, 'bob cannot use alice\'s session');
  assert.equal((await send(port, 'GET', session(alice, { authorization: 'Badge bob', accept: 'text/event-stream' }))).status, 404);
  assert.equal((await send(port, 'DELETE', session(alice, { authorization: 'Badge bob' }))).status, 404, 'nor end it');
  assert.equal((await send(port, 'POST', session(alice, { authorization: 'Badge alice' }), ping)).status, 200);
});

test('a tools/call with a progress token and an SSE Accept streams progress before the result, then ends', async t => {
  const { port } = await boot(t);
  const id = await initialize(port);
  const p = probe('progress');
  const stream = await open(port, 'POST', session(id, sse), { jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'work', arguments: { key: 'progress' }, _meta: { progressToken: 'tok' } } });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream');
  assert.equal(stream.headers['cache-control'], 'no-store');
  await until(() => messages(stream).length === 1, 'the first progress notification');
  assert.deepEqual(messages(stream)[0], { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'tok', progress: 1, total: 3, message: 'started' } });
  assert.equal(p.finished, false, 'the tool is still running when its first progress arrives');
  assert.equal(p.signalSeen, true, 'a streaming tool handler receives an AbortSignal');
  p.gate.resolve();
  assert.deepEqual(await stream.ended, { complete: true });
  const all = messages(stream);
  const progress = all.slice(0, -1).map(message => (message.params as { progress: number }).progress);
  assert.ok(progress.every((value, index) => index === 0 || value > progress[index - 1]!), `progress increases: ${progress.join(',')}`);
  assert.equal(progress.at(-1), 3);
  assert.ok(all.slice(0, -1).every(message => message.method === 'notifications/progress'));
  assert.deepEqual(all.at(-1), { jsonrpc: '2.0', id: 'call-1', result: { content: [{ type: 'text', text: '{"done":"progress"}' }], isError: false } });
  assert.ok(stream.events.every(event => event.id === undefined), 'a POST stream is not resumable, so its events carry no id');
});

test('without a progress token or an SSE Accept, a tools/call keeps the plain JSON reply', async t => {
  const { port } = await boot(t);
  const id = await initialize(port);
  const plain = await send(port, 'POST', session(id, sse), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } });
  assert.equal(plain.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(JSON.parse(plain.body).result.isError, false);
  const jsonOnly = await send(port, 'POST', session(id, { accept: 'application/json' }), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: {}, _meta: { progressToken: 7 } } });
  assert.equal(jsonOnly.headers['content-type'], 'application/json; charset=utf-8');
});

test('a client disconnect cancels an in-flight streamed tool call', async t => {
  const { port } = await boot(t);
  const id = await initialize(port);
  const p = probe('disconnect');
  const stream = await open(port, 'POST', session(id, sse), { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'work', arguments: { key: 'disconnect' }, _meta: { progressToken: 1 } } });
  await until(() => messages(stream).length === 1, 'the first progress notification');
  stream.request.destroy();
  await until(() => p.aborted !== undefined, 'the tool to see its signal abort');
  assert.equal(p.aborted, 'client-closed');
  assert.equal(p.finished, false);
});

test('notifications/cancelled aborts the named in-flight request of the same session', async t => {
  const { port } = await boot(t);
  const id = await initialize(port);
  const p = probe('cancelled');
  const pending = send(port, 'POST', session(id, { accept: 'application/json' }), { jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'work', arguments: { key: 'cancelled' } } });
  await until(() => p.started, 'the tool to start');
  const other = await initialize(port);
  assert.equal((await send(port, 'POST', session(other), { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow' } })).status, 202);
  await delay(50);
  assert.equal(p.aborted, undefined, 'another session cannot cancel the request');
  assert.equal((await send(port, 'POST', session(id), { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow', reason: 'user' } })).status, 202);
  const answer = await pending;
  assert.equal(p.aborted, 'cancelled');
  assert.equal(JSON.parse(answer.body).id, 'slow', 'the response is still sent; a client ignores it after cancelling');
});

test('the GET stream delivers a server-initiated message with an event id', async t => {
  const { port, registration } = await boot(t);
  const id = await initialize(port);
  const stream = await open(port, 'GET', session(id, { accept: 'text/event-stream' }));
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream');
  const registry = mcpSessionRegistry(registration)!;
  assert.equal(registry.send(id, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } }), true);
  await until(() => messages(stream).length === 1, 'the server-initiated message');
  assert.deepEqual(stream.events.find(event => event.data !== undefined), { id: '1', event: 'message', data: { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hello' } } });
  assert.equal(registry.send('unknown', {}), false);
  stream.request.destroy();
});

test('reconnect with Last-Event-ID replays exactly the missed events in order; past the buffer only what is still kept', async t => {
  const { port, registration } = await boot(t, { replayMaxEvents: 4, keepAliveMs: 5000 });
  const id = await initialize(port);
  const registry = mcpSessionRegistry(registration)!;
  const note = (n: number): unknown => ({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: n } });
  const numbers = (stream: Stream): number[] => messages(stream).map(message => (message.params as { data: number }).data);
  const ids = (stream: Stream): string[] => stream.events.filter(event => event.id !== undefined).map(event => event.id!);

  const first = await open(port, 'GET', session(id, { accept: 'text/event-stream' }));
  registry.send(id, note(1)); registry.send(id, note(2));
  await until(() => numbers(first).length === 2, 'the first two events');
  assert.deepEqual(ids(first), ['1', '2']);
  first.request.destroy();
  await first.ended;
  // Sent while no stream is connected.
  registry.send(id, note(3)); registry.send(id, note(4));
  const second = await open(port, 'GET', session(id, { accept: 'text/event-stream', 'last-event-id': '2' }));
  await until(() => numbers(second).length === 2, 'the replayed events');
  registry.send(id, note(5));
  await until(() => numbers(second).length === 3, 'the live event after the replay');
  assert.deepEqual(numbers(second), [3, 4, 5]);
  assert.deepEqual(ids(second), ['3', '4', '5']);
  second.request.destroy();
  await second.ended;

  // Six more while disconnected: the buffer keeps only the newest four (8..11), so 6 and 7 are gone.
  for (let n = 6; n <= 11; n++) registry.send(id, note(n));
  const third = await open(port, 'GET', session(id, { accept: 'text/event-stream', 'last-event-id': '5' }));
  await until(() => numbers(third).length === 4, 'what the buffer still keeps');
  assert.deepEqual(ids(third), ['8', '9', '10', '11'], 'ids are consecutive, so the client can see that 6 and 7 were lost');

  // A newer GET for the same session replaces the open one, which ends cleanly.
  const fourth = await open(port, 'GET', session(id, { accept: 'text/event-stream', 'last-event-id': '11' }));
  assert.deepEqual(await third.ended, { complete: true });
  registry.send(id, note(12));
  await until(() => numbers(fourth).length === 1, 'the event on the replacing stream');
  assert.deepEqual(numbers(fourth), [12]);
  fourth.request.destroy();

  for (const bad of ['99', 'abc', '-1']) {
    assert.equal((await send(port, 'GET', session(id, { accept: 'text/event-stream', 'last-event-id': bad }))).status, 400, `Last-Event-ID ${bad}`);
  }
});

test('DELETE ends the session\'s open GET stream', async t => {
  const { port } = await boot(t);
  const id = await initialize(port);
  const stream = await open(port, 'GET', session(id, { accept: 'text/event-stream' }));
  assert.equal((await send(port, 'DELETE', session(id))).status, 204);
  assert.deepEqual(await stream.ended, { complete: true });
});

test('a restarted server does not know an old session id: 404, and the client re-initializes', async t => {
  const at = await site(t);
  const before = await boot(t, true, {}, at);
  const old = await initialize(before.port);
  await before.close();
  const after = await boot(t, true, {}, at);
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await send(after.port, 'POST', session(old), ping)).status, 404);
  const fresh = await initialize(after.port);
  assert.equal((await send(after.port, 'POST', session(fresh), ping)).status, 200);
});

test('keep-alive comments hold a quiet GET stream open past the server stream idle timeout', async t => {
  const { port, registration } = await boot(t, { keepAliveMs: 200 }, { streamIdleTimeoutMs: 1000 });
  const id = await initialize(port);
  const stream = await open(port, 'GET', session(id, { accept: 'text/event-stream' }));
  let ended = false;
  void stream.ended.then(() => { ended = true; });
  await delay(2500);
  assert.equal(ended, false, 'the stream outlived the 1 s idle timeout');
  assert.ok(stream.events.filter(event => event.comment === 'ping').length >= 5, 'keep-alive comments were sent');
  mcpSessionRegistry(registration)!.send(id, { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'late' } });
  await until(() => messages(stream).length === 1, 'the event after the quiet period');
  stream.request.destroy();
});
