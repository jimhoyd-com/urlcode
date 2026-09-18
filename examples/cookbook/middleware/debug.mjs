// Authoring aid: with DEBUG on and X-Debug: 1, describe what the guest received.
// Secrets and credential-bearing headers are never echoed.
const hidden = ['authorization', 'cookie', 'proxy-authorization'];
export default async function debug(request, context, next) {
  if (context.env.DEBUG !== 'true' || request.headers.get('x-debug') !== '1') return next();
  const headers = {};
  for (const [name, value] of request.headers) headers[name] = hidden.includes(name) ? '[redacted]' : value;
  return Response.json({
    method: request.method, url: request.url, headers,
    inputs: context.inputs, args: context.args ?? null,
    env: Object.keys(context.env), secrets: Object.keys(context.secrets)
  }, {headers: {'cache-control': 'no-store'}});
}
