// Wrap successful JSON function responses in a stable envelope. Native bodies are
// opaque and pass through untouched; only readable JSON is rewritten.
export default async function envelope(request, context, next) {
  const response = await next();
  if (!response.ok || !(response.headers.get('content-type') || '').startsWith('application/json')) return response;
  let data;
  try { data = await response.json(); } catch { return response; }
  const path = request.url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
  const meta = {route: path, count: Array.isArray(data) ? data.length : 1};
  return Response.json({ok: true, data, meta}, {status: response.status, headers: response.headers});
}
