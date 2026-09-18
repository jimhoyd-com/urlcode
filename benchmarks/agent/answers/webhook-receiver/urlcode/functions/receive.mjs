const sources = ['github', 'stripe'];
export default async function receive(request, { args }) {
  // An unknown source is 404, not the 400 an enum parameter would give.
  if (!sources.includes(args.source)) return new Response('Unknown source\n', { status: 404 });
  const body = await request.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof body.event !== 'string') return Response.json({ errors: ['event is required'] }, { status: 422 });
  return Response.json({ received: true, source: args.source, event: body.event }, { status: 202 });
}
