import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { sources, acknowledge } from './lib/events.mjs';

const TOKEN = process.env.WEBHOOK_TOKEN || '';
function tokenOk(header) {
  const given = Buffer.from(String(header || '')), expected = Buffer.from(TOKEN);
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}
function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
function readJson(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('malformed'), { status: 400 })); } });
    req.on('error', reject);
  });
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const hook = url.pathname.match(/^\/hooks\/([^/]+)$/);
  if (hook) {
    const source = decodeURIComponent(hook[1]);
    if (!sources.has(source)) return send(res, 404, { error: 'unknown source' });
    if (req.method !== 'POST') return send(res, 405, undefined, { allow: 'POST' });
    if (!tokenOk(req.headers['x-webhook-token'])) return send(res, 401, { error: 'unauthorized' });
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
    let body;
    try { body = await readJson(req); } catch (error) { return send(res, error.status || 500, { error: error.message }); }
    const reply = acknowledge(source, body);
    return send(res, reply.status, reply.body);
  }
  if (url.pathname === '/health') return ['GET', 'HEAD'].includes(req.method) ? send(res, 200, { ok: true }) : send(res, 405, undefined, { allow: 'GET, HEAD' });
  return send(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => { handle(req, res).catch(() => { res.writeHead(500); res.end(); }); });
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
