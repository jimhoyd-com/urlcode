import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignedToken, readSignedToken, signHmac, verifyHmac } from '../src/host/csrf.ts';

const secret = 's'.repeat(32), other = 'o'.repeat(32), ttl = 60_000;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Flips the unused trailing bits of a 43-char base64url signature: a different string that Node decodes to the same 32 bytes. */
function nonCanonical(signature: string): string {
  const index = BASE64URL.indexOf(signature.at(-1)!);
  assert.equal(index & 0b11, 0, 'a canonical 32-byte base64url value has two zero trailing bits');
  const variant = signature.slice(0, -1) + BASE64URL[index | 1];
  assert.deepEqual(Buffer.from(variant, 'base64url'), Buffer.from(signature, 'base64url'));
  return variant;
}

test('signHmac/verifyHmac accept only the canonical signature in each encoding', () => {
  const hex = signHmac(secret, 'message'), b64 = signHmac(secret, 'message', 'base64url');
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.match(b64, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verifyHmac(secret, 'message', hex), true);
  assert.equal(verifyHmac(secret, 'message', b64, 'base64url'), true);
  assert.equal(verifyHmac(secret, 'other message', hex), false);
  assert.equal(verifyHmac(other, 'message', b64, 'base64url'), false);
  assert.equal(verifyHmac(secret, 'message', hex.toUpperCase()), false, 'uppercase hex is not canonical');
  assert.equal(verifyHmac(secret, 'message', nonCanonical(b64), 'base64url'), false, 'trailing-bit variants are rejected');
});

test('verifyHmac returns false rather than throwing for malformed, wrong-length or missing values', () => {
  const hex = signHmac(secret, 'message'), b64 = signHmac(secret, 'message', 'base64url');
  for (const [provided, encoding] of [
    ['!'.repeat(64), 'hex'], ['!'.repeat(43), 'base64url'],
    [hex.slice(0, 63) + 'z', 'hex'], [b64.slice(0, 42) + '=', 'base64url'], [b64.slice(0, 42) + '+', 'base64url'],
    [hex.slice(1), 'hex'], [hex + '0', 'hex'], [b64.slice(1), 'base64url'], [b64 + 'A', 'base64url'], [b64 + '=', 'base64url'],
    [hex, 'base64url'], [b64, 'hex'], ['', 'hex'], [undefined, 'hex'],
  ] as const) assert.doesNotThrow(() => assert.equal(verifyHmac(secret, 'message', provided, encoding), false), `${String(provided)} (${encoding})`);
});

test('readSignedToken round-trips a fresh token and rejects every tampered, malformed, expired or extended form without throwing', () => {
  const token = createSignedToken(secret, { flow: 'contact' }, ttl);
  const [data, signature] = token.split('.') as [string, string];
  assert.equal(readSignedToken(secret, token, ttl)?.flow, 'contact');
  const reject = (value: string | undefined, why: string, key = secret) => assert.doesNotThrow(() => assert.equal(readSignedToken(key, value, ttl), undefined, why), why);
  reject(token, 'wrong secret', other);
  reject(`${data}.${signHmac(secret, 'other', 'base64url')}`, 'wrong signature');
  reject(`${data}.${'!'.repeat(signature.length)}`, 'malformed characters of the same length');
  reject(`${data}.${signature.slice(0, -1)}`, 'short signature');
  reject(`${data}.${signature}A`, 'long signature');
  reject(`${data}.${nonCanonical(signature)}`, 'non-canonical base64url signature');
  reject(`${token}.extra`, 'extra segment');
  reject(`.${signature}`, 'empty data');
  reject(`${data}.`, 'empty signature');
  reject(data, 'no signature');
  reject('', 'empty');
  reject(undefined, 'missing');
  const expired = createSignedToken(secret, { flow: 'contact' }, -1000);
  reject(expired, 'expired');
  const unsignedJson = Buffer.from('not json').toString('base64url');
  reject(`${unsignedJson}.${signHmac(secret, unsignedJson, 'base64url')}`, 'signed but not a JSON object');
  const tooLong = createSignedToken(secret, { flow: 'contact' }, ttl * 10);
  reject(tooLong, 'expiry beyond the accepted TTL');
});
