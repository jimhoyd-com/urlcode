// Cross-origin resource sharing with an origin allowlist, as in Express cors
// or Hono cors. The route must declare OPTIONS in its methods for preflight.
const preflightHeaders = {
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
  'access-control-max-age': '600'
};
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
  response.headers.set('vary', 'origin');
  if (permitted) response.headers.set('access-control-allow-origin', origin);
  return response;
}
