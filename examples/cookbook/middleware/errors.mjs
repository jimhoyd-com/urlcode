// Error boundary. Without it, a throwing function is a bare 502 from the runtime.
// Nothing about the thrown error reaches the client; the correlation id is what
// an operator can search for (and under `sandbox: true`, where console output is
// discarded, the only trace).
export default async function errorBoundary(request, context, next) {
  try {
    return await next();
  } catch {
    return Response.json({error: 'Temporarily unavailable', correlationId: context.state.correlationId ?? null},
      {status: 500, headers: {'cache-control': 'no-store'}});
  }
}
