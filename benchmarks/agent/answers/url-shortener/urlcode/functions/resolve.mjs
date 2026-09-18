import { links, wellFormed } from './links.mjs';
export default function resolve(request, { args }) {
  if (!wellFormed(args.code)) return new Response('Invalid code\n', { status: 400 });
  const url = links[args.code];
  return url ? Response.redirect(url, 302) : new Response('Unknown link\n', { status: 404 });
}
