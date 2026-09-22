import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type HmacEncoding = 'hex' | 'base64url';

/** The only accepted spelling of a 32-byte HMAC-SHA256: lowercase hex (64 chars) or unpadded base64url (43 chars). */
const CANONICAL: Record<HmacEncoding, RegExp> = { hex: /^[0-9a-f]{64}$/, base64url: /^[A-Za-z0-9_-]{43}$/ };

function mac(secret: string | Uint8Array, message: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

/** Decodes `provided` only when it is the canonical `encoding` of a 32-byte value; otherwise returns `undefined`. Never throws. */
function decodeCanonical(provided: string, encoding: HmacEncoding): Buffer | undefined {
  const pattern = CANONICAL[encoding];
  if (!pattern || !pattern.test(provided)) return undefined;
  const bytes = Buffer.from(provided, encoding);
  // Node's decoders silently drop invalid characters and ignore base64url
  // trailing bits; re-encoding rejects every non-canonical spelling.
  if (bytes.length !== 32 || bytes.toString(encoding) !== provided) return undefined;
  return bytes;
}

/** Computes a keyed HMAC-SHA256 of `message`, encoded as `encoding`. */
export function signHmac(secret: string | Uint8Array, message: string, encoding: HmacEncoding = 'hex'): string {
  return mac(secret, message).toString(encoding);
}

/**
 * Constant-time check that `provided` is the canonical `encoding` of the HMAC-SHA256 of `message` under `secret`.
 * Returns `false`, and never throws, for a missing, malformed, wrong-length or non-canonical value.
 */
export function verifyHmac(secret: string | Uint8Array, message: string, provided: string | undefined, encoding: HmacEncoding = 'hex'): boolean {
  if (typeof provided !== 'string') return false;
  const actual = decodeCanonical(provided, encoding);
  if (!actual) return false;
  const expected = mac(secret, message);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** A signed, TTL-bound token: an HMAC-authenticated JSON envelope carrying `payload`, an expiry and a random nonce, encoded as `<data>.<signature>`. */
export function createSignedToken(secret: string | Uint8Array, payload: Record<string, unknown>, ttlMs: number): string {
  const data = Buffer.from(JSON.stringify({ ...payload, expires: Date.now() + ttlMs, nonce: randomUUID() })).toString('base64url');
  return `${data}.${signHmac(secret, data, 'base64url')}`;
}

/** Verifies a token from `createSignedToken`: checks the signature and that `expires` is a safe integer within `ttlMs` of now. Returns the decoded payload, or `undefined`; never throws on malformed input. */
export function readSignedToken(secret: string | Uint8Array, value: string | undefined, ttlMs: number): (Record<string, unknown> & { expires: number }) | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const [data, signature, ...extra] = value.split('.');
    if (!data || !signature || extra.length) return undefined;
    if (!verifyHmac(secret, data, signature, 'base64url')) return undefined;
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const expires = (parsed as Record<string, unknown>).expires;
    if (typeof expires !== 'number' || !Number.isSafeInteger(expires) || expires < Date.now() || expires > Date.now() + ttlMs) return undefined;
    return parsed as Record<string, unknown> & { expires: number };
  } catch { return undefined; }
}
