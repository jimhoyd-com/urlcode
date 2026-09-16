// Reusable logic around a route: run downstream, then add a response header.
export default async function headers(request, context, next) {
  const response = await next();
  response.headers.set('x-example-middleware', 'active');
  return response;
}
