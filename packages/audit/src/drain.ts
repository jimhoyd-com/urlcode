// The drain loop: one loop per attached producer outbox. It waits for the extension to be active, peeks at most
// 100 events, validates them, stores them in one transaction and only then acks them. A failed round retries with
// backoff and never skips an event; a producer that breaks the contract (an invalid event, another source) is
// stopped and never acked, so its outbox fills and the producer fails closed.
import { AuditError } from './types.ts';
import type { AuditAttachment, AuditEvent, AuditProducer } from './types.ts';
import { MAX_BATCH, SOURCE, validateAuditEvent } from './event.ts';

export interface DrainOptions {
  /** Stores a validated batch durably, or throws. */
  ingest(events: readonly AuditEvent[]): void;
  isActive(): boolean;
  now(): number;
  onDeliveryError?: ((source: string, error: unknown) => void) | undefined;
  /** Idle poll interval, default 1000 ms. */
  pollMs?: number;
  /** flush() deadline, default 2000 ms. */
  flushTimeoutMs?: number;
  /** First retry delay, default 100 ms, doubling up to maxBackoffMs (default 5000 ms). */
  backoffMs?: number; maxBackoffMs?: number;
}
export interface Drain {
  attach(producer: AuditProducer): AuditAttachment;
  flush(): Promise<void>;
  /** Wakes every loop (activation calls it so no loop waits out its poll). */
  wake(): void;
  /** Closes every attachment, each after its in-flight batch. */
  close(): Promise<void>;
}

interface Waiter { startedAt: number; after: Map<Loop, number>; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
interface Loop {
  producer: AuditProducer; closing: boolean; halted: boolean; notified: boolean; peeks: number;
  onNotify?: (() => void) | undefined; onClose?: (() => void) | undefined;
  waiters: Set<Waiter>; done?: Promise<void>;
}

function unavailable(source: string): AuditError { return new AuditError(503, 'audit_unavailable', `The audit log stopped draining producer ${source}`); }

export function createDrain(options: DrainOptions): Drain {
  const pollMs = options.pollMs ?? 1000, flushTimeoutMs = options.flushTimeoutMs ?? 2000, backoffMs = options.backoffMs ?? 100, maxBackoffMs = options.maxBackoffMs ?? 5000;
  const loops = new Map<string, Loop>();
  const report = (source: string, error: unknown): void => { try { options.onDeliveryError?.(source, error); } catch { /* Best effort. */ } };

  /** Resolves after `ms`, on close, and (when `byNotify`) on notify; a closing loop never waits. */
  function wait(loop: Loop, ms: number, byNotify: boolean): Promise<void> {
    if (loop.closing || (byNotify && loop.notified)) return Promise.resolve();
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(timer); loop.onNotify = undefined; loop.onClose = undefined; resolve(); };
      const timer = setTimeout(done, ms);
      timer.unref();
      loop.onClose = done;
      if (byNotify) loop.onNotify = done;
    });
  }
  function settle(waiter: Waiter, loop: Loop): void {
    loop.waiters.delete(waiter);
    waiter.after.delete(loop);
    if (!waiter.after.size) { clearTimeout(waiter.timer); waiter.resolve(); }
  }
  function fail(loop: Loop, error: Error): void {
    for (const waiter of loop.waiters) {
      clearTimeout(waiter.timer);
      for (const other of waiter.after.keys()) other.waiters.delete(waiter);
      waiter.reject(error);
    }
    loop.waiters.clear();
  }
  /** A flush is done with this producer once a peek that began after the flush holds only events newer than it (R13). */
  function settleFlushes(loop: Loop, peek: number, events: readonly AuditEvent[]): void {
    for (const waiter of [...loop.waiters])
      if (peek > waiter.after.get(loop)! && events.every(event => event.at > waiter.startedAt)) settle(waiter, loop);
  }
  function check(loop: Loop, batch: unknown): AuditEvent[] {
    if (!Array.isArray(batch) || batch.length > MAX_BATCH) throw new Error(`Audit producer ${loop.producer.source} returned an invalid peek result`);
    return batch.map(value => {
      const event = validateAuditEvent(value);
      if (event.source !== loop.producer.source) throw new Error(`Audit producer ${loop.producer.source} returned an event from another source`);
      return event;
    });
  }

  async function run(loop: Loop): Promise<void> {
    const { producer } = loop;
    let delay = 0;
    const retry = async (error: unknown): Promise<void> => {
      report(producer.source, error);
      delay = Math.min(maxBackoffMs, delay ? delay * 2 : backoffMs);
      await wait(loop, delay, false);
    };
    while (!loop.closing) {
      if (!options.isActive()) { loop.notified = false; await wait(loop, pollMs, true); continue; }
      loop.notified = false;
      const peek = ++loop.peeks;
      let batch: unknown;
      try { batch = await producer.peek(MAX_BATCH); }
      catch (error) { await retry(error); continue; }
      let events: AuditEvent[];
      try { events = check(loop, batch); }
      catch (error) {
        loop.halted = true;
        report(producer.source, error);
        fail(loop, unavailable(producer.source));
        return;
      }
      settleFlushes(loop, peek, events);
      if (!events.length) { delay = 0; await wait(loop, pollMs, true); continue; }
      // The in-flight batch finishes even when close() arrives meanwhile; a failure while closing is not retried
      // (the events stay in the producer's outbox for the next host).
      try { options.ingest(events); await producer.ack(events.map(event => event.id)); delay = 0; }
      catch (error) { if (loop.closing) { report(producer.source, error); break; } await retry(error); }
    }
  }

  async function closeLoop(loop: Loop): Promise<void> {
    if (!loop.closing) {
      loop.closing = true;
      loop.onClose?.();
    }
    await loop.done;
    if (loops.get(loop.producer.source) === loop) loops.delete(loop.producer.source);
    fail(loop, unavailable(loop.producer.source));
  }

  return {
    attach(producer) {
      if (!producer || typeof producer !== 'object' || typeof producer.source !== 'string' || !SOURCE.test(producer.source) || typeof producer.peek !== 'function' || typeof producer.ack !== 'function')
        throw new TypeError('An audit producer needs a source name and peek and ack functions');
      if (loops.has(producer.source)) throw new Error(`An audit producer for source ${producer.source} is already attached`);
      const loop: Loop = { producer, closing: false, halted: false, notified: false, peeks: 0, waiters: new Set() };
      loops.set(producer.source, loop);
      loop.done = run(loop).catch(error => { loop.halted = true; report(producer.source, error); fail(loop, unavailable(producer.source)); });
      let closing: Promise<void> | undefined;
      return {
        notify() { if (!loop.closing) { loop.notified = true; loop.onNotify?.(); } },
        close() { return closing ??= closeLoop(loop); },
      };
    },
    flush() {
      const live = [...loops.values()].filter(loop => !loop.closing);
      const halted = live.find(loop => loop.halted);
      if (halted) return Promise.reject(unavailable(halted.producer.source));
      if (!live.length) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const waiter: Waiter = {
          startedAt: options.now(), after: new Map(live.map(loop => [loop, loop.peeks])), resolve, reject,
          timer: setTimeout(() => {
            for (const loop of waiter.after.keys()) loop.waiters.delete(waiter);
            reject(new AuditError(503, 'audit_flush_timeout', 'The audit log did not drain every producer within 2000 ms'));
          }, flushTimeoutMs),
        };
        for (const loop of live) { loop.waiters.add(waiter); loop.notified = true; loop.onNotify?.(); }
      });
    },
    wake() { for (const loop of loops.values()) { loop.notified = true; loop.onNotify?.(); } },
    async close() { await Promise.all([...loops.values()].map(closeLoop)); },
  };
}
