import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCidr, resolveClient, compileTrustedProxies, normalizeAddress } from '../src/client-address.ts';
import type { Cidr } from '../src/client-address.ts';

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
