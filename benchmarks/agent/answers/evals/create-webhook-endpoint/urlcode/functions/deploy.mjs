export default async function deploy(request) {
  const body = await request.json();
  if (typeof body !== 'object' || body === null || typeof body.ref !== 'string') return Response.json({ errors: ['ref is required'] }, { status: 422 });
  return Response.json({ queued: true, ref: body.ref }, { status: 202 });
}
