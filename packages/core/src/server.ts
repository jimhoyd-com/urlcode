import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative as relativePath, resolve as resolvePath, sep as pathSep } from 'node:path';
import { siteOrigins } from './site-origins.ts';
import { createRuntime } from './runtime.ts';
import type { RequestTrace, Runtime, RuntimeOptions, TestPlan } from './runtime.ts';
import { createJsonLogger } from './logging.ts';
import { createObserverSink, renderPrometheus } from './observability.ts';
import type { MetricsSnapshot, Observer, ObserverSink, RecordContext } from './observability.ts';
import { assert, describeError, HttpError } from './errors.ts';
import { functionFailure } from './trusted-functions.ts';
import { writeResponse, writeError } from './http-response.ts';
import type { HandlerResult } from './http-response.ts';
import { compileTrustedProxies, loopbackHostCheck, resolveClient } from './client-address.ts';

export interface ServerOptions extends Omit<RuntimeOptions, 'observers' | 'acceptedExtensionPin'> {
  /** `urlcode dev` only: on a reload, accept an extension registration still pinned to the revision this server
   * started from (checked strictly at startup) for the edited project, and log `extension_pin_followed`. The first
   * runtime and every other check are unchanged; `serve` and every other command leave it off (RIM-EXT-PIN-001). */
  followExtensionPinOnReload?: boolean | undefined;
  project?: string | undefined; host?: string | undefined; port?: number | undefined; watch?: boolean | undefined;
  maxBodyBytes?: number | undefined; maxInFlightRequests?: number | undefined; maxInFlightHealthRequests?: number | undefined;
  requestLog?: string | undefined; trustRequestId?: boolean | undefined;
  trustedProxies?: string | string[] | undefined; observers?: Observer[] | undefined; metrics?: boolean | undefined; metricsIntervalMs?: number | undefined;
  /** Expose build version and route count on `/_urlcode/health`. Off by default so an
   * unauthenticated probe does not disclose deployment details; defaults to `metrics`
   * so enabling the (also unauthenticated-by-default) metrics exposition keeps its
   * existing level of disclosure. */
  healthDetails?: boolean | undefined;
  /** Milliseconds `close()` waits, with the listener still open and `/_urlcode/ready`
   * already reporting unhealthy, before it stops accepting connections. Gives a load
   * balancer time to notice the readiness change and stop routing new traffic here.
   * `/_urlcode/health` (liveness) stays healthy during this window. 0 disables the delay. */
  readinessDrainMs?: number | undefined;
  /** Milliseconds `close()` gives in-flight HTTP connections to finish once it stops
   * accepting new ones, before forcing them closed. Keep this below the process
   * supervisor's stop grace period (Docker's `--stop-timeout`, Kubernetes'
   * `terminationGracePeriodSeconds`) combined with `readinessDrainMs`, or the process
   * can be SIGKILLed mid-drain. */
  closeTimeoutMs?: number | undefined;
  /** Milliseconds allowed to receive a request's headers before the socket is reset. */
  headersTimeoutMs?: number | undefined;
  /** Milliseconds allowed for an entire request (headers and body) before the socket is reset. */
  requestTimeoutMs?: number | undefined;
  /** Milliseconds an idle keep-alive connection is held open for reuse. */
  keepAliveTimeoutMs?: number | undefined;
  /** Test helper. Directory the project may use for its own files, offered as the `URLCODE_DATA_DIR`
   * environment value (a route reads it through a declared `env` binding). Created if absent and
   * never deleted by `close()`, so a later server started on the same directory sees the same data. */
  dataDir?: string | undefined;
  /** Test helper. Create a fresh empty data directory, offer it as `URLCODE_DATA_DIR`, and remove it on `close()`. Exclusive with `dataDir`. */
  isolateData?: boolean | undefined;
  /** Write operator-side diagnostics to `diagnostics`: the route, source file, export and
   * stack behind a trusted function's generic 502/504, and the validation message of a
   * rejected reload. `urlcode dev` turns it on and `urlcode serve --debug-errors` opts in.
   * It never changes a response, and nothing it writes reaches the event log or observers. */
  debugErrors?: boolean | undefined;
  /** Where `debugErrors` output goes, one JSON line per call. Defaults to stderr. */
  diagnostics?: ((line: string) => void) | undefined;
}
export interface Server {
  server: http.Server; reload(): Promise<boolean>; address: AddressInfo; root: string; testPlan(): TestPlan;
  metrics(): MetricsSnapshot;
  readonly observers: { name: string; version: string }[]; origin: string; close(): Promise<void>;
}

const excluded = new Set(['node_modules', '.git', 'coverage', 'dist', '.urlcode']);
async function fingerprint(root: string, local: boolean, assets: string[] = []): Promise<string> {
  const hash = createHash('sha256'); let count = 0;
  async function walk(dir: string, depth = 0) {
    if (depth > 20) throw new Error('Project watch depth exceeded');
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || (entry.name.startsWith('.') && !(local && entry.name === '.env.local'))) continue;
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.isFile() && (/\.(?:yaml|yml|mjs|js|json)$/.test(entry.name) || entry.name === '.env.local')) {
        if (++count > 10000) throw new Error('Project watch file limit exceeded');
        const info=await lstat(file);
        hash.update(file+':'+info.size+':'+info.mtimeMs+':'+info.ctimeMs);
      }
    }
  }
  await walk(root);
  async function assetWalk(file: string, depth = 0) {
    if (++count > 20000 || depth > 20) throw new Error('Asset watch limit exceeded');
    let stat; try { stat = await lstat(file); } catch { hash.update(file + ':missing'); return; }
    hash.update(file + ':' + stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs);
    if (stat.isDirectory()) for (const name of (await readdir(file)).sort()) await assetWalk(join(file,name),depth+1);
  }
  for (const file of assets) await assetWalk(file);
  return hash.digest('hex');
}
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  if (req.headers['content-length'] && Number(req.headers['content-length']) > limit) throw new HttpError(413, 'Request body too large');
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = (cause: Error) => { cleanup(); reject(cause); };
    const aborted = () => error(new HttpError(400, 'Request aborted'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { req.pause(); error(new HttpError(413, 'Request body too large')); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data',data); req.once('end',end); req.once('error',error); req.once('aborted',aborted);
  });
}
const safeRequestId = /^[A-Za-z0-9_.:-]{1,128}$/;
// Node 22.13.0-22.14.x throws ERR_HTTP_CONTENT_LENGTH_MISMATCH from a
// byte-for-byte-correct `res.end()` whenever `strictContentLength` is set —
// an upstream Node bug (reproduced with a minimal server outside this
// codebase on 22.12.0/22.13.0/22.14.0; absent on 22.15.0, 22.16.0, 22.18.0,
// 24 and 26 — see urlcode#645) that turns this runtime's own
// defense-in-depth self-check into a guaranteed crash on exactly the
// documented package floor (`engines`: `>=22.13.0`). Node's own enforcement
// is skipped only on that narrow, known-broken range; this runtime's
// Content-Length is still always the measured byte length of the body it
// sends (http-response.ts), so a response is no less correct here — only
// Node's redundant second check of that same fact is turned off.
export function contentLengthEnforcementIsSafe(version = process.version): boolean {
  const match = /^v(\d+)\.(\d+)\./.exec(version);
  if (!match) return true;
  const [, majorText, minorText] = match;
  const major = Number(majorText), minor = Number(minorText);
  return !(major === 22 && minor < 15);
}
const enforceContentLength = contentLengthEnforcementIsSafe();
// A server must accept absolute-form targets (RFC 9112 §3.2.2). The scheme
// and authority are removed textually, never re-encoded, so the path keeps
// the exact bytes the runtime's encoding checks inspect.
function originForm(target: string): string {
  const match = /^https?:\/\/[^/?#]*(.*)$/i.exec(target);
  const rest = match?.[1];
  if (rest === undefined) return target;
  return rest === '' || rest.startsWith('?') ? '/' + rest : rest;
}
/** Starts the server. `port: 0` picks a free port, so this is also the in-process helper for tests:
 * `startServer({ project, port: 0, local: true, isolateData: true })`. */
export async function startServer(options: ServerOptions = {}): Promise<Server> {
  const { dataDir, isolateData, ...rest } = options;
  if (dataDir === undefined && !isolateData) return startServerCore(rest);
  assert(dataDir === undefined || !isolateData, 'Use dataDir or isolateData, not both');
  assert(dataDir === undefined || (typeof dataDir === 'string' && dataDir !== '' && !dataDir.includes('\0')), 'Data directory must be a path');
  const owned = dataDir === undefined;
  const dir = owned ? await mkdtemp(join(tmpdir(), 'urlcode-data-')) : resolvePath(dataDir);
  try {
    if (!owned) await mkdir(dir, { recursive: true });
    const app = await startServerCore({ ...rest, environment: { ...(rest.environment ?? process.env), URLCODE_DATA_DIR: dir }, grantDataDir: true });
    if (!owned) return app;
    return { ...app, close: async () => { try { await app.close(); } finally { await rm(dir, { recursive: true, force: true }); } } };
  } catch (error) { if (owned) await rm(dir, { recursive: true, force: true }); throw error; }
}
async function startServerCore({ project = '.', host = '127.0.0.1', port = 3000, watch = false,
  local = false, log = createJsonLogger(),
  maxBodyBytes = 1048576, maxInFlightRequests = 64, maxInFlightHealthRequests = 16,
  requestLog = 'minimal', trustRequestId = false, origin, trustedProxies = [],
  observers = [], metrics = false, metricsIntervalMs = 0, healthDetails = metrics,
  readinessDrainMs = 0, closeTimeoutMs = 10000,
  headersTimeoutMs = 10000, requestTimeoutMs = 15000, keepAliveTimeoutMs = 5000,
  debugErrors = false, diagnostics = (line: string) => { process.stderr.write(line); },
  followExtensionPinOnReload = false,
  ...runtimeOptions }: ServerOptions = {}): Promise<Server> {
  // Which peers may set X-Forwarded-For. Empty means the socket peer is the
  // client for every policy; a forwarded header from anyone else is ignored.
  const proxies = compileTrustedProxies(trustedProxies);
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  assert(Number.isInteger(maxInFlightRequests) && maxInFlightRequests >= 1 && maxInFlightRequests <= 1024, 'In-flight request limit must be 1–1024');
  assert(Number.isInteger(maxInFlightHealthRequests) && maxInFlightHealthRequests >= 1 && maxInFlightHealthRequests <= 1024, 'Health admission limit must be 1–1024');
  assert(['minimal','detailed'].includes(requestLog), 'Request log detail must be minimal or detailed');
  assert(typeof trustRequestId === 'boolean', 'Request ID trust must be a boolean');
  assert(typeof metrics === 'boolean', 'Metrics exposition must be a boolean');
  assert(metricsIntervalMs === 0 || (Number.isInteger(metricsIntervalMs) && metricsIntervalMs >= 1000 && metricsIntervalMs <= 3600000), 'Metrics interval must be 0 or 1000–3600000 ms');
  assert(typeof healthDetails === 'boolean', 'Health details exposition must be a boolean');
  assert(typeof followExtensionPinOnReload === 'boolean', 'Extension pin following must be a boolean');
  // Only reload() below derives it, from this server's own first runtime; a caller cannot hand one in.
  assert(!Object.hasOwn(runtimeOptions, 'acceptedExtensionPin'), 'acceptedExtensionPin is set only by the dev server reload');
  assert(Number.isInteger(readinessDrainMs) && readinessDrainMs >= 0 && readinessDrainMs <= 300000, 'Readiness drain delay must be 0–300000 ms');
  assert(Number.isInteger(closeTimeoutMs) && closeTimeoutMs >= 0 && closeTimeoutMs <= 300000, 'Close timeout must be 0–300000 ms');
  assert(Number.isInteger(headersTimeoutMs) && headersTimeoutMs >= 1000 && headersTimeoutMs <= 300000, 'Headers timeout must be 1000–300000 ms');
  assert(Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 1000 && requestTimeoutMs <= 300000, 'Request timeout must be 1000–300000 ms');
  assert(Number.isInteger(keepAliveTimeoutMs) && keepAliveTimeoutMs >= 0 && keepAliveTimeoutMs <= 300000, 'Keep-alive timeout must be 0–300000 ms');
  if (origin) {
    let u: URL;
    try { u = new URL(origin); } catch { assert(false, 'Invalid public origin'); }
    assert(['http:', 'https:'].includes(u.protocol) && u.origin === origin, 'Origin must be HTTP(S) without path or credentials');
  }
  // The JSON logger stays the default sink; observers see the same records
  // after it, in array order. Counters are derived from what passes through.
  const sink: ObserverSink = createObserverSink(observers, log);
  const counters = sink.metrics;
  const emit = (event: Record<string, unknown>, context?: RecordContext): void => { try { sink(event, context); } catch { /* Logging cannot fail requests. */ } };
  // Deliberately a separate channel from `emit`: these records carry source
  // paths, thrown messages and stacks, which the event log and observers
  // promise never to contain (docs/OBSERVABILITY.md).
  const diagnose = (record: Record<string, unknown>): void => { if (debugErrors) try { diagnostics(JSON.stringify(record) + '\n'); } catch { /* Diagnostics cannot fail requests. */ } };
  let current: Runtime = await createRuntime(project, { local, log: emit, origin, ...runtimeOptions });
  // The revision the first runtime passed the strict extension pin check at; a dev reload may carry that pin forward.
  const acceptedExtensionPin = followExtensionPinOnReload ? { from: current.revision } : undefined;
  // `draining` flips /_urlcode/ready unhealthy ahead of `shuttingDown`, which stops
  // serving entirely; the gap between them is the pre-close readiness delay.
  let shuttingDown = false, draining = false, reloading = false, watching = false, interval: NodeJS.Timeout | undefined, lastFingerprint: string | undefined, inFlight = 0, healthInFlight = 0;
  const retired = new Set<Promise<void>>();
  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: headersTimeoutMs, requestTimeout: requestTimeoutMs, keepAliveTimeout: keepAliveTimeoutMs }, async (req, res) => {
    const started = performance.now();
    const url = req.url ?? '', method = req.method ?? 'GET';
    // Upstream correlation is opt-in: an untrusted client must not choose the ID
    // that ties together this deployment's operational records.
    let inbound: string | undefined;
    if (trustRequestId) {
      const values: string[] = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === 'x-request-id') values.push(req.rawHeaders[i + 1] ?? '');
      const only = values[0];
      if (values.length === 1 && only !== undefined && safeRequestId.test(only)) inbound = only;
    }
    const requestId = inbound || randomUUID();
    const trace: RequestTrace = {};
    let status = 500;
    res.on('error', () => {});
    req.on('error', () => {});
    try {
      if (shuttingDown) throw new HttpError(503, 'Runtime shutting down');
      // DNS-rebinding defence for a loopback bind: refused before probes or routing.
      if (hostAdmitted && !hostAdmitted(req.rawHeaders, url)) throw new HttpError(421, 'Misdirected request');
      let result: HandlerResult;
      if (url === '/_urlcode/health' || url === '/_urlcode/ready' || (metrics && url === '/_urlcode/metrics')) {
        // Probes keep their own budget so they stay answerable while the
        // application is saturated, without being an unmetered amplifier.
        // Metrics exposition, when enabled, shares that budget and bind host.
        trace.route = url; trace.probe = true;
        if (healthInFlight >= maxInFlightHealthRequests) { counters.shed('health'); throw new HttpError(503, 'Health probe capacity unavailable'); }
        healthInFlight++; counters.inFlight('health', 1);
        let releasedProbe = false;
        const releaseProbe = () => { if (!releasedProbe) { releasedProbe = true; healthInFlight--; counters.inFlight('health', -1); } };
        res.once('finish', releaseProbe); res.once('close', releaseProbe);
        if (!['GET','HEAD'].includes(method)) result = { status: 405, headers: [['allow','GET, HEAD']], body: Buffer.alloc(0) };
        else if (url === '/_urlcode/metrics') result = { status: 200, headers: [['content-type','text/plain; version=0.0.4; charset=utf-8'],['cache-control','no-store']], body: Buffer.from(renderPrometheus(snapshot())) };
        else {
          // Liveness (/_urlcode/health) stays healthy while draining, so a supervisor does
          // not restart a process that is deliberately finishing in-flight work; readiness
          // (/_urlcode/ready) reflects the drain so a load balancer stops routing here.
          const ready = url === '/_urlcode/health' ? true : (!draining && current.healthy);
          const body: Record<string, unknown> = { status: ready ? 'ok' : 'degraded' };
          if (healthDetails) { body.version = current.version; body.routes = current.count; }
          result = { status: ready ? 200 : 503, headers: [['content-type','application/json']], body: Buffer.from(JSON.stringify(body)) };
        }
        req.resume();
      } else {
        if (inFlight >= maxInFlightRequests) { counters.shed('requests'); throw new HttpError(503, 'HTTP request capacity unavailable'); }
        inFlight++; counters.inFlight('requests', 1);
        // Keep admission until the response finishes or the peer disconnects.
        let released = false;
        const release = () => { if (!released) { released = true; inFlight--; counters.inFlight('requests', -1); } };
        res.once('finish', release); res.once('close', release);
        const headers = new Headers(), headerCounts: Record<string, number> = Object.create(null) as Record<string, number>;
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const key = (req.rawHeaders[i] ?? '').toLowerCase();
          headers.append(key, req.rawHeaders[i + 1] ?? ''); headerCounts[key] = (headerCounts[key] || 0) + 1;
        }
        const target = originForm(url);
        const body = await readBody(req, Math.min(maxBodyBytes, current.requestLimit(target) ?? maxBodyBytes));
        result = await current.handle({ target, method, headers, headerCounts, body, trace, requestId,
          origin: publicOrigin(), client: resolveClient(req.socket.remoteAddress, headerCounts['x-forwarded-for'] === 1 ? headers.get('x-forwarded-for') ?? undefined : undefined, proxies) });
      }
      status = writeResponse(res, result, { requestId, method, enforceContentLength });
    } catch (error) {
      status = writeError(res, error, { requestId, method, enforceContentLength, headers: current.errorHeaders(error, publicOrigin()) });
      if (debugErrors) {
        const failure = functionFailure(error);
        if (failure) diagnose({ event:'function_error', requestId, status, route: trace.route ?? null,
          ...(failure.source === undefined ? {} : { source: displayPath(failure.source), export: failure.export }), message: failure.message, ...(failure.stack === undefined ? {} : { stack: failure.stack }) });
      }
    } finally {
      // No request URL, query, headers, body, bindings or thrown operator errors.
      // Detailed adds the method and the matched route pattern: both come from the
      // reviewed configuration, never from request-supplied path or query text.
      // Counters always see the matched pattern and whether this was a probe;
      // observers see exactly the record the logger does.
      emit({ event: 'request', requestId, status, durationMs: Math.round((performance.now() - started) * 100) / 100,
        ...(requestLog === 'detailed' ? { method, route: trace.route ?? null } : {}) }, { ...(trace.probe || trace.route === undefined ? {} : { route: trace.route }), probe: trace.probe === true });
    }
  });
  const publicOrigin = () => origin || `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
  const displayPath = (source: string): string => { const rel = relativePath(current.root, source); return rel && !rel.startsWith('..') ? rel.split(pathSep).join('/') : source; };
  // Counters live with the server, so a reload does not reset them; the slot
  // gauges belong to whichever runtime is serving now.
  const snapshot = (): MetricsSnapshot => { const { healthy, slots } = current.workers; const out = counters.snapshot(); out.functionWorkers.healthySlots = healthy; out.functionWorkers.slots = slots; return out; };
  let metricsTimer: NodeJS.Timeout | undefined;
  if (metricsIntervalMs) { metricsTimer = setInterval(() => sink.publish(snapshot()), metricsIntervalMs); metricsTimer.unref(); }
  server.setTimeout(requestTimeoutMs, socket => socket.destroy());
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = 1024;
  server.on('clientError', (error, socket) => {
    // Header fields past the parser's budget are 431 (RFC 6585 §5); every
    // other parse failure is a malformed message, 400.
    const status = 'code' in error && error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port,host, () => { server.off('error',reject); resolve(); }); });
  } catch (error) { await current.close(); throw error; }
  const listening = server.address();
  assert(listening !== null && typeof listening === 'object', 'Server has no address');
  const address: AddressInfo = listening;
  // Like `address`, bound before any request can arrive; undefined (no check) for a non-loopback bind.
  // Alias origins were validated by createRuntime above; each names an authority the site is served under.
  const hostAdmitted = loopbackHostCheck(address, siteOrigins(origin, runtimeOptions.aliasOrigins));
  async function reload(): Promise<boolean> {
    if (shuttingDown || reloading) return false;
    reloading = true;
    try {
      const next = await createRuntime(project, { local, log: emit, origin, ...runtimeOptions, ...(acceptedExtensionPin ? { acceptedExtensionPin } : {}) });
      if (shuttingDown) { await next.close(); return false; }
      const old = current; current = next;
      const cleanup = old.close(); retired.add(cleanup); void cleanup.finally(() => retired.delete(cleanup));
      emit({ event: 'reload', status: 'ok', version: current.version, routes: current.count });
      return true;
    } catch (error) {
      emit({ event: 'reload', status: 'rejected' });
      // The same text `urlcode validate` prints for this project state.
      diagnose({ event: 'reload_rejected', message: describeError(error), serving: current.version });
      return false;
    }
    finally { reloading = false; }
  }
  if (watch) {
    try { lastFingerprint = await fingerprint(current.root, local, current.assetWatch); }
    catch { await new Promise<void>(resolve => server.close(() => resolve())); await current.close(); throw new Error('Unable to watch project'); }
    interval = setInterval(async () => {
      if (reloading || shuttingDown || watching) return;
      watching = true;
      try {
        const next = await fingerprint(current.root, local, current.assetWatch);
        if (next !== lastFingerprint) { lastFingerprint = next; await reload(); }
      } catch { emit({ event: 'watch', status: 'failed' }); }
      finally { watching = false; }
    }, 500);
    interval.unref();
  }
  return {
    server, reload, address, root: current.root, testPlan: () => current.testPlan(),
    metrics: snapshot,
    get observers() { return observers.map(observer => ({ name: observer.name, version: observer.version })); },
    // What a request sees as its own origin: behind a tunnel or proxy this is
    // the operator's --origin, never a forwarded header.
    origin: publicOrigin(),
    async close() {
      if (!draining) {
        draining = true;
        if (readinessDrainMs > 0) await new Promise<void>(resolve => setTimeout(resolve, readinessDrainMs));
      }
      shuttingDown = true; clearInterval(interval); clearInterval(metricsTimer);
      const deadline = setTimeout(() => server.closeAllConnections(), closeTimeoutMs);
      deadline.unref();
      await new Promise<void>(resolve => server.close(() => resolve()));
      clearTimeout(deadline);
      while (reloading) await new Promise(resolve => setTimeout(resolve,10));
      await current.close(); await Promise.all(retired);
      // A final snapshot, then observers release in reverse order.
      sink.publish(snapshot());
      await sink.close();
    },
  };
}
