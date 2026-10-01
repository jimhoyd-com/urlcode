// Cross-origin resource sharing with an origin allowlist, as in Express cors
// or Hono cors. The route must declare OPTIONS in its methods for preflight.
const preflightHeaders = {
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
  'access-control-max-age': '600'
};
// Adds origin to the downstream vary instead of replacing it: a handler that
// already varies by another header keeps that, and `vary: *` stays `*`.
function varyOnOrigin(vary) {
  const names = (vary ?? '').split(',').map(name => name.trim()).filter(Boolean);
  if (names.includes('*')) return '*';
  if (names.some(name => name.toLowerCase() === 'origin')) return names.join(', ');
  return [...names, 'origin'].join(', ');
}
// Sets headers on the downstream response, copying it first when its headers
// are immutable (for example a Response returned by fetch).
function withHeaders(response, headers) {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
    return copy;
  }
}
export default async function cors(request, context, next) {
  const allowed = (context.env.ALLOWED_ORIGINS || '').split(/\s+/).filter(Boolean);
  const origin = request.headers.get('origin');
  const permitted = origin !== null && allowed.includes(origin);
  if (request.method === 'OPTIONS') {
    // Preflight never reaches the handler. Unknown origins get no allow headers.
    const headers = {vary: 'origin', ...(permitted ? {...preflightHeaders, 'access-control-allow-origin': origin} : {})};
    return new Response(null, {status: 204, headers});
  }
  const response = await next();
  const headers = {vary: varyOnOrigin(response.headers.get('vary'))};
  if (permitted) headers['access-control-allow-origin'] = origin;
  return withHeaders(response, headers);
}
