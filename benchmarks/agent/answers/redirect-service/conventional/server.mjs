import { createServer } from 'node:http';
import { redirects, productTarget } from './lib/links.mjs';

const ID = /^[A-Za-z0-9-]{1,32}$/;

function send(res, status, headers = {}, body = '') {
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

export function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const head = req.method === 'HEAD';
  if (req.method !== 'GET' && !head) return send(res, 405, { allow: 'GET, HEAD' });
  const fixed = redirects[url.pathname];
  if (fixed) return send(res, fixed.status, { location: fixed.url });
  if (url.pathname === '/health') return send(res, 200, { 'content-type': 'application/json' }, head ? '' : JSON.stringify({ ok: true }));
  const product = url.pathname.match(/^\/product\/([^/]*)$/);
  if (product) {
    let id;
    try { id = decodeURIComponent(product[1]); } catch { return send(res, 400); }
    if (!ID.test(id)) return send(res, 400);
    return send(res, 302, { location: productTarget(id, url.searchParams.get('ref')) });
  }
  return send(res, 404);
}

const server = createServer(handle);
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`listening on ${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
