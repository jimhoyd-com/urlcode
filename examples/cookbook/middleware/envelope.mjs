// Wrap successful JSON function responses in a stable envelope. Only a JSON body
// this chain can actually read is rewritten; everything else passes through
// untouched -- on a `sandbox: true` route that includes every native body, which
// the guest cannot read at all.
export default async function envelope(request, context, next) {
  const response = await next();
  if (!response.ok || !(response.headers.get('content-type') || '').startsWith('application/json')) return response;
  let data;
  try { data = await response.json(); } catch { return response; }
  const path = request.url.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
  const meta = {route: path, count: Array.isArray(data) ? data.length : 1};
  return Response.json({ok: true, data, meta}, {status: response.status, headers: response.headers});
}
