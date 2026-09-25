// The drain loop against a fake in-memory producer: the outbox contract without auth or store. Timing-sensitive
// cases use createDrain with short intervals; the rest run through createAudit with its real intervals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditError } from '../src/index.ts';
import type { AuditEvent } from '../src/index.ts';
import { createDrain } from '../src/drain.ts';
import type { DrainOptions } from '../src/drain.ts';
import { activeAudit, deferred, event, fakeProducer, openAudit, activation, until } from './support.ts';

function memoryDrain(options: Partial<DrainOptions> = {}) {
  const stored = new Map<string, AuditEvent>(), errors: unknown[] = [];
  let active = true;
  const drain = createDrain({
    ingest: events => { for (const item of events) if (!stored.has(item.id)) stored.set(item.id, item); },
    isActive: () => active, now: Date.now, onDeliveryError: (_source, error) => { errors.push(error); },
    pollMs: 60000, flushTimeoutMs: 1000, backoffMs: 5, maxBackoffMs: 20, ...options,
  });
  return { drain, stored, errors, setActive(value: boolean) { active = value; } };
}
const unavailable = (error: unknown) => error instanceof AuditError && error.status === 503 && error.code === 'audit_unavailable';

test('notify wakes an idle loop at once; without it the next poll picks events up', async t => {
  const { drain, stored } = memoryDrain();
  t.after(() => drain.close());
  const producer = fakeProducer();
  const attachment = drain.attach(producer);
  await until(() => producer.peeks === 1);
  producer.outbox.push(event(), event());
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(stored.size, 0, 'an idle loop waits for notify or the poll');
  attachment.notify();
  await until(() => stored.size === 2, 500);
  assert.equal(producer.outbox.length, 0);

  const polled = memoryDrain({ pollMs: 50 });
  t.after(() => polled.drain.close());
  const quiet = fakeProducer('quiet');
  polled.drain.attach(quiet);
  await until(() => quiet.peeks >= 1);
  quiet.outbox.push(event({ source: 'quiet' }));
  await until(() => polled.stored.size === 1, 1000);
});

test('the real loop polls every second when nobody notifies', async t => {
  const { audit } = await activeAudit(t);
  const producer = fakeProducer();
  audit.exports.attach(producer);
  await until(() => producer.peeks >= 1);
  const pushed = Date.now();
  producer.outbox.push(event());
  await until(async () => (await audit.exports.query()).events.length === 1, 2500);
  const waited = Date.now() - pushed;
  assert.ok(waited >= 500 && waited < 2000, `picked up by the 1 s poll after ${waited} ms`);
});

test('a loop attached before activation waits, and activation wakes it', async t => {
  const { drain, stored, setActive } = memoryDrain();
  t.after(() => drain.close());
  setActive(false);
  const producer = fakeProducer();
  producer.outbox.push(event());
  drain.attach(producer);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(producer.peeks, 0);
  setActive(true);
  drain.wake();
  await until(() => stored.size === 1, 500);
});

test('an ingest failure retries with backoff and loses and duplicates nothing', async t => {
  let failures = 2;
  const stored: AuditEvent[] = [];
  const { drain, errors } = memoryDrain({ ingest: events => { if (failures-- > 0) throw new Error('disk full'); stored.push(...events); } });
  t.after(() => drain.close());
  const producer = fakeProducer();
  const events = [event(), event(), event()];
  producer.outbox.push(...events);
  drain.attach(producer).notify();
  await until(() => producer.outbox.length === 0, 1000);
  assert.deepEqual(stored.map(item => item.id), events.map(item => item.id));
  assert.equal(errors.length, 2);
  assert.equal(producer.acks.length, 1, 'nothing is acked until it is stored');
});

test('an ack failure redelivers the batch and the log stores it once', async t => {
  const errors: string[] = [];
  const { audit } = await activeAudit(t, { onDeliveryError: (source, error) => { errors.push(`${source}: ${(error as Error).message}`); } });
  let fail = true;
  const producer = fakeProducer('fake');
  const ack = producer.ack.bind(producer);
  producer.ack = async ids => { if (fail) { fail = false; throw new Error('producer busy'); } await ack(ids); };
  producer.outbox.push(event(), event());
  audit.exports.attach(producer).notify();
  await until(() => producer.outbox.length === 0);
  assert.equal((await audit.exports.query()).events.length, 2);
  assert.deepEqual(errors, ['fake: producer busy']);
});

test('an event from another source or an invalid event stops that attachment, unacked, and fails flush', async t => {
  for (const bad of [event({ source: 'other' }), { ...event(), actor: '' }]) {
    const { drain, stored, errors } = memoryDrain();
    t.after(() => drain.close());
    const producer = fakeProducer();
    producer.outbox.push(event(), bad as AuditEvent);
    const attachment = drain.attach(producer);
    attachment.notify();
    await until(() => errors.length === 1, 500);
    assert.equal(stored.size, 0, 'the whole batch is refused');
    assert.equal(producer.acks.length, 0);
    await assert.rejects(drain.flush(), unavailable);
    const peeks = producer.peeks;
    attachment.notify();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(producer.peeks, peeks, 'a stopped loop never peeks again');
    assert.throws(() => drain.attach(fakeProducer()), /already attached/, 'the stopped source stays claimed until it is closed');
    await attachment.close();
    drain.attach(fakeProducer());
  }
});

test('a peek result that is not an array of at most 100 events stops the attachment', async t => {
  const { drain, errors } = memoryDrain();
  t.after(() => drain.close());
  drain.attach(fakeProducer('many', { peek: async () => Array.from({ length: 101 }, () => event({ source: 'many' })) })).notify();
  drain.attach(fakeProducer('shape', { peek: async () => ({ length: 0 }) as never })).notify();
  await until(() => errors.length === 2, 500);
});

test('flush resolves once events pending at call time are stored, even while the producer keeps writing (R13)', async t => {
  const { audit } = await activeAudit(t);
  const producer = fakeProducer();
  audit.exports.attach(producer);
  let writing = true;
  const writer = (async () => { while (writing) { producer.outbox.push(event()); await new Promise(resolve => setTimeout(resolve, 2)); } })();
  t.after(async () => { writing = false; await writer; });
  await new Promise(resolve => setTimeout(resolve, 50));
  const started = Date.now();
  const pending = producer.outbox.map(item => item.id);
  await audit.exports.flush();
  const stored = new Set((await audit.exports.query({ limit: 100, from: 0, to: started })).events.map(item => item.id));
  assert.ok(pending.length > 0);
  for (const id of pending) assert.ok(stored.has(id), 'every event pending when flush was called is stored');
  writing = false;
  await writer;
});

test('flush with no producers resolves at once; a flush does not settle on a peek that began before it', async t => {
  const { drain, stored } = memoryDrain();
  t.after(() => drain.close());
  await drain.flush();
  const gate = deferred<AuditEvent[]>();
  const producer = fakeProducer('slow');
  let calls = 0;
  const peek = producer.peek.bind(producer);
  producer.peek = async limit => (++calls === 1 ? gate.promise : peek(limit));
  drain.attach(producer);
  await until(() => calls === 1);
  producer.outbox.push(event({ source: 'slow', at: Date.now() - 1000 }));
  const flushed = drain.flush();
  gate.resolve([]);
  await flushed;
  assert.equal(stored.size, 1, 'the stale empty peek did not settle the flush');
});

test('flush rejects audit_flush_timeout after its deadline (2000 ms in createAudit)', async t => {
  const { audit } = await activeAudit(t, { onDeliveryError: () => {} });
  audit.exports.attach(fakeProducer('down', { peek: async () => { throw new Error('producer down'); } }));
  const started = Date.now();
  await assert.rejects(audit.exports.flush(), (error: unknown) => error instanceof AuditError && error.status === 503 && error.code === 'audit_flush_timeout');
  const waited = Date.now() - started;
  assert.ok(waited >= 1900 && waited < 3500, `timed out after ${waited} ms`);
});

test('close waits for the in-flight batch, then the loop stops and the source is free again', async () => {
  const { drain, stored } = memoryDrain();
  const gate = deferred();
  const producer = fakeProducer();
  const ack = producer.ack.bind(producer);
  producer.ack = async ids => { await gate.promise; await ack(ids); };
  producer.outbox.push(event());
  const attachment = drain.attach(producer);
  await until(() => stored.size === 1);
  let closed = false;
  const closing = attachment.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(closed, false, 'close waits for the ack of the batch in flight');
  gate.resolve();
  await closing;
  assert.equal(producer.outbox.length, 0);
  const peeks = producer.peeks;
  attachment.notify();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(producer.peeks, peeks);
  await attachment.close();
  drain.attach(fakeProducer()).close();
  await drain.close();
});

test('a duplicate source is refused, and a closing audit closes its attachments before its database', async t => {
  const { audit, dir } = await openAudit(t);
  const producer = fakeProducer();
  audit.exports.attach(producer);
  assert.throws(() => audit.exports.attach(fakeProducer()), /already attached/);
  assert.throws(() => audit.exports.attach({ source: 'Bad', peek: async () => [], ack: async () => {} }), TypeError);
  const instance = await audit.registration.activate({}, activation(dir));
  t.after(() => instance.close?.());
  producer.outbox.push(event());
  await audit.exports.flush();
  assert.equal((await audit.exports.query()).events.length, 1);
  await audit.close();
  producer.outbox.push(event());
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(producer.outbox.length, 1, 'nothing drains after close; the event waits for the next host');
});
