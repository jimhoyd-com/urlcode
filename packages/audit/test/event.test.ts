import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditError, validateAuditEvent } from '../src/index.ts';
import { event } from './support.ts';

function refused(value: unknown, field: string): void {
  assert.throws(() => validateAuditEvent(value), (error: unknown) => {
    assert.ok(error instanceof AuditError);
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_audit_event');
    assert.equal(error.message, `Invalid audit event: ${field}`);
    return true;
  });
}
const nested = (depth: number): Record<string, unknown> => depth <= 1 ? { leaf: true } : { child: nested(depth - 1) };

test('a valid event comes back as a frozen, normalized copy', () => {
  const input = event({ reason: 'because', metadata: { a: 1, b: 'x', c: [true, null], d: { e: 2 } } });
  const output = validateAuditEvent(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.ok(Object.isFrozen(output) && Object.isFrozen(output.metadata) && Object.isFrozen(output.metadata!.c));
  const minimal = validateAuditEvent(event({ subject: '', at: 0 }));
  assert.equal('reason' in minimal, false);
  assert.equal('metadata' in minimal, false);
});

test('the event itself must be a plain object with only the known fields', () => {
  for (const value of [null, undefined, 'x', 1, [], new Date(), new (class Event {})()]) refused(value, 'event');
  refused({ ...event(), extra: 1 }, 'unknown field');
});

test('id is a lowercase UUID v4', () => {
  refused(event({ id: undefined }), 'id');
  refused(event({ id: '6F9619FF-8B86-4D11-B42D-00C04FC964FF' }), 'id');
  refused(event({ id: '6f9619ff-8b86-1d11-b42d-00c04fc964ff' }), 'id');
  refused(event({ id: '6f9619ff-8b86-4d11-742d-00c04fc964ff' }), 'id');
  refused(event({ id: 42 }), 'id');
  validateAuditEvent(event({ id: '6f9619ff-8b86-4d11-b42d-00c04fc964ff' }));
});

test('source and action follow their name patterns and length bounds', () => {
  validateAuditEvent(event({ source: `a${'b'.repeat(63)}` }));
  refused(event({ source: `a${'b'.repeat(64)}` }), 'source');
  for (const source of ['', 'Auth', '1auth', 'auth_x', 'auth.x']) refused(event({ source }), 'source');
  validateAuditEvent(event({ action: `a${'b'.repeat(127)}` }));
  validateAuditEvent(event({ action: 'store.record_created-x' }));
  refused(event({ action: `a${'b'.repeat(128)}` }), 'action');
  for (const action of ['', 'Login', '.login', 'log in', 'login/x']) refused(event({ action }), 'action');
});

test('actor, subject and reason are bounded text with no C0 or DEL characters', () => {
  validateAuditEvent(event({ actor: 'x'.repeat(256) }));
  for (const actor of ['', 'x'.repeat(257), 'a\nb', 'a\u007fb', 'a\u0000', 7]) refused(event({ actor }), 'actor');
  validateAuditEvent(event({ subject: 'x'.repeat(512) }));
  for (const subject of ['x'.repeat(513), 'a\tb', undefined]) refused(event({ subject }), 'subject');
  validateAuditEvent(event({ reason: '' }));
  validateAuditEvent(event({ reason: 'x'.repeat(1024) }));
  for (const reason of ['x'.repeat(1025), 'a\rb', null]) refused(event({ reason }), 'reason');
  validateAuditEvent(event({ actor: 'naïve ✓ user' }));
});

test('at is a safe integer of epoch milliseconds, zero or more', () => {
  validateAuditEvent(event({ at: 0 }));
  validateAuditEvent(event({ at: Number.MAX_SAFE_INTEGER }));
  for (const at of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1', undefined]) refused(event({ at }), 'at');
});

test('metadata is plain JSON: depth 3, 16 keys per object, 4096 bytes', () => {
  validateAuditEvent(event({ metadata: nested(3) }));
  refused(event({ metadata: nested(4) }), 'metadata');
  validateAuditEvent(event({ metadata: { list: [[1]] } }));
  refused(event({ metadata: { list: [[[1]]] } }), 'metadata');
  const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, index]));
  validateAuditEvent(event({ metadata: keys(16) }));
  refused(event({ metadata: keys(17) }), 'metadata');
  refused(event({ metadata: { inner: keys(17) } }), 'metadata');
  // {"s":"..."} is 8 bytes of framing.
  validateAuditEvent(event({ metadata: { s: 'x'.repeat(4088) } }));
  refused(event({ metadata: { s: 'x'.repeat(4089) } }), 'metadata');
  refused(event({ metadata: { s: 'é'.repeat(2045) } }), 'metadata');
  for (const metadata of [[], 'x', null, new Map()]) refused(event({ metadata }), 'metadata');
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, undefined, () => 1, new Date(), 1n, Symbol('x')]) refused(event({ metadata: { value } }), 'metadata');
  refused(event({ metadata: { '': 1 } }), 'metadata');
  refused(event({ metadata: { 'a\nb': 1 } }), 'metadata');
});

test('a __proto__ metadata key stays data and never changes a prototype', () => {
  const output = validateAuditEvent(JSON.parse(JSON.stringify({ ...event(), metadata: { ['__proto__']: { polluted: true } } })));
  assert.equal(Object.getPrototypeOf(output.metadata), Object.prototype);
  assert.deepEqual(Object.keys(output.metadata!), ['__proto__']);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('an error names the field and never echoes the refused value', () => {
  const secret = 'hunter2-secret-value\n';
  assert.throws(() => validateAuditEvent(event({ actor: secret })), (error: Error) => !error.message.includes('hunter2'));
});
