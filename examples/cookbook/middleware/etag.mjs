// Conditional requests for a JSON response: a weak ETag from a cheap FNV-1a
// hash, plus 304 when the client already holds that version. Native static
// and download routes already do this in the runtime; this is for JSON.
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
export default async function etag(request, context, next) {
  const response = await next();
  if (!response.ok || request.method !== 'GET' && request.method !== 'HEAD') return response;
  const body = await response.text();
  const tag = 'W/"' + fnv1a(body) + '"';
  const headers = {...Object.fromEntries(response.headers), etag: tag, 'cache-control': 'public, max-age=60'};
  const held = (request.headers.get('if-none-match') || '').split(',').map(s => s.trim());
  if (held.includes(tag) || held.includes('*')) return new Response(null, {status: 304, headers: {etag: tag, 'cache-control': headers['cache-control']}});
  return new Response(body, {status: response.status, headers});
}
