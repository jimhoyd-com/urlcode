// The runtime has already enforced method, content type, size and JSON syntax.
// The guest checks the shape it cares about and acknowledges; it has no network
// access, so forwarding happens through a declared route signal or a host process
// that reads the runtime log, never from here.
const eventPattern = /^[a-z][a-z0-9_.-]{0,63}$/;
export default async function receive(request) {
  const event = request.headers.get('x-webhook-event');
  if (!event || !eventPattern.test(event)) {
    return Response.json({error: 'missing or invalid X-Webhook-Event header'}, {status: 400});
  }
  const payload = await request.json();
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.id !== 'string') {
    return Response.json({error: 'body must be a JSON object with a string id'}, {status: 422});
  }
  return Response.json({received: true, event, id: payload.id}, {status: 202});
}
