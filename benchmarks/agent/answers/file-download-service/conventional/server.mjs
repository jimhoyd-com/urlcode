import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { downloads } from './lib/catalog.mjs';

const root = resolve(import.meta.dirname, 'files'), publicRoot = join(root, 'public');
const types = { '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };

function send(res, status, body = '', headers = {}, head = false) {
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff', ...headers });
  res.end(head ? '' : body);
}
const text = (res, status, message) => send(res, status, message + '\n', { 'content-type': 'text/plain; charset=utf-8' });

async function serve(req, res, path, headers, head) {
  let bytes;
  try { if (!(await stat(path)).isFile()) throw new Error('not a file'); bytes = await readFile(path); } catch { return text(res, 404, 'Not found'); }
  const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}"`;
  const base = { ...headers, etag, 'accept-ranges': 'bytes' };
  if (req.headers['if-none-match'] === etag) return send(res, 304, '', base, true);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && !head && (range[1] || range[2])) {
    const size = bytes.length;
    let start = range[1] ? Number(range[1]) : size - Number(range[2]), end = range[1] && range[2] ? Number(range[2]) : size - 1;
    if (range[1] && !range[2]) end = size - 1;
    if (start < 0) start = 0; if (end >= size) end = size - 1;
    if (start > end || start >= size) return send(res, 416, '', { ...base, 'content-range': `bytes */${size}` });
    return send(res, 206, bytes.subarray(start, end + 1), { ...base, 'content-range': `bytes ${start}-${end}/${size}` });
  }
  return send(res, 200, bytes, base, head);
}

export async function handle(req, res) {
  const raw = req.url.split('?')[0];
  if (/%2f|%5c|\\/i.test(raw) || raw.split('/').some(segment => segment === '.' || segment === '..')) return text(res, 400, 'Bad request');
  let pathname;
  try { pathname = decodeURIComponent(raw); } catch { return text(res, 400, 'Bad request'); }
  const head = req.method === 'HEAD', download = downloads[pathname], isPublic = pathname.startsWith('/public/');
  if (!download && !isPublic) return text(res, 404, 'Not found');
  if (req.method !== 'GET' && !head) return send(res, 405, '', { allow: 'GET, HEAD' });
  if (download) return serve(req, res, join(root, download.file), { 'content-type': download.type, 'content-disposition': `attachment; filename=${download.filename}`, 'cache-control': download.cache }, head);
  const target = normalize(join(publicRoot, pathname.slice('/public/'.length)));
  if (!target.startsWith(publicRoot + sep)) return text(res, 404, 'Not found');
  const extension = target.slice(target.lastIndexOf('.'));
  return serve(req, res, target, { 'content-type': types[extension] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' }, head);
}

const server = createServer((req, res) => { handle(req, res).catch(() => { res.writeHead(500); res.end(); }); });
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
