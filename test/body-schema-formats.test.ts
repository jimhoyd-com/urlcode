import test from 'node:test';
import assert from 'node:assert/strict';
import { bodySchemaFormatChecks, bodySchemaFormatMaxLength } from '../packages/core/src/body-formats.ts';
import { bodySchemaIssues, bodySchemaProfile } from '../packages/core/src/body-schema.ts';
import { assertSafePattern } from '../packages/core/src/pattern-guard.ts';
import type { BodySchema } from '../packages/core/src/body-schema.ts';

// The standard string formats of the body schema profile (#861). The shared fixture in
// test/fixtures/body-schema/profile.json also runs a value of each format through the Cloudflare build.
const { formats, patterns } = bodySchemaFormatChecks();
const cases: Record<Exclude<keyof typeof bodySchemaFormatMaxLength, 'uuid'>, { valid: string[]; invalid: string[] }> = {
  date: {
    valid: ['2024-02-29', '2000-02-29', '1999-12-31', '0001-01-01', '2023-04-30'],
    invalid: ['2023-02-29', '1900-02-29', '2024-04-31', '2024-13-01', '2024-00-10', '2024-01-00', '2024-1-01', '20240101', '2024-01-01T00:00:00Z', '２０２４-01-01', ''],
  },
  time: {
    valid: ['08:30:06Z', '08:30:06.283185Z', '23:59:60Z', '15:59:60-08:00', '00:59:60+01:00', '12:00:00+14:00', '12:00:00.123456789z', '12:00:00-00:00'],
    invalid: ['12:00:00', '24:00:00Z', '12:60:00Z', '12:00:61Z', '22:59:60Z', '23:59:60+01:00', '12:00:00+24:00', '12:00:00+01:60', '12:00:00.Z', '12:00:00.1234567890Z', '12:00Z', '1:00:00Z', '12:00:00 Z'],
  },
  'date-time': {
    valid: ['1985-04-12T23:20:50.52Z', '1996-12-19T16:39:57-08:00', '1998-12-31T23:59:60Z', '1998-12-31T15:59:60.123-08:00', '2024-02-29t00:00:00z'],
    invalid: ['1998-12-31T23:58:60Z', '1998-12-31T22:59:60Z', '2023-02-29T00:00:00Z', '1990-12-31T15:59:60-24:00', '2024-01-01 00:00:00Z', '2024-01-01T00:00:00', '2024-01-01', '2024-01-01T', '2013-350T01:01:01Z'],
  },
  email: {
    valid: ['joe.bloggs@example.com', 'te~st@example.com', '~test@example.com', 'test~@example.com', "o'hara+tag@mail.example", '"joe bloggs"@example.com', '"joe..bloggs"@example.com', '"a\\"b"@example.com', 'joe@[127.0.0.1]', 'joe@[IPv6:::1]', 'user@localhost', 'joe@xn--bcher-kva.example', 'a'.repeat(64) + '@example.com'],
    invalid: ['2962', '@example.com', 'joe@', '.test@example.com', 'test.@example.com', 'te..st@example.com', 'joe@[127.0.0.300]', 'joe@[IPv6:::12345]', 'joe@invalid=domain.com', 'joe@-example.com', 'joe@example.com.', 'jöe@example.com', 'joe@bücher.example', '"unterminated@example.com', '"a"b"@example.com', 'a'.repeat(65) + '@example.com', 'a@' + 'b'.repeat(250) + '.com'],
  },
  uri: {
    valid: ['http://foo.bar/?baz=qux#quux', 'https://user:pass@example.com:8443/a/b%20c?x=%2F#frag/ment?', 'http://[2001:db8::7]/c=GB?objectClass?one', 'http://[v1.fe80::a+en1]/', 'ftp://ftp.is.co.za/rfc/rfc1808.txt', 'mailto:John.Doe@example.com', 'urn:oasis:names:specification:docbook:dtd:xml:4.1.2', 'tel:+1-816-555-1212', 'file:///etc/hosts', 'http://example.com:/', 'a:'],
    invalid: ['//foo.bar/?baz=qux#quux', '/abc', 'abc', '\\\\WINDOWS\\fileshare', 'http:// shouldfail.com', 'http://example.com/%zz', 'http://example.com/%2', 'http://exämple.com', 'http://[::1', 'http://[::1]x/', 'http://[notip]/', 'http://example.com:80a/', 'http://a@b@c/', '1http://x', 'http://example.com/#a#b', 'http://example.com/[x]'],
  },
  hostname: {
    valid: ['www.example.com', 'example', 'example.com.', 'xn--bcher-kva.example', 'XN--BCHER-KVA.example', 'a-b.c-d', '1host.example', 'a'.repeat(63) + '.com', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`],
    invalid: ['', '.', '-a.example', 'a-.example', 'a..example', 'a_b.example', 'ab--c.example', 'bücher.example', 'a'.repeat(64) + '.com', `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`, 'exa mple.com'],
  },
  ipv4: {
    valid: ['192.168.0.1', '0.0.0.0', '255.255.255.255', '10.0.0.10'],
    invalid: ['256.0.0.1', '192.168.0', '192.168.0.1.1', '192.168.00.1', '087.10.0.1', '0x7f.0.0.1', '1.2.3.-4', '১২৭.0.0.1', '192.168.0.1 ', ''],
  },
  ipv6: {
    valid: ['::1', '::', '1::', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::ffff:192.0.2.1', '::192.0.2.1', '1:2:3:4:5:6:1.2.3.4', 'FE80::0202:B3FF:FE1E:8329', '2001:db8::7', '1::8'],
    invalid: [':::', ':1::', '1:::2', '1::2::3', '12345::', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', '::ffff:256.0.0.1', '1:2:3:4:5:6:7:1.2.3.4', 'fe80::1%eth0', '::g', '1.2.3.4', '', ' ::1'],
  },
};

test('each standard format accepts what its RFC allows and refuses the rest', () => {
  for (const [format, { valid, invalid }] of Object.entries(cases)) {
    const check = formats[format as keyof typeof formats];
    for (const value of valid) assert.equal(check(value), true, `${format} accepts ${JSON.stringify(value)}`);
    for (const value of invalid) assert.equal(check(value), false, `${format} refuses ${JSON.stringify(value)}`);
  }
  // Every format the profile publishes is checked; the list and the caps come from one table.
  assert.deepEqual(bodySchemaProfile.formats, Object.keys(bodySchemaFormatMaxLength));
  assert.deepEqual(Object.keys(formats).sort(), bodySchemaProfile.formats.filter(name => name !== 'uuid').sort());
});

test('a format refuses a value over its published length cap, which the checks repeat', () => {
  // One character past each cap; for email, hostname and uri the value is otherwise valid, so only the cap refuses it.
  const over: Record<keyof typeof formats, string> = {
    date: '2024-01-01 ', time: '23:59:60.1234567890+14:00', 'date-time': '1998-12-31T23:59:60.1234567890+14:00',
    email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`, uri: `https://example.com/${'a'.repeat(2029)}`,
    hostname: `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`, ipv4: '192.168.100.1001', ipv6: '1111:2222:3333:4444:5555:6666:255.255.255.2555',
  };
  for (const [format, value] of Object.entries(over)) {
    const cap = bodySchemaFormatMaxLength[format as keyof typeof formats];
    assert.equal(value.length, cap + 1, format);
    assert.equal(formats[format as keyof typeof formats](value), false, format);
  }
  assert.equal(formats.uri(`https://example.com/${'a'.repeat(2028)}`), true, 'uri at exactly its cap');
  assert.deepEqual(bodySchemaProfile.formatMaxLength, bodySchemaFormatMaxLength);
});

test('every format regex passes the pattern admission guard, and pathological inputs finish fast', () => {
  for (const [name, regex] of Object.entries(patterns)) assert.doesNotThrow(() => assertSafePattern(regex.source), name);
  const hostile = [
    'a'.repeat(4096), '1'.repeat(4096), ':'.repeat(4096), '.'.repeat(4096), '-'.repeat(4096), '%'.repeat(4096), '@'.repeat(4096),
    '"' + '\\'.repeat(4094) + '"', 'a.'.repeat(2048), 'http://' + 'a'.repeat(4096), 'http://' + '%2'.repeat(1400), 'x:' + '/'.repeat(4094),
    `x@${'a-'.repeat(2046)}`, `${'1:'.repeat(2047)}1`, `${'2024-01-01T'.repeat(400)}`, 'http://[' + ':'.repeat(4000) + ']/',
  ];
  const start = performance.now();
  // Each value at full length (refused by the cap) and cut to exactly the cap, so the scan itself runs on it.
  for (let round = 0; round < 20; round++) for (const value of hostile) for (const [format, check] of Object.entries(formats)) {
    check(value); check(value.slice(0, bodySchemaFormatMaxLength[format as keyof typeof formats]));
  }
  assert.ok(performance.now() - start < 1000, 'bounded work per value');
  // A whole-body run: a 4 KB hostile value per format answers the format issue, never a timeout.
  const schema = { type: 'object', properties: Object.fromEntries(Object.keys(bodySchemaFormatMaxLength).map(name => [name.replace('-', '_'), { type: 'string', format: name }])) } satisfies BodySchema;
  for (const value of hostile) {
    const body = Object.fromEntries(Object.keys(schema.properties).map(name => [name, value]));
    assert.equal(bodySchemaIssues(schema, body)[0]?.keyword, 'format');
  }
});

test('format needs no maxLength beside it, applies only to strings and names an unknown format with the supported list', () => {
  assert.deepEqual(bodySchemaIssues({ type: 'object', properties: { at: { type: 'string', format: 'date-time' } } }, { at: '2024-01-01T00:00:00Z' }), []);
  assert.deepEqual(bodySchemaIssues({ type: ['string', 'integer'], format: 'ipv4' }, 7), [], 'a non-string passes format, as JSON Schema says');
  assert.deepEqual(bodySchemaIssues({ type: 'string', format: 'email' }, 'nope'), [{ pointer: '', keyword: 'format', message: 'must be an email', expected: 'email' }]);
  for (const format of ['idn-email', 'idn-hostname', 'iri', 'uri-reference', 'regex', 'duration', 'json-pointer', 'Email', 42])
    assert.throws(() => bodySchemaIssues({ type: 'string', format } as never, ''), /Body schema \/format: unsupported format \(supported: uuid, date, time, date-time, email, uri, hostname, ipv4, ipv6\)$/, String(format));
});
