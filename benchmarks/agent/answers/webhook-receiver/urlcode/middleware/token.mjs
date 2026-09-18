// Shared-token gate with a constant-time comparison.
function same(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) mismatch |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return mismatch === 0 && expected.length > 0;
}
export default async function token(request, context, next) {
  if (!same(request.headers.get('x-webhook-token') || '', context.env.WEBHOOK_TOKEN)) return new Response('Unauthorized\n', { status: 401 });
  return next();
}
