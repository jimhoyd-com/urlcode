// What a trusted function sees of the request in whichever host serves it.
export default async function echo(request, context) {
  const body = new Uint8Array(await request.arrayBuffer());
  const headers = new Headers({ 'content-type': 'application/json', 'x-echo': 'yes' });
  headers.append('set-cookie', 'a=1; Path=/app; HttpOnly');
  headers.append('set-cookie', 'b=2; Path=/app; HttpOnly');
  return new Response(JSON.stringify({
    method: request.method,
    url: request.url,
    contentType: request.headers.get('content-type'),
    custom: request.headers.get('x-custom'),
    bodyText: new TextDecoder().decode(body),
    requestId: context.requestId,
  }), { headers });
}
