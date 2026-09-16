export default function choice(request, {args}) {
  const destinations = {docs: 'https://example.com/docs', home: 'https://example.com/'};
  return Response.redirect(destinations[args.destination], 302);
}
