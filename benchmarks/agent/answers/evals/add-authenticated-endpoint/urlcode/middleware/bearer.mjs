// Bearer gate; the expected token is the route's declared binding.
function same(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) mismatch |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return mismatch === 0 && expected.length > 0;
}
export default async function bearer(request, context, next) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!same(token, context.env.API_TOKEN)) return new Response('Unauthorized\n', { status: 401, headers: { 'www-authenticate': 'Bearer realm="demo"' } });
  return next();
}
