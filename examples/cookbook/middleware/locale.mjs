// Language redirect from Accept-Language, like Next.js i18n middleware. Only
// languages listed in LOCALES are chosen; the native redirect is the default.
// `Response.redirect()`'s headers are immutable (a trusted route's real
// `Response` enforces the Fetch standard here, unlike the sandbox's guest
// API), so that branch builds its own `Response` with headers up front.
export default async function locale(request, context, next) {
  const supported = (context.env.LOCALES || '').split(/\s+/).filter(Boolean);
  const ranked = (request.headers.get('accept-language') || '').split(',').map((part, index) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return {lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) || 0 : 1, index};
  }).filter(p => p.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  const chosen = ranked.find(p => supported.includes(p.lang))?.lang;
  if (chosen && chosen !== supported[0]) {
    return new Response(null, { status: 302, headers: { location: context.env.SITE + '/' + chosen + '/welcome', vary: 'accept-language' } });
  }
  const response = await next();
  response.headers.set('vary', 'accept-language');
  return response;
}
