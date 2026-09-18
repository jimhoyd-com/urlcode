// A kill switch: return 503 while MAINTENANCE is on, unless the caller presents
// the bypass token. Flip the binding and restart; no code change is needed.
export default async function maintenance(request, context, next) {
  const active = context.env.MAINTENANCE === 'true';
  const bypass = context.env.MAINTENANCE_BYPASS;
  if (active && !(bypass && request.headers.get('x-maintenance-bypass') === bypass)) {
    return new Response('Down for maintenance\n', {status: 503, headers: {'retry-after': '120', 'cache-control': 'no-store'}});
  }
  return next();
}
