import { links } from './links.mjs';
export default function record(request, { args }) {
  const url = links[args.code];
  return url ? Response.json({ code: args.code, url }) : new Response('Unknown link\n', { status: 404 });
}
