export async function decorate(request, context, next) {
  context.state.example = 'cookbook';
  const response = await next();
  response.headers.set('x-middleware', context.state.example);
  return response;
}
