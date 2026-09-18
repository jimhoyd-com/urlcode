import { createServer } from 'node:http';
import { Notes, validate } from './lib/notes.mjs';

function send(res, status, body, headers = {}, head = false) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...(text ? { 'content-type': 'application/json' } : {}), 'content-length': Buffer.byteLength(text), ...headers });
  res.end(head ? '' : text);
}
function readJson(req, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('malformed'), { status: 400 })); } });
    req.on('error', reject);
  });
}
async function body(req, res) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) { send(res, 415, { error: 'expected application/json' }); return undefined; }
  let input;
  try { input = await readJson(req); } catch (error) { send(res, error.status || 500, { error: error.message }); return undefined; }
  const errors = validate(input);
  if (errors.length) { send(res, 422, { errors }); return undefined; }
  return { title: input.title, body: input.body };
}

export function createHandler(store = new Notes()) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost'), head = req.method === 'HEAD', method = head ? 'GET' : req.method;
    if (url.pathname === '/notes') {
      if (method === 'GET') return send(res, 200, store.list(), {}, head);
      if (method !== 'POST') return send(res, 405, undefined, { allow: 'GET, HEAD, POST' });
      const note = await body(req, res);
      return note && send(res, 201, store.create(note));
    }
    const match = url.pathname.match(/^\/notes\/([^/]+)$/);
    if (!match) return send(res, 404, { error: 'not found' });
    if (!['GET', 'PUT', 'DELETE'].includes(method)) return send(res, 405, undefined, { allow: 'GET, HEAD, PUT, DELETE' });
    const raw = decodeURIComponent(match[1]);
    if (!/^[1-9][0-9]*$/.test(raw)) return send(res, 400, { error: 'invalid id' });
    const id = Number(raw);
    if (!store.get(id)) return send(res, 404, { error: 'not found' });
    if (method === 'GET') return send(res, 200, store.get(id), {}, head);
    if (method === 'DELETE') { store.remove(id); return send(res, 204); }
    const note = await body(req, res);
    return note && send(res, 200, store.replace(id, note));
  };
}

const handle = createHandler();
const server = createServer((req, res) => { handle(req, res).catch(() => { res.writeHead(500); res.end(); }); });
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
