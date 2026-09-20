import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { createRuntime } from './runtime.ts';
import type { RequestTrace, Runtime, RuntimeOptions, TestPlan } from './runtime.ts';
import { createJsonLogger } from './logging.ts';
import { createObserverSink, renderPrometheus } from './observability.ts';
import type { MetricsSnapshot, Observer, ObserverSink, RecordContext } from './observability.ts';
import { assert, HttpError } from './errors.ts';
import { writeResponse, writeError } from './http-response.ts';
import type { HandlerResult } from './http-response.ts';
import { compileTrustedProxies, resolveClient } from './client-address.ts';

export interface ServerOptions extends Omit<RuntimeOptions, 'observers'> {
  project?: string | undefined; host?: string | undefined; port?: number | undefined; watch?: boolean | undefined;
  maxBodyBytes?: number | undefined; maxInFlightRequests?: number | undefined; maxInFlightHealthRequests?: number | undefined;
  requestLog?: string | undefined; trustRequestId?: boolean | undefined;
  trustedProxies?: string | string[] | undefined; observers?: Observer[] | undefined; metrics?: boolean | undefined; metricsIntervalMs?: number | undefined;
  /** Test helper. Directory the project may use for its own files, offered as the `URLCODE_DATA_DIR`
   * environment value (a route reads it through a declared `env` binding). Created if absent and
   * never deleted by `close()`, so a later server started on the same directory sees the same data. */
  dataDir?: string | undefined;
  /** Test helper. Create a fresh empty data directory, offer it as `URLCODE_DATA_DIR`, and remove it on `close()`. Exclusive with `dataDir`. */
  isolateData?: boolean | undefined;
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
  observers = [], metrics = false, metricsIntervalMs = 0, ...runtimeOptions }: ServerOptions = {}): Promise<Server> {
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
  let current: Runtime = await createRuntime(project, { local, log: emit, origin, ...runtimeOptions });
  let shuttingDown = false, reloading = false, watching = false, interval: NodeJS.Timeout | undefined, lastFingerprint: string | undefined, inFlight = 0, healthInFlight = 0;
  const retired = new Set<Promise<void>>();
  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 }, async (req, res) => {
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
          const ready = url === '/_urlcode/health' || current.healthy;
          result = { status: ready ? 200 : 503, headers: [['content-type','application/json']], body: Buffer.from(JSON.stringify({ status: ready ? 'ok' : 'degraded', version: current.version, routes: current.count })) };
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
        result = await current.handle({ target, method, headers, headerCounts, body, trace,
          origin: publicOrigin(), client: resolveClient(req.socket.remoteAddress, headerCounts['x-forwarded-for'] === 1 ? headers.get('x-forwarded-for') ?? undefined : undefined, proxies) });
      }
      status = writeResponse(res, result, { requestId, method });
    } catch (error) {
      status = writeError(res, error, { requestId, method, headers: current.errorHeaders(error, publicOrigin()) });
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
  // Counters live with the server, so a reload does not reset them; the slot
  // gauges belong to whichever runtime is serving now.
  const snapshot = (): MetricsSnapshot => { const { healthy, slots } = current.workers; const out = counters.snapshot(); out.functionWorkers.healthySlots = healthy; out.functionWorkers.slots = slots; return out; };
  let metricsTimer: NodeJS.Timeout | undefined;
  if (metricsIntervalMs) { metricsTimer = setInterval(() => sink.publish(snapshot()), metricsIntervalMs); metricsTimer.unref(); }
  server.setTimeout(15000, socket => socket.destroy());
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
  async function reload(): Promise<boolean> {
    if (shuttingDown || reloading) return false;
    reloading = true;
    try {
      const next = await createRuntime(project, { local, log: emit, origin, ...runtimeOptions });
      if (shuttingDown) { await next.close(); return false; }
      const old = current; current = next;
      const cleanup = old.close(); retired.add(cleanup); void cleanup.finally(() => retired.delete(cleanup));
      emit({ event: 'reload', status: 'ok', version: current.version, routes: current.count });
      return true;
    } catch { emit({ event: 'reload', status: 'rejected' }); return false; }
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
      shuttingDown = true; clearInterval(interval); clearInterval(metricsTimer);
      const deadline = setTimeout(() => server.closeAllConnections(), 10000);
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
