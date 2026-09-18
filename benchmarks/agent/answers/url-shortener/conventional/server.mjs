import { createServer } from 'node:http';
import { links, wellFormed, validate } from './lib/links.mjs';

function send(res, status, body, headers = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > 4096) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('malformed'), { status: 400 })); } });
    req.on('error', reject);
  });
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost'), method = req.method === 'HEAD' ? 'GET' : req.method;
  let match;
  if ((match = url.pathname.match(/^\/r\/([^/]+)$/))) {
    if (method !== 'GET') return send(res, 405, undefined, { allow: 'GET, HEAD' });
    const code = decodeURIComponent(match[1]);
    if (!wellFormed(code)) return send(res, 400, { error: 'invalid code' });
    if (!links.has(code)) return send(res, 404, { error: 'unknown link' });
    res.writeHead(302, { location: links.get(code) }); return res.end();
  }
  if ((match = url.pathname.match(/^\/api\/links\/([^/]+)$/))) {
    if (method !== 'GET') return send(res, 405, undefined, { allow: 'GET, HEAD' });
    const code = decodeURIComponent(match[1]);
    return links.has(code) ? send(res, 200, { code, url: links.get(code) }) : send(res, 404, { error: 'unknown link' });
  }
  if (url.pathname === '/api/links') {
    if (req.method !== 'POST') return send(res, 405, undefined, { allow: 'POST' });
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'expected application/json' });
    let body;
    try { body = await readJson(req); } catch (error) { return send(res, error.status || 500, { error: error.message }); }
    const { errors, record } = validate(body);
    return errors.length ? send(res, 422, { errors }) : send(res, 201, record);
  }
  if (url.pathname === '/health') return method === 'GET' ? send(res, 200, { ok: true }) : send(res, 405, undefined, { allow: 'GET, HEAD' });
  return send(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => { handle(req, res).catch(() => { res.writeHead(500); res.end(); }); });
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
