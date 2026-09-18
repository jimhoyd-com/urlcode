// Method override for clients that can only send POST (Express method-override).
// The route still declares every real method; only a bounded set may be tunneled.
const tunnelable = ['PUT', 'PATCH', 'DELETE'];
export async function override(request, context, next) {
  const requested = (request.headers.get('x-http-method-override') || '').toUpperCase();
  if (request.method === 'POST' && requested) {
    if (!tunnelable.includes(requested)) {
      return new Response('Method override not allowed\n', {status: 405, headers: {allow: tunnelable.join(', ')}});
    }
    context.state.method = requested;
  } else {
    context.state.method = request.method;
  }
  return next();
}
