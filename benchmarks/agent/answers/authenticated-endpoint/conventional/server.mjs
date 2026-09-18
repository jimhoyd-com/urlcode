import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const TOKEN = process.env.API_TOKEN || '';
const account = { user: 'service-account', scopes: ['read'] };

function bearerOk(header) {
  const value = String(header || '');
  if (!value.startsWith('Bearer ')) return false;
  const given = Buffer.from(value.slice(7).trim()), expected = Buffer.from(TOKEN);
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}
function send(res, status, body, headers = {}, head = false) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(head ? '' : text);
}

export function handle(req, res) {
  const url = new URL(req.url, 'http://localhost'), head = req.method === 'HEAD';
  if (url.pathname !== '/api/public' && url.pathname !== '/api/me') return send(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && !head) return send(res, 405, undefined, { allow: 'GET, HEAD' });
  if (url.pathname === '/api/public') return send(res, 200, { service: 'demo', public: true }, {}, head);
  if (!bearerOk(req.headers.authorization)) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="demo"', 'cache-control': 'no-store' });
  return send(res, 200, account, { 'cache-control': 'no-store' }, head);
}

const server = createServer(handle);
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
