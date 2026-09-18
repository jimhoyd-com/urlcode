import { links, wellFormed } from './links.mjs';
export default async function register(request) {
  const body = await request.json(), errors = [];
  const code = typeof body?.code === 'string' ? body.code : '', url = typeof body?.url === 'string' ? body.url : '';
  if (!wellFormed(code)) errors.push('invalid code');
  else if (links[code]) errors.push('code already exists');
  if (!/^https:\/\/[^\s/?#]+/.test(url)) errors.push('url must be an https URL');
  if (errors.length) return Response.json({ errors }, { status: 422 });
  return Response.json({ code, url }, { status: 201 });
}
