// HTTP Basic gate decoded inside the guest (no atob there) with constant-time comparison.
function same(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) mismatch |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return mismatch === 0 && expected.length > 0;
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decode(text) {
  const clean = String(text).replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null;
  let bits = 0, buffer = 0, out = '';
  for (const char of clean) { buffer = (buffer << 6) | alphabet.indexOf(char); bits += 6; if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 0xff); } }
  return out;
}
export default async function basic(request, context, next) {
  const header = request.headers.get('authorization') || '';
  const decoded = header.startsWith('Basic ') ? decode(header.slice(6).trim()) : null;
  const at = decoded === null ? -1 : decoded.indexOf(':');
  const user = at < 0 ? '' : decoded.slice(0, at), password = at < 0 ? '' : decoded.slice(at + 1);
  const userOk = same(user, context.env.ADMIN_USER), passwordOk = same(password, context.env.ADMIN_PASSWORD);
  if (!(userOk && passwordOk)) return new Response('Unauthorized\n', { status: 401, headers: { 'www-authenticate': 'Basic realm="admin"' } });
  return next();
}
