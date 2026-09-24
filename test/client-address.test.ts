import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCidr, resolveClient, compileTrustedProxies, normalizeAddress, clientKey } from '../packages/core/src/client-address.ts';
import type { Cidr } from '../packages/core/src/client-address.ts';

test('trusted proxies are walked from the right and malformed hops skipped', () => {
  const trusted: Cidr[] = compileTrustedProxies('10.0.0.0/8, 64:ff9b::/96');
  assert.equal(resolveClient('10.0.0.1', '203.0.113.5:1234, 10.0.0.2', trusted), '203.0.113.5');
  assert.equal(resolveClient('10.0.0.1', 'garbage, 10.0.0.2', trusted), '10.0.0.2');
  assert.deepEqual([...parseCidr('64:ff9b::1.2.3.4/96').bytes.slice(12)], [1, 2, 3, 4]);
  assert.equal(resolveClient('64:ff9b::1.2.3.4', '198.51.100.7', trusted), '198.51.100.7');
  assert.equal(resolveClient('203.0.113.9', '10.0.0.2', trusted), '203.0.113.9');
  assert.equal(resolveClient(undefined, undefined, trusted), undefined);
  assert.equal(normalizeAddress('[::1]:8080'), '::1');
  assert.throws(() => parseCidr('10.0.0.0/33'), /Invalid trusted proxy prefix/);
  assert.throws(() => compileTrustedProxies(Array.from({ length: 257 }, () => '10.0.0.1')), /At most 256/);
});

test('client keys group IPv6 by /64 and IPv4-mapped addresses as IPv4 (shared vectors, #547)', () => {
  const { vectors } = JSON.parse(readFileSync(new URL('./client-key-vectors.json', import.meta.url), 'utf8')) as { vectors: [string | null, string | null][] };
  for (const [input, expected] of vectors) assert.equal(clientKey(input), expected ?? undefined, String(input));
});
