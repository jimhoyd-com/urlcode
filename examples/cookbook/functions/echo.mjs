export default async function echo(request) {
  return Response.json(await request.json());
}
