// Language redirect from Accept-Language, like Next.js i18n middleware. Only
// languages listed in LOCALES are chosen; the native redirect is the default.
export default async function locale(request, context, next) {
  const supported = (context.env.LOCALES || '').split(/\s+/).filter(Boolean);
  const ranked = (request.headers.get('accept-language') || '').split(',').map((part, index) => {
    const [tag, ...params] = part.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return {lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) || 0 : 1, index};
  }).filter(p => p.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
  const chosen = ranked.find(p => supported.includes(p.lang))?.lang;
  const response = chosen && chosen !== supported[0]
    ? Response.redirect(context.env.SITE + '/' + chosen + '/welcome', 302)
    : await next();
  response.headers.set('vary', 'accept-language');
  return response;
}
