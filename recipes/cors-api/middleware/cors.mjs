// Edit this allowlist. The runtime has no CORS policy; middleware is the
// supported place for it, and it runs only on routes that declare it.
const allowedOrigins = ['https://app.example.com'];
const allowMethods = 'GET, HEAD, OPTIONS';
const allowHeaders = 'Content-Type';

// Adds Origin to the downstream Vary instead of replacing it: a handler that
// already varies by another header keeps that, and `Vary: *` stays `*`.
function varyOnOrigin(vary) {
  const names = (vary ?? '').split(',').map(name => name.trim()).filter(Boolean);
  if (names.includes('*')) return '*';
  if (names.some(name => name.toLowerCase() === 'origin')) return names.join(', ');
  return [...names, 'Origin'].join(', ');
}

// Sets headers on the downstream response, copying it first when its headers
// are immutable (for example a Response returned by fetch).
function withHeaders(response, headers) {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
    return copy;
  }
}

export default async function cors(request, context, next) {
  const origin = request.headers.get('origin');
  const allowed = origin !== null && allowedOrigins.includes(origin);
  if (request.method === 'OPTIONS') {
    // Preflight never reaches the handler. A disallowed origin gets no CORS
    // headers, so the browser refuses the real request.
    const headers = {Vary: 'Origin'};
    if (allowed) Object.assign(headers, {'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': allowMethods, 'Access-Control-Allow-Headers': allowHeaders, 'Access-Control-Max-Age': '600'});
    return new Response(null, {status: 204, headers});
  }
  const response = await next();
  const headers = {Vary: varyOnOrigin(response.headers.get('vary'))};
  if (allowed) headers['Access-Control-Allow-Origin'] = origin;
  return withHeaders(response, headers);
}
