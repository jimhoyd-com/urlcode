export default async function text(request) {
  return new Response(await request.text());
}
