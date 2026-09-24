// Authentication gates. Like Hono bearerAuth/basicAuth or express-basic-auth,
// but the expected credential comes from the route's declared bindings.
// The cookbook binds literal values; real projects use {secret: name} grants.

// Compare without leaking where two strings differ through timing.
function same(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const length = Math.max(actual.length, expected.length);
  let mismatch = actual.length ^ expected.length;
  for (let i = 0; i < length; i++) mismatch |= (actual.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  return mismatch === 0 && length > 0;
}

// This route runs trusted, where Buffer and atob exist. The small decoder keeps
// the module portable to a `sandbox: true` route, whose API has no atob.
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function decodeBase64(text) {
  const clean = String(text).replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null;
  let bits = 0, buffer = 0, out = '';
  for (const char of clean) {
    buffer = (buffer << 6) | alphabet.indexOf(char); bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((buffer >> bits) & 0xff); }
  }
  return out;
}

export async function bearer(request, context, next) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!same(token, context.env.API_TOKEN)) {
    return new Response('Unauthorized\n', {status: 401, headers: {'www-authenticate': 'Bearer realm="cookbook"', 'cache-control': 'no-store'}});
  }
  return next();
}

export async function basic(request, context, next) {
  const header = request.headers.get('authorization') || '';
  const decoded = header.startsWith('Basic ') ? decodeBase64(header.slice(6).trim()) : null;
  const separator = decoded === null ? -1 : decoded.indexOf(':');
  const user = separator < 0 ? '' : decoded.slice(0, separator), password = separator < 0 ? '' : decoded.slice(separator + 1);
  // Evaluate both comparisons so a wrong user costs the same as a wrong password.
  const userOk = same(user, context.env.ADMIN_USER), passwordOk = same(password, context.env.ADMIN_PASSWORD);
  if (!(userOk && passwordOk)) {
    return new Response('Unauthorized\n', {status: 401, headers: {'www-authenticate': 'Basic realm="cookbook", charset="UTF-8"', 'cache-control': 'no-store'}});
  }
  context.state.user = user;
  return next();
}
