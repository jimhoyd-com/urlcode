export const links = new Map([
  ['docs', 'https://docs.example.com/'],
  ['blog', 'https://example.com/blog'],
  ['jobs', 'https://example.com/careers'],
]);
export const wellFormed = code => /^[a-z0-9-]{2,16}$/.test(code);

export function validate(body) {
  const errors = [];
  const code = typeof body?.code === 'string' ? body.code : '', url = typeof body?.url === 'string' ? body.url : '';
  if (!wellFormed(code)) errors.push('invalid code');
  else if (links.has(code)) errors.push('code already exists');
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:' || !parsed.host) errors.push('url must be an https URL');
  return { errors, record: { code, url } };
}
