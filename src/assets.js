import { lstat, readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import mime from 'mime-types';
import { create as disposition } from 'content-disposition';
import { assert, HttpError } from './errors.js';

// Asset bytes are immutable between successful reloads. No request opens a file.
const denied = /^(?:node_modules|urlcode\.ya?ml|package(?:-lock)?\.json|.*\.(?:pem|key|p12|pfx|env))$/i;
// The same rule the static walker applies: hidden and sensitive names are
// never published, so a sitemap built from a directory must skip them too.
export const publishableAssetName = name => !name.startsWith('.') && !denied.test(name);
function partsFor(value) {
  const parts = value.split('/');
  assert(parts.every(p => p && !p.startsWith('.') && !denied.test(p) && !/[\\:\u0000-\u001f\u007f]/u.test(p)), 'Unsafe asset path; use a dedicated public asset directory');
  return parts;
}
export async function compileAssets(root, routes) {
  const cache = new Map(), watch = [], digest = createHash('sha256'); let bytes = 0, entries = 0;
  async function checked(relative) {
    let file = root;
    for (const part of partsFor(relative)) {
      file = join(file,part);
      const stat = await lstat(file);
      assert(!stat.isSymbolicLink(), 'Asset symlinks are forbidden');
    }
    return file;
  }
  async function read(relative, config, download) {
    const file = await checked(relative);
    let saved = cache.get(file);
    if (!saved) {
      assert((await lstat(file)).isFile(), 'Assets must be regular files');
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      try {
        const stat = await handle.stat();
        assert(stat.isFile() && stat.nlink === 1, 'Assets must be regular files without hard links');
        assert(stat.size <= 16 * 1024 * 1024 && bytes + stat.size <= 64 * 1024 * 1024, 'Asset snapshot exceeds 16 MiB per file or 64 MiB total');
        // Read at most the inspected size; reject concurrent growth or replacement.
        const body = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < body.length) { const result = await handle.read(body,length,body.length-length,length); if (!result.bytesRead) break; length += result.bytesRead; }
        const after = await handle.stat();
        assert(length === stat.size && after.mtimeMs === stat.mtimeMs && after.ctimeMs === stat.ctimeMs, 'Asset changed during snapshot');
        saved = { body:body.subarray(0,length), modified:new Date(Math.floor(stat.mtimeMs/1000)*1000).toUTCString() };
        bytes += length; cache.set(file,saved);
      } finally { await handle.close(); }
    }
    const type = mime.contentType(config.contentType || mime.lookup(relative) || 'application/octet-stream');
    const filename = config.filename || basename(relative);
    assert(!/[/\\\u0000-\u001f\u007f]/u.test(filename), 'Download filename must be a safe basename');
    const attachment = download ? disposition(filename) : undefined;
    const etag = '"' + createHash('sha256').update(type + (attachment || '')).update(saved.body).digest('hex') + '"';
    digest.update(relative + etag);
    return { ...saved, type, attachment, etag, cache:config.cacheControl || 'no-cache' };
  }
  for (const route of routes) {
    const config = route.page || route.download || route.static;
    if (!config) continue;
    if (!route.static) { watch.push(await checked(config.file)); route.asset = await read(config.file,config,Boolean(route.download)); continue; }
    const dir = await checked(config.directory); watch.push(dir);
    assert((await lstat(dir)).isDirectory(), 'Static directory must exist');
    const files = new Map();
    async function walk(relative, key = '', depth = 0) {
      assert(depth <= 20, 'Asset directory depth exceeded');
      for (const entry of (await readdir(await checked(relative),{withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
        assert(++entries <= 10000, 'Maximum 10000 asset entries');
        // Hidden/sensitive files are never published, even inside a public directory.
        if (entry.name.startsWith('.') || denied.test(entry.name)) continue;
        const next = relative + '/' + entry.name, name = key + entry.name;
        if (entry.isDirectory()) await walk(next,name+'/',depth+1);
        else files.set(name,await read(next,config,false));
      }
    }
    await walk(config.directory);
    route.asset = files;
  }
  return { watch, digest:digest.digest('hex').slice(0,16) };
}
export function assetResponse(route, path, method, request) {
  let asset = route.asset;
  if (route.static) {
    let key = path.slice(route.prefix.length);
    if (key.endsWith('/') || !key) key += route.static.index || '';
    asset = asset.get(key);
    if (!asset) throw new HttpError(404, 'Not found');
  }
  const { body, etag, modified } = asset;
  const headers = [['content-type',asset.type],['etag',etag],['last-modified',modified],['cache-control',asset.cache],['accept-ranges','bytes']];
  if (asset.attachment) headers.push(['content-disposition',asset.attachment]);
  const empty = status => ({ status, headers, body:Buffer.alloc(0), ...(status === 304 ? {} : {contentLength:0}) });
  const matches = (value, weak) => value.trim() === '*' || value.split(',').some(tag => (weak ? tag.trim().replace(/^W\//,'') : tag.trim()) === etag);
  const match = request.get('if-match'), none = request.get('if-none-match');
  if (match && !matches(match,false)) return empty(412);
  if (!match && request.has('if-unmodified-since') && Date.parse(modified) > Date.parse(request.get('if-unmodified-since'))) return empty(412);
  if (none ? matches(none,true) : request.has('if-modified-since') && Date.parse(modified) <= Date.parse(request.get('if-modified-since'))) return empty(304);
  const range = request.get('range');
  // Multiple/malformed ranges and date If-Range fall back to the full representation.
  if (method === 'GET' && range && (!request.has('if-range') || request.get('if-range') === etag)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      const size = BigInt(body.length);
      let start = m[1] ? BigInt(m[1]) : size - BigInt(m[2]);
      let end = m[1] && m[2] ? BigInt(m[2]) : size - 1n;
      if (start < 0n) start = 0n;
      if (end >= size) end = size - 1n;
      if (start >= size || end < start) { headers.push(['content-range',`bytes */${size}`]); return empty(416); }
      headers.push(['content-range',`bytes ${start}-${end}/${size}`]);
      const part = body.subarray(Number(start),Number(end)+1);
      return {status:206,headers,body:part,contentLength:part.length};
    }
  }
  // The snapshot reference lets the compression policy serve a precomputed
  // variant by identity check instead of recompressing immutable bytes.
  return {status:200,headers,body,contentLength:body.length,asset};
}
