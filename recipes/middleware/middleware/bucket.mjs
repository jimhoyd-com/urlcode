// Sticky A/B bucketing through a cookie, as on Vercel or Cloudflare edge examples.
// Bucket b gets a different destination; everyone keeps their bucket for a week.
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
  const response = assigned === 'b' ? Response.redirect(context.env.VARIANT_URL, 302) : await next();
  response.headers.set('vary', 'cookie');
  if (fresh) response.headers.append('set-cookie', 'bucket=' + assigned + '; Path=/; Max-Age=604800; SameSite=Lax');
  return response;
}
