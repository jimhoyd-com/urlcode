import { createServer } from 'node:http';
import { categories, byCategory, byId } from './lib/catalog.mjs';

function send(res, status, body, headers = {}, head = false) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(head ? '' : text);
}

export function handle(req, res) {
  const url = new URL(req.url, 'http://localhost'), head = req.method === 'HEAD';
  const routes = [/^\/api\/products$/, /^\/api\/products\/([^/]+)$/, /^\/api\/health$/];
  const matched = routes.map(route => url.pathname.match(route));
  if (!matched.some(Boolean)) return send(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && !head) return send(res, 405, undefined, { allow: 'GET, HEAD' });
  if (matched[2]) return send(res, 200, { ok: true }, {}, head);
  if (matched[0]) {
    const category = url.searchParams.get('category');
    if (category !== null && !categories.has(category)) return send(res, 400, { error: 'unknown category' });
    return send(res, 200, byCategory(category), {}, head);
  }
  const raw = decodeURIComponent(matched[1][1]);
  if (!/^[1-9][0-9]*$/.test(raw)) return send(res, 400, { error: 'invalid id' });
  const product = byId(Number(raw));
  return product ? send(res, 200, product, {}, head) : send(res, 404, { error: 'not found' });
}

const server = createServer(handle);
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
