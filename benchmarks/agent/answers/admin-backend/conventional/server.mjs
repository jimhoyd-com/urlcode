import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { users, stats, disabled } from './lib/users.mjs';

const USER = process.env.ADMIN_USER || '', PASSWORD = process.env.ADMIN_PASSWORD || '';
const page = readFile(join(import.meta.dirname, 'public', 'admin.html'));

function same(given, expected) {
  const a = Buffer.from(String(given)), b = Buffer.from(expected);
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function authorized(header) {
  const value = String(header || '');
  if (!value.startsWith('Basic ')) return false;
  const decoded = Buffer.from(value.slice(6).trim(), 'base64').toString('utf8'), at = decoded.indexOf(':');
  const userOk = same(at < 0 ? '' : decoded.slice(0, at), USER), passwordOk = same(at < 0 ? '' : decoded.slice(at + 1), PASSWORD);
  return userOk && passwordOk;
}
function send(res, status, body = '', headers = {}, head = false) {
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
  res.end(head ? '' : body);
}
const json = (res, status, value, head = false) => send(res, status, JSON.stringify(value), { 'content-type': 'application/json' }, head);

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost'), head = req.method === 'HEAD', method = head ? 'GET' : req.method;
  if (!url.pathname.startsWith('/admin/')) return json(res, 404, { error: 'not found' });
  const disable = url.pathname.match(/^\/admin\/api\/users\/([^/]+)\/disable$/);
  const known = ['/admin/', '/admin/api/stats', '/admin/api/users'].includes(url.pathname) || disable;
  if (!known) return json(res, 404, { error: 'not found' });
  if (!authorized(req.headers.authorization)) return send(res, 401, 'Unauthorized\n', { 'www-authenticate': 'Basic realm="admin"', 'content-type': 'text/plain; charset=utf-8' });
  if (disable) {
    if (method !== 'POST') return send(res, 405, '', { allow: 'POST' });
    const raw = decodeURIComponent(disable[1]);
    if (!/^[1-9][0-9]*$/.test(raw)) return json(res, 400, { error: 'invalid id' });
    const user = disabled(Number(raw));
    return user ? json(res, 200, user) : json(res, 404, { error: 'not found' });
  }
  if (method !== 'GET') return send(res, 405, '', { allow: 'GET, HEAD' });
  if (url.pathname === '/admin/') return send(res, 200, await page, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, head);
  return json(res, 200, url.pathname === '/admin/api/stats' ? stats() : users, head);
}

const server = createServer((req, res) => { handle(req, res).catch(() => { res.writeHead(500); res.end(); }); });
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
