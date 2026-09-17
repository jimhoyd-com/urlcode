import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from './runtime.js';
import { createJsonLogger } from './logging.js';
import { createLinkObserver } from './link-events.js';
import { assert, HttpError } from './errors.js';

const excluded = new Set(['node_modules', '.git', 'coverage', 'dist', '.urlcode']);
async function fingerprint(root, local, assets = []) {
  const hash = createHash('sha256'); let count = 0;
  async function walk(dir, depth = 0) {
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
  async function assetWalk(file, depth = 0) {
    if (++count > 20000 || depth > 20) throw new Error('Asset watch limit exceeded');
    let stat; try { stat = await lstat(file); } catch { hash.update(file + ':missing'); return; }
    hash.update(file + ':' + stat.size + ':' + stat.mtimeMs + ':' + stat.ctimeMs);
    if (stat.isDirectory()) for (const name of (await readdir(file)).sort()) await assetWalk(join(file,name),depth+1);
  }
  for (const file of assets) await assetWalk(file);
  return hash.digest('hex');
}
async function readBody(req, limit) {
  if (req.headers['content-length'] && Number(req.headers['content-length']) > limit) throw new HttpError(413, 'Request body too large');
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); };
    const error = cause => { cleanup(); reject(cause); };
    const aborted = () => error(new HttpError(400, 'Request aborted'));
    const data = chunk => {
      size += chunk.length;
      if (size > limit) { req.pause(); error(new HttpError(413, 'Request body too large')); }
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data',data); req.once('end',end); req.once('error',error); req.once('aborted',aborted);
  });
}
const forbiddenHeaders = new Set(['connection','keep-alive','transfer-encoding','content-length','upgrade','trailer','proxy-authenticate','proxy-authorization','te']);
const safeRequestId = /^[A-Za-z0-9_.:-]{1,128}$/;
export async function startServer({ project = '.', host = '127.0.0.1', port = 3000, watch = false,
  local = false, log = createJsonLogger(),
  maxBodyBytes = 1048576, maxInFlightRequests = 64, maxInFlightHealthRequests = 16,
  requestLog = 'minimal', trustRequestId = false, origin, linkEvents, ...runtimeOptions } = {}) {
  assert(Number.isInteger(maxBodyBytes) && maxBodyBytes >= 1 && maxBodyBytes <= 16777216, 'Request limit must be 1–16777216 bytes');
  assert(Number.isInteger(maxInFlightRequests) && maxInFlightRequests >= 1 && maxInFlightRequests <= 1024, 'In-flight request limit must be 1–1024');
  assert(Number.isInteger(maxInFlightHealthRequests) && maxInFlightHealthRequests >= 1 && maxInFlightHealthRequests <= 1024, 'Health admission limit must be 1–1024');
  assert(['minimal','detailed'].includes(requestLog), 'Request log detail must be minimal or detailed');
  assert(typeof trustRequestId === 'boolean', 'Request ID trust must be a boolean');
  if (origin) {
    let u;
    try { u = new URL(origin); } catch { assert(false, 'Invalid public origin'); }
    assert(['http:', 'https:'].includes(u.protocol) && u.origin === origin, 'Origin must be HTTP(S) without path or credentials');
  }
  const emit = event => { try { log(event); } catch { /* Logging cannot fail requests. */ } };
  // Operator-supplied and explicitly enabled; route YAML cannot reach it and no
  // callback is ever loaded from the project. Undefined leaves it off.
  const observer = createLinkObserver(linkEvents, emit);
  let current = await createRuntime(project, { local, log: emit, ...runtimeOptions });
  let shuttingDown = false, reloading = false, watching = false, interval, lastFingerprint, inFlight = 0, healthInFlight = 0;
  const retired = new Set();
  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 15000, keepAliveTimeout: 5000 }, async (req, res) => {
    const started = performance.now();
    // Upstream correlation is opt-in: an untrusted client must not choose the ID
    // that ties together this deployment's operational records.
    let inbound;
    if (trustRequestId) {
      const values = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'x-request-id') values.push(req.rawHeaders[i + 1]);
      if (values.length === 1 && safeRequestId.test(values[0])) inbound = values[0];
    }
    const requestId = inbound || randomUUID();
    const trace = {};
    let status = 500;
    res.on('error', () => {});
    req.on('error', () => {});
    if (observer) {
      // Enqueued after the response is over, so an observer can neither delay a
      // redirect nor turn its own failure into one. A response that never
      // finished is reported as aborted rather than counted as a click.
      let observed = false;
      const settle = () => {
        if (observed || !trace.link) return;
        observed = true;
        observer.emit({ event: 'link_request', requestId, collection: trace.link.collection, route: trace.route ?? null,
          code: trace.link.code, method: req.method, status,
          outcome: trace.link.result === 'redirect' ? (res.writableFinished ? 'completed' : 'aborted') : trace.link.result,
          durationMs: Math.round((performance.now() - started) * 100) / 100 });
      };
      res.once('finish', settle); res.once('close', settle);
    }
    try {
      if (shuttingDown) throw new HttpError(503, 'Runtime shutting down');
      let result;
      if (req.url === '/_urlcode/health' || req.url === '/_urlcode/ready') {
        // Probes keep their own budget so they stay answerable while the
        // application is saturated, without being an unmetered amplifier.
        trace.route = req.url;
        if (healthInFlight >= maxInFlightHealthRequests) throw new HttpError(503, 'Health probe capacity unavailable');
        healthInFlight++;
        let releasedProbe = false;
        const releaseProbe = () => { if (!releasedProbe) { releasedProbe = true; healthInFlight--; } };
        res.once('finish', releaseProbe); res.once('close', releaseProbe);
        const ready = req.url === '/_urlcode/health' || current.healthy;
        result = ['GET','HEAD'].includes(req.method) ? { status: ready ? 200 : 503, headers: [['content-type','application/json']], body: Buffer.from(JSON.stringify({ status: ready ? 'ok' : 'degraded', version: current.version, routes: current.count })) } : { status: 405, headers: [['allow','GET, HEAD']], body: Buffer.alloc(0) };
        req.resume();
      } else {
        if (inFlight >= maxInFlightRequests) throw new HttpError(503, 'HTTP request capacity unavailable');
        inFlight++;
        // Keep admission until the response finishes or the peer disconnects.
        let released = false;
        const release = () => { if (!released) { released = true; inFlight--; } };
        res.once('finish', release); res.once('close', release);
        const headers = new Headers(), headerCounts = Object.create(null);
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const key = req.rawHeaders[i].toLowerCase();
          headers.append(key, req.rawHeaders[i + 1]); headerCounts[key] = (headerCounts[key] || 0) + 1;
        }
        const body = await readBody(req, Math.min(maxBodyBytes, current.requestLimit(req.url) ?? maxBodyBytes));
        result = await current.handle({ target: req.url, method: req.method, headers, headerCounts, body, trace,
          origin: publicOrigin() });
      }
      status = result.status;
      if (!Number.isInteger(status) || status < 200 || status > 599) throw new HttpError(502, 'Invalid function response');
      const cookies = [];
      for (const [key,value] of result.headers) {
        if (forbiddenHeaders.has(key.toLowerCase())) continue;
        http.validateHeaderName(key); http.validateHeaderValue(key,value);
        if (key.toLowerCase() === 'set-cookie') cookies.push(value);
        else res.setHeader(key,value);
      }
      if (result.contentLength !== undefined) res.setHeader('content-length', result.contentLength);
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.setHeader('x-request-id', requestId);
      res.setHeader('x-content-type-options', 'nosniff');
      if (!res.hasHeader('cache-control')) res.setHeader('cache-control', 'no-store');
      res.statusCode = status;
      res.end(req.method === 'HEAD' || status === 204 || status === 205 || status === 304 ? undefined : result.body);
    } catch (error) {
      status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent) {
        for (const key of res.getHeaderNames()) res.removeHeader(key);
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control':'no-store', 'x-request-id': requestId, 'x-content-type-options': 'nosniff', connection: 'close' });
        res.end(req.method === 'HEAD' ? undefined : `${error instanceof HttpError ? error.message : 'Internal server error'}\n`);
      } else res.destroy();
    } finally {
      // No request URL, query, headers, body, bindings or thrown operator errors.
      // Detailed adds the method and the matched route pattern: both come from the
      // reviewed configuration, never from request-supplied path or query text.
      emit({ event: 'request', requestId, status, durationMs: Math.round((performance.now() - started) * 100) / 100,
        ...(requestLog === 'detailed' ? { method: req.method, route: trace.route ?? null } : {}) });
    }
  });
  const publicOrigin = () => origin || `http://${host.includes(':') ? `[${host}]` : host}:${server.address().port}`;
  server.setTimeout(15000, socket => socket.destroy());
  server.maxRequestsPerSocket = 1000;
  server.maxConnections = 1024;
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port,host, () => { server.off('error',reject); resolve(); }); });
  } catch (error) { await current.close(); throw error; }
  async function reload() {
    if (shuttingDown || reloading) return false;
    reloading = true;
    try {
      const next = await createRuntime(project, { local, log: emit, ...runtimeOptions });
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
    catch { await new Promise(resolve => server.close(resolve)); await current.close(); throw new Error('Unable to watch project'); }
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
    server, reload, address: server.address(), root: current.root, testPlan: () => current.testPlan(),
    linkEventStats: () => observer?.stats(),
    // What a request sees as its own origin: behind a tunnel or proxy this is
    // the operator's --origin, never a forwarded header.
    origin: publicOrigin(),
    async close() {
      shuttingDown = true; clearInterval(interval);
      const deadline = setTimeout(() => server.closeAllConnections(), 10000);
      deadline.unref();
      await new Promise(resolve => server.close(resolve));
      clearTimeout(deadline);
      while (reloading) await new Promise(resolve => setTimeout(resolve,10));
      await current.close(); await Promise.all(retired);
      // Observers drain after the connections they describe are gone.
      if (observer) emit({ event: 'link_observer', status: 'closed', ...await observer.close() });
    },
  };
}
