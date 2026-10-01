// Content negotiation in the spirit of Express res.format. The handler always
// produces JSON; this converts it to plain text when the client prefers that.
function preferences(accept) {
  return (accept || '*/*').split(',').map((part, index) => {
    const [type, ...params] = part.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return {type: type.trim().toLowerCase(), q: q ? Number(q.slice(2)) || 0 : 1, index};
  }).filter(p => p.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
}
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
export default async function negotiate(request, context, next) {
  const ranked = preferences(request.headers.get('accept'));
  const choice = ranked.find(p => ['application/json', 'text/plain', 'application/*', 'text/*', '*/*'].includes(p.type));
  if (!choice) return new Response('Not acceptable: application/json or text/plain\n', {status: 406});
  const response = withHeaders(await next(), headers => headers.set('vary', addVary(headers.get('vary'), 'accept')));
  if (!response.ok || !['text/plain', 'text/*'].includes(choice.type)) return response;
  const value = await response.json();
  const lines = Object.entries(value).map(([key, item]) => key + ': ' + String(item)).join('\n') + '\n';
  return new Response(lines, {status: response.status, headers: {...Object.fromEntries(response.headers), 'content-type': 'text/plain; charset=utf-8'}});
}
