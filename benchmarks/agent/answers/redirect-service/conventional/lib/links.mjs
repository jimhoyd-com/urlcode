export const redirects = {
  '/go': { status: 302, url: 'https://example.com/' },
  '/docs': { status: 301, url: 'https://docs.example.com/' },
};

export function productTarget(id, ref) {
  const target = new URL(`https://example.com/products/${encodeURIComponent(id)}`);
  if (ref) target.searchParams.set('ref', ref);
  return target.toString();
}
