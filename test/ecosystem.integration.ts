// The #841 ecosystem conformance fixture end to end with real npm (proofs/ecosystem): pack this checkout's core as a
// release does, install it with zod, hono and @hono/node-server into a copy of the site, and check
//   1. direct library use: a trusted function route imports zod through its own API with no URLCode adapter,
//      descriptor, catalog entry or wrapper; the same import on a `sandbox: true` route is refused before serving;
//      explain/review label the route as trusted code whose execution is not evaluated;
//   2. a second host: URLCode embedded in a Hono application (createRuntime + an operator bridge) answering the same
//      requests as URLCode's own server, with every difference that is a hosting gap asserted explicitly.
// It needs the npm registry for the three libraries; run after `npm run build` (npm run test:ecosystem).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { withPublishedManifest } from '../scripts/published-manifest.mjs';
import { npmCommand } from '../scripts/npm-command.ts';
import { repositoryRoot } from '../scripts/workspaces.ts';

const proof = join(repositoryRoot, 'proofs', 'ecosystem');

interface Run { status: number | null; stdout: string; stderr: string }
function run(t: TestContext, cwd: string, command: string, args: string[], env: Record<string, string> = {}): Run {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env } });
  t.diagnostic(`${args.slice(0, 3).join(' ')} -> ${result.status}`);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
const npm = (t: TestContext, cwd: string, args: string[]): Run => { const command = npmCommand(args); return run(t, cwd, command.command, command.args); };
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); }).on('error', reject);
});
const listening = (port: number): Promise<boolean> => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false);

/** A raw request, for what fetch cannot send: a chosen Host header and repeated header lines. */
function raw(port: number, path: string, headers: [string, string][]): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', setHost: false, headers: headers.flat() as unknown as Record<string, string> }, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; }).on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject).end();
  });
}
/** The status a server answers to a POST that only announces an oversized body, before any of it is sent. */
function announcedBody(port: number, path: string, length: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { host: `localhost:${port}`, 'content-type': 'text/plain', 'content-length': String(length) } }, response => {
      resolve(response.statusCode ?? 0); response.resume(); request.destroy();
    });
    request.on('error', reject).flushHeaders();
  });
}

interface Served { name: string; port: number; origin: string; process: ChildProcess; output: () => string }
async function launch(name: string, cwd: string, args: string[], env: Record<string, string>, ready: (port: number, output: string) => Promise<boolean>, port: number): Promise<Served> {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  for (let attempt = 0; ; attempt++) {
    if (await ready(port, output)) break;
    assert.ok(attempt < 150 && child.exitCode === null, `${name} did not start: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return { name, port, origin: `http://localhost:${port}`, process: child, output: () => output };
}
const stop = async (served: Served): Promise<number | null> => {
  if (served.process.exitCode !== null) return served.process.exitCode;
  const exited = new Promise<number | null>(resolve => served.process.once('exit', code => resolve(code)));
  served.process.kill('SIGTERM');
  return exited;
};

test('ecosystem: direct npm library use and URLCode hosted inside Hono', { timeout: 1200000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-ecosystem-'));
  const closers: (() => unknown)[] = [];
  t.after(async () => { while (closers.length) try { await closers.pop()!(); } catch { /* keep unwinding */ } });
  closers.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  // Core exactly as a release packs it; the site depends on that tarball instead of the checkout.
  const packed = join(root, 'packed');
  await mkdir(packed);
  const core = await withPublishedManifest(repositoryRoot, () => {
    const command = npmCommand(['pack', '--ignore-scripts', '--json', '--pack-destination', packed]);
    const result = spawnSync(command.command, command.args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return join(packed, (JSON.parse(result.stdout) as { filename: string }[])[0]!.filename);
  });
  const site = join(root, 'site');
  await cp(proof, site, { recursive: true, filter: source => !/[/\\](node_modules|package-lock\.json)$/.test(source) });
  const manifestFile = join(site, 'package.json'), pkg = JSON.parse(await readFile(manifestFile, 'utf8')) as { dependencies: Record<string, string> };
  pkg.dependencies['@jimhoyd/urlcode'] = `file:${core}`;
  await writeFile(manifestFile, JSON.stringify(pkg, null, 2) + '\n');
  // Installation may use the network; nothing after it does.
  const installed = npm(t, site, ['install', '--no-audit', '--no-fund']);
  assert.equal(installed.status, 0, installed.stderr);

  const cli = join(site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'cli.js');
  const { inspectExtensionRevision } = await import(join(site, 'node_modules', '@jimhoyd', 'urlcode', 'dist', 'extensions.js')) as { inspectExtensionRevision(project: string): Promise<string> };
  // The evaluator's step: review the project, then pin the operator extensions in host.mjs to this revision.
  const reviewed = { PROJECT_SHA256: await inspectExtensionRevision(join(site, 'app')) };
  const urlcode = (args: string[], env: Record<string, string> = reviewed): Run => run(t, site, process.execPath, [cli, ...args], env);
  const hosted = ['--project', 'app', '--host-file', 'host.mjs'];

  await t.test('zod is an ordinary dependency, used through its own API with no URLCode metadata', async () => {
    const zod = JSON.parse(await readFile(join(site, 'node_modules', 'zod', 'package.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(zod.version, '4.6.5');
    assert.equal(Object.keys(zod).some(key => /urlcode/i.test(key)), false);
    assert.equal(existsSync(join(site, 'node_modules', 'zod', 'urlcode.json')), false);
    assert.match(await readFile(join(site, 'app', 'functions', 'validate.mjs'), 'utf8'), /^import \* as z from 'zod';$/m);
    // Nothing about zod appears in the project declaration either.
    assert.doesNotMatch(await readFile(join(site, 'app', 'urlcode.yaml'), 'utf8'), /zod:|package:|adapter/);
    const valid = urlcode(['validate', '--local', ...hosted, '--origin', 'http://localhost:4190']);
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    // The declarative fixtures (zod accept/reject included) on URLCode's own test harness.
    const fixtures = urlcode(['test', ...hosted, '--origin', 'http://localhost:4190']);
    assert.equal(fixtures.status, 0, fixtures.stdout + fixtures.stderr);
  });

  await t.test('direct use does not waive the sandbox: the same import on a sandbox: true route is refused', () => {
    const refused = urlcode(['validate', '--local', '--project', 'sandboxed'], {});
    assert.notEqual(refused.status, 0);
    const error = JSON.parse(refused.stderr.trim().split('\n').at(-1)!) as { code: string; message: string; file: string };
    assert.equal(error.code, 'sandbox-import');
    assert.equal(error.file, 'functions/validate.mjs');
    assert.match(error.message, /imports "zod"\. A sandbox: true function has no Node built-ins or packages/);
    // Serving refuses it too, before listening.
    const serve = urlcode(['serve', '--project', 'sandboxed', '--port', '0'], {});
    assert.notEqual(serve.status, 0);
    assert.match(serve.stderr, /sandbox-import/);
  });

  await t.test('explain and review label the route as trusted code whose execution is not evaluated', () => {
    const text = urlcode(['explain', '/app/api/validate', ...hosted]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /^execution: trusted \(in-process\)$/m);
    assert.match(text.stdout, /handler execution are not evaluated/);
    const json = JSON.parse(urlcode(['explain', '/app/api/validate', ...hosted, '--json']).stdout) as { sandbox: boolean; handler: { kind: string; source: string } };
    assert.deepEqual([json.sandbox, json.handler.kind, json.handler.source], [false, 'function', 'functions/validate.mjs']);
    // The Hono app behind the extension mount: review sees the mount, not the app's routes.
    assert.match(urlcode(['explain', '/app/hono/deep/1/2', ...hosted]).stdout, /"subpaths":"provider-defined, not enumerated or inspected by URLCode"/);
    const review = JSON.parse(urlcode(['review', ...hosted, '--json']).stdout) as { observations: { signal: string; routes: string[] }[] };
    const signals = review.observations.map(item => `${item.signal} ${item.routes.join(',')}`).sort();
    // Recorded as found (proofs/ecosystem/README.md): review suggests the declarative request.body schema instead of
    // the zod code, and misreads Hono's in-process app.fetch(request) as an outbound network call. The installed
    // package zod itself is not named anywhere in explain or review.
    assert.deepEqual(signals, ['manual-body-validation /app/api/validate', 'outbound-network-call /app/sub/hello,/app/sub/items,/app/sub/items/{id}']);
  });

  // Both hosts: URLCode's own server, and the Hono application embedding the same project.
  const nativePort = await freePort(), honoPort = await freePort();
  const native = await launch('urlcode serve', site, [cli, 'serve', ...hosted, '--origin', `http://localhost:${nativePort}`, '--port', String(nativePort), '--trusted-proxies', '127.0.0.1/32'], reviewed,
    port => fetch(`http://127.0.0.1:${port}/_urlcode/ready`).then(response => response.ok, () => false), nativePort);
  closers.push(() => stop(native));
  const hono = await launch('hono', site, [join('hono', 'server.mjs'), '--origin', `http://localhost:${honoPort}`, '--port', String(honoPort)], reviewed,
    async (_port, output) => output.includes('"listening"'), honoPort);
  closers.push(() => stop(hono));

  const call = (served: Served, path: string, init: RequestInit = {}): Promise<Response> => fetch(`http://127.0.0.1:${served.port}${path}`, { redirect: 'manual', ...init });
  interface Shape { status: number; body: string; type: string | null; cache: string | null; nosniff: string | null; location: string | null; allow: string | null; cookies: string[]; echo: string | null; requestId: boolean }
  const shape = async (response: Response): Promise<Shape> => ({
    status: response.status, body: await response.text(), type: response.headers.get('content-type'), cache: response.headers.get('cache-control'),
    nosniff: response.headers.get('x-content-type-options'), location: response.headers.get('location'), allow: response.headers.get('allow'),
    cookies: response.headers.getSetCookie(), echo: response.headers.get('x-echo'), requestId: /^[0-9a-f-]{36}$/.test(response.headers.get('x-request-id') ?? ''),
  });

  await t.test('the embedded runtime answers as URLCode\'s own server does', async () => {
    const json = { 'content-type': 'application/json' };
    const cases: [string, RequestInit][] = [
      ['/app/api/validate', { method: 'POST', headers: json, body: JSON.stringify({ name: ' Ada ', email: 'ada@example.test', tags: ['x'] }) }],
      ['/app/api/validate', { method: 'POST', headers: json, body: JSON.stringify({ name: '', email: 'nope' }) }],
      ['/app/api/validate', { method: 'POST', headers: json, body: 'not json' }],
      ['/app/api/validate', {}],
      ['/app/api/who/ada', {}],
      ['/app/api/who/ADA', {}],
      ['/app/api/who/ada', { method: 'HEAD' }],
      ['/app/go', {}],
      ['/app/sub/hello', {}],
      ['/app/sub/items/7?q=x', {}],
      ['/app/sub/items/x', {}],
      ['/app/sub/items', { method: 'POST', headers: json, body: '{"n":1}' }],
      ['/app/hono/deep/1/2', {}],
      ['/app/hono/echo', { method: 'POST', headers: json, body: '{"n":2}' }],
      ['/app/hono/nothing', {}],
      ['/app/nothing', {}],
      ['/app/api/echo', { method: 'DELETE' }],
    ];
    const untyped: string[] = [];
    for (const [path, init] of cases) {
      const [expected, actual] = [await shape(await call(native, path, init)), await shape(await call(hono, path, init))];
      // The one byte-level difference: @hono/node-server gives a body without a Content-Type its own default.
      if (expected.type === null && expected.body !== '' && actual.type === 'text/plain; charset=UTF-8') { untyped.push(`${init.method ?? 'GET'} ${path}`); actual.type = null; }
      assert.deepEqual(actual, expected, `${init.method ?? 'GET'} ${path}`);
    }
    assert.deepEqual(untyped, ['GET /app/api/validate', 'DELETE /app/api/echo']);
    // Spot-check that the table exercised what it claims.
    const accepted = await (await call(hono, '/app/api/validate', cases[0]![1])).json() as { value: unknown };
    assert.deepEqual(accepted.value, { name: 'Ada', email: 'ada@example.test', tags: ['x'] });
    assert.equal((await call(hono, '/app/go')).headers.get('location'), '/app/api/who/ada');
    // The request body limit (1 MiB unless the route sets less) refuses before reading, in both hosts.
    for (const served of [native, hono]) assert.equal(await announcedBody(served.port, '/app/api/echo', 1048577), 413, served.name);
  });

  await t.test('request bodies, headers, cookies and the URL a function sees', async () => {
    for (const served of [native, hono]) {
      const response = await call(served, '/app/api/echo?x=1', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-custom': 'kept' }, body: 'hello body' });
      const seen = await response.json() as { method: string; url: string; contentType: string; custom: string; bodyText: string; requestId: string };
      // The function's URL is built from the operator origin, never from the Host header the host received.
      assert.deepEqual({ ...seen, requestId: undefined }, { method: 'POST', url: `${served.origin}/app/api/echo?x=1`, contentType: 'text/plain', custom: 'kept', bodyText: 'hello body', requestId: undefined }, served.name);
      assert.equal(response.headers.get('x-request-id'), seen.requestId, served.name);
      assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/app; HttpOnly', 'b=2; Path=/app; HttpOnly'], served.name);
    }
  });

  await t.test('a streamed response is delivered as produced', async () => {
    for (const served of [native, hono]) {
      const response = await call(served, '/app/api/stream');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), null, served.name);
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      const first = decoder.decode((await reader.read()).value);
      assert.match(first, /^chunk 1\n/, served.name);
      assert.doesNotMatch(first, /chunk 3/, `${served.name} buffered the stream`);
      let rest = '';
      for (let next = await reader.read(); !next.done; next = await reader.read()) rest += decoder.decode(next.value, { stream: true });
      assert.equal(first + rest, 'chunk 1\nchunk 2\nchunk 3\n', served.name);
    }
  });

  await t.test('origin and same-origin admission follow the operator origin in both hosts', async () => {
    for (const served of [native, hono]) {
      const probe = async (headers: Record<string, string>) => await (await call(served, '/app/probe/x', { headers })).json() as { origin: string; sameOrigin: boolean; client: string };
      assert.equal((await probe({})).origin, served.origin, served.name);
      assert.equal((await probe({ origin: served.origin })).sameOrigin, true, served.name);
      assert.equal((await probe({ origin: 'https://attacker.example' })).sameOrigin, false, served.name);
      assert.equal((await probe({ 'sec-fetch-site': 'cross-site', origin: served.origin })).sameOrigin, false, served.name);
      assert.equal((await probe({})).sameOrigin, false, served.name);
      // Repeated Origin lines refuse: the Hono bridge hands URLCode Node's raw header lines, so the count survives.
      const repeated = await raw(served.port, '/app/probe/x', [['host', `localhost:${served.port}`], ['origin', served.origin], ['origin', served.origin]]);
      assert.equal((JSON.parse(repeated.body) as { sameOrigin: boolean }).sameOrigin, false, served.name);
    }
  });

  await t.test('client address: the socket peer in both; forwarded headers only where URLCode owns the server', async () => {
    const client = async (served: Served, headers: Record<string, string> = {}) => ((await (await call(served, '/app/probe/x', { headers })).json()) as { client: string }).client;
    assert.equal(await client(native), '127.0.0.1');
    assert.equal(await client(hono), '127.0.0.1');
    // `urlcode serve --trusted-proxies 127.0.0.1/32` resolves X-Forwarded-For from a trusted peer.
    assert.equal(await client(native, { 'x-forwarded-for': '203.0.113.9' }), '203.0.113.9');
    // The embedded runtime receives whatever address the host passes; this bridge passes the peer and has no
    // trusted-proxy list, because core does not export its resolver (gap).
    assert.equal(await client(hono, { 'x-forwarded-for': '203.0.113.9' }), '127.0.0.1');
  });

  await t.test('features that belong to URLCode\'s own server are absent when Hono owns it', async () => {
    // Health and readiness probes are startServer routes, not project routes.
    assert.equal((await call(native, '/_urlcode/health')).status, 200);
    assert.equal((await call(hono, '/_urlcode/health')).status, 404);
    assert.equal((await call(hono, '/healthz')).status, 200);
    // The loopback DNS-rebinding defence (421 for a foreign Host) is startServer's; Hono serves the request.
    assert.equal((await raw(native.port, '/app/api/who/ada', [['host', 'evil.example']])).status, 421);
    assert.equal((await raw(hono.port, '/app/api/who/ada', [['host', 'evil.example']])).status, 200);
    // The per-request event log is written by startServer, not by the runtime: the embedding host logs its own way.
    assert.match(native.output(), /"event":"request"/);
    assert.doesNotMatch(hono.output(), /"event":"request"/);
    // Hono keeps its own routes beside URLCode's.
    assert.equal(await (await call(hono, '/')).text(), 'Hono owns this page');
    // URLCode has no base-path setting: under Hono's prefix-stripping mount() it sees /app/..., so the absolute
    // redirect it generates drops the /mounted prefix, and a function's URL omits it.
    const mounted = await call(hono, '/mounted/app/go');
    assert.deepEqual([mounted.status, mounted.headers.get('location')], [302, '/app/api/who/ada']);
    const seen = await (await call(hono, '/mounted/app/api/echo')).json() as { url: string };
    assert.equal(seen.url, `${hono.origin}/app/api/echo`);
  });

  await t.test('lifecycle: an embedded project that cannot activate never listens', async () => {
    for (const [name, args, env, message] of [
      ['stale revision pin', [], { PROJECT_SHA256: '0'.repeat(64) }, /revision pin mismatch/i],
      ['sandboxed direct import', ['--project', join(site, 'sandboxed')], reviewed, /imports \\"zod\\"\. A sandbox: true function/],
    ] as const) {
      const port = await freePort();
      const refused = run(t, site, process.execPath, [join('hono', 'server.mjs'), '--origin', `http://localhost:${port}`, '--port', String(port), ...args], env);
      assert.equal(refused.status, 1, name);
      assert.match(refused.stderr, message, name);
      assert.doesNotMatch(refused.stderr, /\n\s+at /, name);
      assert.equal(await listening(port), false, name);
    }
  });

  await t.test('lifecycle: SIGTERM closes the Hono server and the runtime', async () => {
    assert.equal(await stop(hono), 0, hono.output());
    assert.equal(await listening(hono.port), false);
  });
});
