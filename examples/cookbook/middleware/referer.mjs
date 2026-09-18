// Hotlink protection for a download: the Referer host must be on the allowlist.
// Referers are advisory, so this deters casual embedding rather than securing anything.
function host(referer) {
  const match = /^https?:\/\/([^/:?#]+)/i.exec(referer || '');
  return match ? match[1].toLowerCase() : null;
}
export default async function referer(request, context, next) {
  const allowed = (context.env.ALLOWED_REFERERS || '').split(/\s+/).filter(Boolean);
  const from = host(request.headers.get('referer'));
  if (from === null || !allowed.includes(from)) return new Response('Direct download links are not permitted\n', {status: 403});
  return next();
}
