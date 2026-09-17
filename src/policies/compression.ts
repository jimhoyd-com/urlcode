import zlib from 'node:zlib';
import { assert, ConfigError } from '../errors.ts';

// Content-coding negotiation (RFC 9110 §12.5.3) enforced on the host. Runs
// last in the response phase so every header it reads (Content-Type,
// Cache-Control, Set-Cookie, ETag) is final. Two paths:
//   assets   variants are computed once in compile() and served by reference
//            with a strong, suffixed ETag (the NGINX gzip_static model);
//   dynamic  bodies up to 1 MiB are compressed synchronously on the request
//            path with a weakened ETag; larger bodies are sent as identity so
//            the event loop is never held for a single response.
export const name = 'compression';
export const phases = ['response'];

const DYNAMIC_LIMIT = 1048576;              // bytes; above this a body is never compressed on the request path
const PRECOMPRESSED_BUDGET = 64 * 1024 * 1024; // aggregate bytes of asset variants per runtime
const DEFAULT_TYPES = ['text/*','application/json','application/javascript','application/xml','image/svg+xml','application/manifest+json','application/ld+json'];
const SUFFIX = { br:'-br', gzip:'-gz', deflate:'-df', zstd:'-zs' };
const BODYLESS = new Set([204,205,304]);

// Codec table. `dynamic` levels favour latency, `stored` levels favour size
// because they are paid once at load. An explicit `level` (1–11) is mapped
// onto each codec's own scale so one number in YAML means "more" everywhere.
const codecs = {
  br: { dynamic: 4, stored: 9, map: level => level,
    compress: (body, quality) => zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }) },
  gzip: { dynamic: 6, stored: 9, map: level => Math.min(level, 9), compress: (body, level) => zlib.gzipSync(body, { level }) },
  deflate: { dynamic: 6, stored: 9, map: level => Math.min(level, 9), compress: (body, level) => zlib.deflateSync(body, { level }) },
  zstd: { dynamic: 3, stored: 12, map: level => Math.min(level * 2, 22),
    compress: (body, level) => zlib.zstdCompressSync(body, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } }) },
};
export const zstdAvailable = typeof zlib.zstdCompressSync === 'function';

export function targets() { return { node:'native', vercel:'delegated', aws:'delegated', cloudflare:'delegated' }; }

function typeMatcher(types) {
  const exact = new Set(), prefixes = [];
  for (const raw of types) {
    const type = raw.toLowerCase().trim();
    assert(/^[\w.+-]+\/(?:\*|[\w.+-]+)$/.test(type), `policies.${name}.types entry "${raw}" is not a media type`);
    if (type.endsWith('/*')) prefixes.push(type.slice(0, -1)); else exact.add(type);
  }
  return header => {
    const type = (header || '').split(';')[0].trim().toLowerCase();
    return type ? exact.has(type) || prefixes.some(prefix => type.startsWith(prefix)) : false;
  };
}
function eligibleAssets(asset) {
  if (!asset) return [];
  return asset instanceof Map ? [...asset.values()] : [asset];
}

export async function compile(config, { route, shared }) {
  assert(config && typeof config === 'object', `policies.${name} on ${route.pattern} must be an object`);
  const encodings = config.encodings ?? ['br','gzip'];
  assert(Array.isArray(encodings) && encodings.length && encodings.every(e => Object.hasOwn(codecs, e)), `policies.${name}.encodings on ${route.pattern} must list br, gzip, deflate or zstd`);
  if (encodings.includes('zstd') && !zstdAvailable) throw new ConfigError(`${route.pattern} declares policies.${name}.encodings zstd, which node:zlib on Node ${process.version} does not provide`);
  const minBytes = config.minBytes ?? 1024;
  assert(Number.isInteger(minBytes) && minBytes >= 0, `policies.${name}.minBytes on ${route.pattern} must be a non-negative integer`);
  const types = config.types ?? DEFAULT_TYPES;
  assert(Array.isArray(types) && types.length, `policies.${name}.types on ${route.pattern} must be a non-empty array`);
  const level = config.level;
  assert(level === undefined || (Number.isInteger(level) && level >= 1 && level <= 11), `policies.${name}.level on ${route.pattern} must be 1–11`);
  const levels = {};
  for (const coding of encodings) {
    const codec = codecs[coding];
    levels[coding] = level === undefined ? { dynamic: codec.dynamic, stored: codec.stored } : { dynamic: codec.map(level), stored: codec.map(level) };
  }
  const state = { encodings, minBytes, types, matches: typeMatcher(types), level: level ?? null, levels, allowWithSecrets: config.allowWithSecrets === true, precompressed: 0 };
  // Asset snapshots are immutable until the next reload, so their variants are
  // computed here, once, and bounded: a variant that does not shrink the file
  // is dropped and the aggregate across the runtime stops at the budget.
  shared.compressionBytes ??= 0;
  for (const asset of eligibleAssets(route.asset)) {
    if (asset.body.length < minBytes || !state.matches(asset.type)) continue;
    asset.encoded ??= {};
    for (const coding of encodings) {
      if (asset.encoded[coding] || shared.compressionBytes >= PRECOMPRESSED_BUDGET) continue;
      const variant = codecs[coding].compress(asset.body, levels[coding].stored);
      if (variant.length >= asset.body.length || shared.compressionBytes + variant.length > PRECOMPRESSED_BUDGET) continue;
      asset.encoded[coding] = variant;
      shared.compressionBytes += variant.length; state.precompressed++;
    }
  }
  return state;
}

// RFC 9110 §12.5.3: pick the acceptable coding with the highest weight; the
// project's `encodings` order breaks ties. A coding absent from the field is
// acceptable only through `*`; identity is the fallback whenever nothing else
// is acceptable, including `identity;q=0` (sending 406 helps nobody).
export function negotiate(acceptEncoding, encodings) {
  if (acceptEncoding == null) return null;
  const weights = new Map();
  for (const member of acceptEncoding.split(',')) {
    const [token, ...params] = member.split(';');
    const coding = token.trim().toLowerCase();
    if (!coding) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split('=');
      if (key?.trim().toLowerCase() === 'q') { q = Number.parseFloat(value); if (!Number.isFinite(q)) q = 0; }
    }
    if (!weights.has(coding)) weights.set(coding, Math.min(Math.max(q, 0), 1));
  }
  const star = weights.get('*') ?? 0;
  let best = null, bestQ = 0;
  for (const coding of encodings) {
    const q = weights.has(coding) ? weights.get(coding) : star;
    if (q > bestQ) { best = coding; bestQ = q; }
  }
  return best;
}

function header(headers, key) {
  const found = headers.find(([k]) => k.toLowerCase() === key);
  return found ? found[1] : undefined;
}
function withVary(headers) {
  const index = headers.findIndex(([k]) => k.toLowerCase() === 'vary');
  if (index < 0) return [...headers, ['vary','Accept-Encoding']];
  const values = headers[index][1].split(',').map(v => v.trim()).filter(Boolean);
  if (values.some(v => v === '*' || v.toLowerCase() === 'accept-encoding')) return headers;
  const out = [...headers]; out[index] = [headers[index][0], [...values,'Accept-Encoding'].join(', ')];
  return out;
}
function etagFor(headers, coding, strong) {
  const value = header(headers, 'etag');
  if (!value) return headers;
  const tagged = strong ? value.replace(/"$/, SUFFIX[coding] + '"') : value.startsWith('W/') ? value : 'W/' + value;
  return headers.map(([k,v]) => k.toLowerCase() === 'etag' ? [k,tagged] : [k,v]);
}
function noneMatch(value, etag) {
  return value.split(',').some(tag => { const t = tag.trim(); return t === '*' || t.replace(/^W\//,'') === etag.replace(/^W\//,''); });
}

export function onResponse(state, request, result) {
  const { status } = result;
  if (BODYLESS.has(status) && status !== 304) return result;
  const headers = result.headers;
  if (header(headers, 'content-encoding') || !state.matches(header(headers, 'content-type'))) return result;
  // The representation can vary from here on, whatever this response does.
  const varied = { ...result, headers: withVary(headers) };
  if (status === 304 || status === 206) return varied;
  if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(header(headers, 'cache-control') || '')) return varied;
  if (!state.allowWithSecrets && (request.secrets || headers.some(([k]) => k.toLowerCase() === 'set-cookie'))) return varied;
  const body = result.body ? (Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body)) : Buffer.alloc(0);
  if (body.length < state.minBytes) return varied;
  const coding = negotiate(request.headers.get('accept-encoding'), state.encodings);
  if (!coding) return varied;
  const asset = result.asset;
  const stored = asset?.encoded?.[coding] && (asset.body === result.body || (request.method === 'HEAD' && result.asset === asset)) && status === 200 ? asset.encoded[coding] : undefined;
  let encoded, strong;
  if (stored) { encoded = stored; strong = true; }
  else {
    // Dynamic bodies: HEAD would pay the whole compression for a number, and
    // large bodies would stall every other request, so both stay identity.
    if (request.method === 'HEAD' || body.length > DYNAMIC_LIMIT) return varied;
    encoded = codecs[coding].compress(body, state.levels[coding].dynamic);
    if (encoded.length >= body.length) return varied;
    strong = false;
  }
  const out = { ...varied, headers: [...etagFor(varied.headers, coding, strong).filter(([k]) => k.toLowerCase() !== 'content-encoding'), ['content-encoding', coding]] };
  // The asset handler validated If-None-Match against the identity tag; the
  // suffixed tag of an encoded variant is this module's to validate.
  const etag = header(out.headers, 'etag'), revalidate = request.headers.get('if-none-match');
  if (strong && etag && revalidate && noneMatch(revalidate, etag)) return { ...out, status: 304, body: Buffer.alloc(0), contentLength: undefined };
  return { ...out, body: encoded, contentLength: encoded.length };
}

export function describe(state) {
  return { encodings: state.encodings, minBytes: state.minBytes, types: state.types.length, level: state.level, precompressed: state.precompressed };
}
export async function close(shared) { if (shared) shared.compressionBytes = 0; }
