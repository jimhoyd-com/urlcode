// Sticky A/B bucketing through a cookie, as on Vercel or Cloudflare edge examples.
// Bucket b gets a different destination; everyone keeps their bucket for a week.
// `Response.redirect()`'s headers are immutable (per the Fetch standard a
// trusted route's real `Response` enforces this, unlike the sandbox's guest
// API), so build that branch's headers up front instead of mutating the
// result afterward.
function cookie(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
export default async function bucket(request, context, next) {
  let assigned = cookie(request, 'bucket');
  const fresh = assigned !== 'a' && assigned !== 'b';
  if (fresh) assigned = Math.random() < 0.5 ? 'a' : 'b';
  context.state.bucket = assigned;
  const setCookie = 'bucket=' + assigned + '; Path=/; Max-Age=604800; SameSite=Lax';
  if (assigned === 'b') {
    const headers = new Headers({ location: context.env.VARIANT_URL, vary: 'cookie' });
    if (fresh) headers.append('set-cookie', setCookie);
    return new Response(null, { status: 302, headers });
  }
  const response = await next();
  response.headers.set('vary', 'cookie');
  if (fresh) response.headers.append('set-cookie', setCookie);
  return response;
}
