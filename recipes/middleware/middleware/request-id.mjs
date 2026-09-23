// Correlation id and timing headers (Hono requestId/timing, Express response-time).
// The runtime already stamps its own x-request-id on every reply; this carries the
// caller's id instead so a client can match its logs to yours. A generated id is
// a trace label, never a secret: Math.random keeps the module portable to a
// `sandbox: true` route (no crypto there); this trusted route could use
// crypto.randomUUID() instead.
const validId = /^[A-Za-z0-9._-]{1,64}$/;
export default async function correlation(request, context, next) {
  const started = Date.now();
  const incoming = request.headers.get('x-correlation-id');
  context.state.correlationId = incoming !== null && validId.test(incoming)
    ? incoming
    : started.toString(36) + '-' + Math.floor(Math.random() * 0xffffffff).toString(36);
  const response = await next();
  response.headers.set('x-correlation-id', context.state.correlationId);
  response.headers.set('server-timing', 'app;dur=' + (Date.now() - started));
  return response;
}
