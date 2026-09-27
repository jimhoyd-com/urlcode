import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

// The urlcode-authoring skill's hosted-assisted HTTP fallback (#806), exercised
// against a local mock MCP server only: these tests never reach the live service.
const helper = fileURLToPath(new URL('../.claude/skills/urlcode-authoring/hosted-plan.mjs', import.meta.url));
const RUNTIME = '0.6.4';

type Seen = { method: string; headers: IncomingMessage['headers']; body: Record<string, unknown> };
type Reply = (message: Record<string, unknown>, res: ServerResponse) => void;

const json = (res: ServerResponse, value: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
};
const plan = (version: string) => ({ task: 'x', install: { package: '@jimhoyd/urlcode', version }, kit: { runtime: { package: '@jimhoyd/urlcode', version }, reference: null, commands: {} } });
const toolResult = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: false });

async function mock(t: test.TestContext, onCall: Reply) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ method: String(body.method), headers: req.headers, body });
      if (body.method === 'initialize') return json(res, { jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } } }, { 'mcp-session-id': 'session-1' });
      if (body.method === 'notifications/initialized') { res.writeHead(202); return res.end(); }
      onCall(body, res);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` };
}

function run(args: string[]): Promise<{ code: number; out: Record<string, unknown>; ms: number }> {
  const started = Date.now();
  return new Promise(resolve => {
    execFile(process.execPath, [helper, ...args], { timeout: 30000, env: { PATH: process.env.PATH ?? '', SECRET_THAT_MUST_NOT_LEAVE: 'do-not-send' } }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
      resolve({ code, out: JSON.parse(stdout) as Record<string, unknown>, ms: Date.now() - started });
    });
  });
}

test('a successful exchange calls urlcode_task_plan with the task only and returns the version-matched kit', async t => {
  const server = await mock(t, (body, res) => json(res, { jsonrpc: '2.0', id: body.id, result: toolResult(plan(RUNTIME)) }));
  const { code, out } = await run(['--task', 'Serve a home page and redirect /old to /new permanently', '--runtime', RUNTIME, '--capabilities', 'respond,redirect', '--endpoint', server.url]);
  assert.equal(code, 0);
  assert.equal(out.outcome, 'ok');
  assert.equal(out.hostedGuidance, 'used');
  assert.deepEqual(out.runtime, { installed: RUNTIME, hosted: RUNTIME });
  assert.equal(((out.plan as { kit: { runtime: { version: string } } }).kit.runtime.version), RUNTIME);

  assert.deepEqual(server.seen.map(seen => seen.method), ['initialize', 'notifications/initialized', 'tools/call']);
  const [init, , call] = server.seen;
  assert.deepEqual(Object.keys(init!.body.params as object).sort(), ['capabilities', 'clientInfo', 'protocolVersion']);
  // Exactly the one argument the published input schema accepts; capability names lead the task text.
  assert.deepEqual(call!.body.params, { name: 'urlcode_task_plan', arguments: { task: 'respond redirect: Serve a home page and redirect /old to /new permanently' } });
  assert.deepEqual(out.sent, { tool: 'urlcode_task_plan', arguments: { task: 'respond redirect: Serve a home page and redirect /old to /new permanently' } });
  assert.equal(call!.headers['mcp-session-id'], 'session-1');
  assert.equal(call!.headers['mcp-protocol-version'], '2025-06-18');
  for (const seen of server.seen) {
    for (const header of ['authorization', 'cookie', 'proxy-authorization']) assert.equal(seen.headers[header], undefined, header);
    const wire = JSON.stringify(seen.body);
    for (const leak of ['do-not-send', process.cwd(), RUNTIME]) assert.ok(!wire.includes(leak), `request must not carry ${leak}`);
  }
});

test('a server-sent-event reply to tools/call is parsed the same way', async t => {
  const server = await mock(t, (body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: toolResult(plan(RUNTIME)) })}\n\n`);
  });
  const { code, out } = await run(['--task', 'serve static assets', '--runtime', RUNTIME, '--endpoint', server.url]);
  assert.equal(code, 0);
  assert.equal(out.outcome, 'ok');
});

test('a kit pinned to another runtime is withheld and reported as a mismatch', async t => {
  const server = await mock(t, (body, res) => json(res, { jsonrpc: '2.0', id: body.id, result: toolResult(plan('9.9.9')) }));
  const { code, out } = await run(['--task', 'redirect /old to /new', '--runtime', RUNTIME, '--endpoint', server.url]);
  assert.equal(code, 3);
  assert.equal(out.outcome, 'version-mismatch');
  assert.equal(out.hostedGuidance, 'not-used');
  assert.deepEqual(out.runtime, { installed: RUNTIME, hosted: '9.9.9' });
  assert.equal(out.plan, undefined, 'no reference material from the other runtime is passed on');
  assert.match(String(out.message), /withheld/);
});

test('an unreachable service is a bounded unavailable outcome', async t => {
  const server = await mock(t, () => undefined);
  const closed = server.url.replace(/:\d+\//, ':1/');
  const { code, out } = await run(['--task', 'redirect /old to /new', '--runtime', RUNTIME, '--endpoint', closed]);
  assert.equal(code, 1);
  assert.equal(out.outcome, 'unavailable');
  assert.equal(out.hostedGuidance, 'not-used');
  assert.match(String(out.message), /continue local-only/);
});

test('a service that never answers times out within the deadline', async t => {
  const server = await mock(t, () => undefined);
  const { code, out, ms } = await run(['--task', 'redirect /old to /new', '--runtime', RUNTIME, '--endpoint', server.url, '--timeout-ms', '1000']);
  assert.equal(code, 1);
  assert.equal(out.outcome, 'timeout');
  assert.equal(out.hostedGuidance, 'not-used');
  assert.ok(ms < 10000, `took ${ms} ms`);
});

test('HTTP errors, JSON-RPC errors, tool errors and malformed replies are unavailable outcomes', async t => {
  const cases: [string, Reply][] = [
    ['http-error', (_body, res) => { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('down'); }],
    ['rpc-error', (body, res) => json(res, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unknown tool: urlcode_task_plan' } })],
    ['tool-error', (body, res) => json(res, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'The tool could not complete the request.' }], isError: true } })],
    ['malformed', (body, res) => json(res, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'not json' }], isError: false } })],
    ['malformed', (body, res) => json(res, { jsonrpc: '2.0', id: body.id, result: toolResult({ task: 'x' }) })],
    ['malformed', (_body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"jsonrpc":'); }],
    ['malformed', (body, res) => json(res, { jsonrpc: '2.0', id: 99, result: toolResult(plan(RUNTIME)) })],
    ['malformed', (_body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(`"${'x'.repeat(1024 * 1024 + 10)}"`); }],
  ];
  for (const [outcome, reply] of cases) {
    const server = await mock(t, reply);
    const { code, out } = await run(['--task', 'redirect /old to /new', '--runtime', RUNTIME, '--endpoint', server.url]);
    assert.equal(code, 1, outcome);
    assert.equal(out.outcome, outcome);
    assert.equal(out.hostedGuidance, 'not-used');
    assert.equal(out.plan, undefined);
  }
});

test('refused input sends nothing', async t => {
  const server = await mock(t, () => assert.fail('nothing should be sent'));
  const refused: string[][] = [
    ['--task', 'add login; api_key=abcd1234efgh', '--runtime', RUNTIME],
    ['--task', 'x'.repeat(600), '--runtime', RUNTIME],
    ['--task', 'redirect /old to /new', '--runtime', 'latest'],
    ['--task', 'redirect /old to /new', '--runtime', RUNTIME, '--capabilities', 'Respond!'],
    ['--runtime', RUNTIME],
  ];
  for (const args of refused) {
    const { code, out } = await run([...args, '--endpoint', server.url]);
    assert.equal(code, 2, args.join(' '));
    assert.equal(out.outcome, 'invalid-input');
    assert.equal(out.sent, null);
  }
  const { code, out } = await run(['--task', 'redirect', '--runtime', RUNTIME, '--endpoint', 'http://example.com/mcp']);
  assert.equal(code, 2);
  assert.match(String(out.message), /https/);
  assert.equal(server.seen.length, 0);
});
