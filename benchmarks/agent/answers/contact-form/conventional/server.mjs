import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSpam, validate } from './lib/rules.mjs';

const page = readFile(join(import.meta.dirname, 'public', 'contact.html'));

function send(res, status, body = '', headers = {}, head = false) {
  res.writeHead(status, { 'content-length': Buffer.byteLength(body), ...headers });
  res.end(head ? '' : body);
}
const json = (res, status, value) => send(res, status, JSON.stringify(value), { 'content-type': 'application/json', 'cache-control': 'no-store' });
function readJson(req, limit = 16384) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('malformed'), { status: 400 })); } });
    req.on('error', reject);
  });
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost'), head = req.method === 'HEAD';
  if (url.pathname !== '/contact') return json(res, 404, { error: 'not found' });
  if (req.method === 'GET' || head) return send(res, 200, await page, { 'content-type': 'text/html; charset=utf-8' }, head);
  if (req.method !== 'POST') return send(res, 405, '', { allow: 'GET, HEAD, POST' });
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'expected application/json' });
  let input;
  try { input = await readJson(req); } catch (error) { return json(res, error.status || 500, { error: error.message }); }
  if (isSpam(input)) return json(res, 200, { received: true });
  const errors = validate(input);
  return errors.length ? json(res, 422, { errors }) : json(res, 201, { received: true });
}

const server = createServer((req, res) => { handle(req, res).catch(() => { res.writeHead(500); res.end(); }); });
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
