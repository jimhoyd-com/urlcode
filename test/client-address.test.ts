import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCidr, resolveClient, compileTrustedProxies, normalizeAddress, clientKey, isLoopbackAddress } from '../packages/core/src/client-address.ts';
import type { Cidr } from '../packages/core/src/client-address.ts';

test('trusted proxies are walked from the right and malformed hops skipped', () => {
  const trusted: Cidr[] = compileTrustedProxies('10.0.0.0/8, 64:ff9b::/96');
  assert.equal(resolveClient('10.0.0.1', '203.0.113.5:1234, 10.0.0.2', trusted), '203.0.113.5');
  assert.equal(resolveClient('10.0.0.1', 'garbage, 10.0.0.2', trusted), '10.0.0.2');
  assert.deepEqual([...parseCidr('64:ff9b::1.2.3.4/96').range.toByteArray().slice(12)], [1, 2, 3, 4]);
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

// #1041: ipaddr.js replaced the owned CIDR parser. These vectors are what the owned parser answered, so the swap is
// pinned to it: IPv4-mapped IPv6 in both forms, the deprecated `::a.b.c.d` (IPv6, never mapped), zone IDs, /64
// bucketing, the forms Node's isIP refuses (ipaddr.js alone would take `127.1`), and trusted-proxy prefixes.
test('CIDR matching and client keys answer exactly what the owned parser did (#1041)', () => {
  const keys: [string, string | null, boolean][] = [["::ffff:127.0.0.1","127.0.0.1",true],["::FFFF:10.0.0.1","10.0.0.1",false],["::ffff:7f00:1","127.0.0.1",false],["0:0:0:0:0:ffff:10.0.0.1","10.0.0.1",false],["::1.2.3.4","0:0:0:0::/64",false],["::0.0.0.1","0:0:0:0::/64",true],["64:ff9b::1.2.3.4","64:ff9b:0:0::/64",false],["fe80::1%eth0","fe80:0:0:0::/64",false],["fe80::abcd%25","fe80:0:0:0::/64",false],["fe80::1%eth0.5","fe80:0:0:0::/64",false],["2001:db8:0:1:ffff::1","2001:db8:0:1::/64",false],["2001:db8:0:1::1%eth0","2001:db8:0:1::/64",false],["2001:DB8:A:B:C:D:E:F","2001:db8:a:b::/64",false],["127.1",null,false],["0x7f.0.0.1",null,false],["0177.0.0.1",null,false],["1.2.3",null,false],["::g",null,false],["1:2:3:4:5:6:7:8:9",null,false],[" 10.0.0.1",null,false],["10.0.0.1 ",null,false],["[::1]","0:0:0:0::/64",false],["[::1]:80","0:0:0:0::/64",false],["1.2.3.4:80","1.2.3.4",false],["::ffff:999.1.1.1",null,false],["::FFFF:7F00:1","127.0.0.1",false]];
  for (const [address, key, loopback] of keys) {
    assert.equal(clientKey(address), key ?? undefined, address);
    assert.equal(isLoopbackAddress(address), loopback, address);
  }
  const peers = ['10.1.2.3', '::ffff:10.1.2.3', '::ffff:a01:203', '::ffff:7f00:1', '127.0.0.1', '64:ff9b::10.1.2.3', '2001:db8:0:1::9', '2001:db8:0:2::9', 'fe80::9%lo0', '::1', '::0.0.0.1', '203.0.113.5'];
  const ranges: [string, string[]][] = [["10.0.0.0/8",["10.1.2.3","::ffff:10.1.2.3"]],["::ffff:10.0.0.0/8",["10.1.2.3","::ffff:10.1.2.3"]],["::ffff:7f00:0/104",["::ffff:7f00:1"]],["64:ff9b::/96",["64:ff9b::10.1.2.3"]],["2001:db8:0:1::/64",["2001:db8:0:1::9"]],["fe80::1%eth0/10",["fe80::9%lo0"]],["::1/128",["::1","::0.0.0.1"]],["0.0.0.0/0",["10.1.2.3","::ffff:10.1.2.3","127.0.0.1","203.0.113.5"]],["::/0",["::ffff:a01:203","::ffff:7f00:1","64:ff9b::10.1.2.3","2001:db8:0:1::9","2001:db8:0:2::9","fe80::9%lo0","::1","::0.0.0.1"]]];
  for (const [range, trusted] of ranges) {
    const compiled = compileTrustedProxies([range]);
    assert.deepEqual(peers.filter(peer => resolveClient(peer, '198.51.100.7', compiled) === '198.51.100.7'), trusted, range);
  }
  // The one input the owned parser misread: a dotted quad followed by a zone ID lost the quad (`::ffff:1.2.3.4%x`
  // keyed as `0:0:0:0::/64`). It is now the embedded address, as without the zone.
  assert.equal(clientKey('::ffff:1.2.3.4%x'), '1.2.3.4');
  const cidrs: [string, number | string][] =[["10.0.0.0/33","Invalid trusted proxy prefix \"10.0.0.0/33\""],["::/129","Invalid trusted proxy prefix \"::/129\""],["10.0.0.0/-1","Invalid trusted proxy prefix \"10.0.0.0/-1\""],["10.0.0.0/8.5","Invalid trusted proxy prefix \"10.0.0.0/8.5\""],["10.0.0.0/",0],["nope/8","Invalid trusted proxy address \"nope/8\""],["127.1/8","Invalid trusted proxy address \"127.1/8\""],["0x7f.0.0.1/8","Invalid trusted proxy address \"0x7f.0.0.1/8\""],["10.0.0.0/0x8",8],["10.0.0.0/1e1",10],["10.0.0.0/08",8],[" 10.0.0.0/8 ",8]];
  for (const [text, expected] of cidrs) {
    if (typeof expected === 'number') assert.equal(parseCidr(text).prefix, expected, text);
    else assert.throws(() => parseCidr(text), { message: expected });
  }
});
