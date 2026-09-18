import { page } from './page.mjs';
import { validate } from './rules.mjs';

export default async function contact(request) {
  if (request.method !== 'POST') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const input = await request.json();
  if (typeof input === 'object' && input !== null && typeof input.website === 'string' && input.website.length > 0) return Response.json({ received: true });
  const errors = validate(input);
  if (errors.length) return Response.json({ errors }, { status: 422 });
  return Response.json({ received: true }, { status: 201 });
}
