// Parameter schemas have no `pattern`, so the character class is checked here.
export default function product(request, { args }) {
  if (!/^[A-Za-z0-9-]{1,32}$/.test(args.id)) return new Response('Invalid product id\n', { status: 400 });
  const target = 'https://example.com/products/' + encodeURIComponent(args.id) + (args.ref === undefined ? '' : '?ref=' + encodeURIComponent(args.ref));
  return Response.redirect(target, 302);
}
