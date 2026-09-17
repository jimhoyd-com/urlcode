export default async function echo(request) {
  return Response.json({received: await request.json()});
}
