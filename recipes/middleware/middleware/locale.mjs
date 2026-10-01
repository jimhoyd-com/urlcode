// Language redirect from Accept-Language, like Next.js i18n middleware. Only
// languages listed in LOCALES are chosen; the native redirect is the default.
// `Response.redirect()`'s headers are immutable (a trusted route's real
// `Response` enforces the Fetch standard here, unlike the sandbox's guest
// API), so that branch builds its own `Response` with headers up front.
// Adds a request header name to the downstream vary instead of replacing it: a
// handler that already varies by another header keeps that, and `vary: *`
// stays `*`.
function addVary(vary, name) {
  const names = (vary ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (names.includes('*')) return '*';
  if (names.some(item => item.toLowerCase() === name)) return names.join(', ');
  return [...names, name].join(', ');
}
// Edits the downstream response's headers, copying it first when they are
// immutable (for example a Response returned by fetch or Response.redirect).
function withHeaders(response, edit) {
  try {
    edit(response.headers);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    edit(copy.headers);
    return copy;
  }
}
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
  return withHeaders(await next(), headers => headers.set('vary', addVary(headers.get('vary'), 'accept-language')));
}
