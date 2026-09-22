import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type HmacEncoding = 'hex' | 'base64url';

function digest(secret: string | Uint8Array, message: string, encoding: HmacEncoding): string {
  return createHmac('sha256', secret).update(message).digest(encoding);
}

/** Computes a keyed HMAC-SHA256 of `message`, encoded as `encoding`. */
export function signHmac(secret: string | Uint8Array, message: string, encoding: HmacEncoding = 'hex'): string {
  return digest(secret, message, encoding);
}

/** Constant-time check that `provided` is the HMAC-SHA256 of `message` under `secret`. */
export function verifyHmac(secret: string | Uint8Array, message: string, provided: string | undefined, encoding: HmacEncoding = 'hex'): boolean {
  if (!provided) return false;
  const expected = digest(secret, message, encoding);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected, encoding), Buffer.from(provided, encoding));
}

/** A signed, TTL-bound token: an HMAC-authenticated JSON envelope carrying `payload`, an expiry and a random nonce, encoded as `<data>.<signature>`. */
export function createSignedToken(secret: string | Uint8Array, payload: Record<string, unknown>, ttlMs: number): string {
  const data = Buffer.from(JSON.stringify({ ...payload, expires: Date.now() + ttlMs, nonce: randomUUID() })).toString('base64url');
  return `${data}.${signHmac(secret, data, 'base64url')}`;
}

/** Verifies a token from `createSignedToken`: checks the signature and that `expires` is a safe integer within `ttlMs` of now. Returns the decoded payload, or `undefined`. */
export function readSignedToken(secret: string | Uint8Array, value: string | undefined, ttlMs: number): (Record<string, unknown> & { expires: number }) | undefined {
  if (!value) return undefined;
  const [data, signature, ...extra] = value.split('.');
  if (!data || !signature || extra.length) return undefined;
  if (!verifyHmac(secret, data, signature, 'base64url')) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const expires = (parsed as Record<string, unknown>).expires;
    if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires < Date.now() || expires > Date.now() + ttlMs) return undefined;
    return parsed as Record<string, unknown> & { expires: number };
  } catch { return undefined; }
}
