// Content negotiation in the spirit of Express res.format. The handler always
// produces JSON; this converts it to plain text when the client prefers that.
function preferences(accept) {
  return (accept || '*/*').split(',').map((part, index) => {
    const [type, ...params] = part.trim().split(';');
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return {type: type.trim().toLowerCase(), q: q ? Number(q.slice(2)) || 0 : 1, index};
  }).filter(p => p.q > 0).sort((a, b) => b.q - a.q || a.index - b.index);
}
export default async function negotiate(request, context, next) {
  const ranked = preferences(request.headers.get('accept'));
  const choice = ranked.find(p => ['application/json', 'text/plain', 'application/*', 'text/*', '*/*'].includes(p.type));
  if (!choice) return new Response('Not acceptable: application/json or text/plain\n', {status: 406});
  const response = await next();
  response.headers.set('vary', 'accept');
  if (!response.ok || !['text/plain', 'text/*'].includes(choice.type)) return response;
  const value = await response.json();
  const lines = Object.entries(value).map(([key, item]) => key + ': ' + String(item)).join('\n') + '\n';
  return new Response(lines, {status: response.status, headers: {...Object.fromEntries(response.headers), 'content-type': 'text/plain; charset=utf-8'}});
}
