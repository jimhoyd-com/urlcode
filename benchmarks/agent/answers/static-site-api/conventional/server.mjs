import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { version, pages } from './lib/site.mjs';

const root = resolve(import.meta.dirname, 'public'), assets = join(root, 'assets');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body = '', headers = {}, head = false) {
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff', ...headers });
  res.end(head ? '' : body);
}
async function file(res, path, headers, head) {
  let bytes;
  try { if (!(await stat(path)).isFile()) throw new Error('not a file'); bytes = await readFile(path); } catch { return send(res, 404, 'Not found\n', { 'content-type': 'text/plain; charset=utf-8' }); }
  const extension = path.slice(path.lastIndexOf('.'));
  return send(res, 200, bytes, { 'content-type': types[extension] || 'application/octet-stream', ...headers }, head);
}

export async function handle(req, res) {
  const raw = req.url.split('?')[0];
  if (/%2f|%5c|\\/i.test(raw) || raw.split('/').some(segment => segment === '.' || segment === '..')) return send(res, 400, 'Bad request\n', { 'content-type': 'text/plain; charset=utf-8' });
  let pathname;
  try { pathname = decodeURIComponent(raw); } catch { return send(res, 400, 'Bad request\n', { 'content-type': 'text/plain; charset=utf-8' }); }
  const head = req.method === 'HEAD';
  const known = pathname in pages || pathname.startsWith('/assets/') || pathname === '/api/version';
  if (!known) return send(res, 404, 'Not found\n', { 'content-type': 'text/plain; charset=utf-8' });
  if (req.method !== 'GET' && !head) return send(res, 405, '', { allow: 'GET, HEAD' });
  if (pathname === '/api/version') return send(res, 200, JSON.stringify(version), { 'content-type': 'application/json' }, head);
  if (pathname in pages) return file(res, join(root, pages[pathname]), { 'cache-control': 'no-cache' }, head);
  const target = normalize(join(assets, pathname.slice('/assets/'.length)));
  if (!target.startsWith(assets + sep)) return send(res, 404, 'Not found\n', { 'content-type': 'text/plain; charset=utf-8' });
  return file(res, target, { 'cache-control': 'public, max-age=3600' }, head);
}

const server = createServer((req, res) => { handle(req, res).catch(() => { res.writeHead(500); res.end(); }); });
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
