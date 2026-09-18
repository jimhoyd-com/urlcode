export default async function requestId(request, context, next) {
  const given = request.headers.get('x-request-id') || '';
  const id = /^[A-Za-z0-9-]{1,64}$/.test(given) ? given : Math.random().toString(36).slice(2, 14);
  const response = await next();
  response.headers.set('x-request-id', id);
  return response;
}
