const allowedOrigins = ['https://app.example.com'];
const allowMethods = 'GET, HEAD, OPTIONS';
const allowHeaders = 'Content-Type';

export default async function cors(request, context, next) {
  const origin = request.headers.get('origin');
  const allowed = origin !== null && allowedOrigins.includes(origin);
  if (request.method === 'OPTIONS') {
    const headers = {Vary: 'Origin'};
    if (allowed) Object.assign(headers, {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': allowMethods, 'Access-Control-Allow-Headers': allowHeaders, 'Access-Control-Max-Age': '600'});
    return new Response(null, {status: 204, headers});
  }
  const response = await next();
  response.headers.set('Vary', 'Origin');
  if (allowed) response.headers.set('Access-Control-Allow-Origin', origin);
  return response;
}
