import { closeSync, openSync, writeSync } from 'node:fs';
import { egressUrl } from './egress.ts';

/** The fixed body every signal carries, delivered or captured. */
export interface SignalPayload { version: 1; route: string; status: number; method: string }
/** A would-be delivery: the destination origin (never its path, query or headers, which may hold a token) and the payload. */
export interface SignalRecord { event: 'signal'; outcome: 'captured'; destination: string; payload: SignalPayload }
export const signalPayload = (event: { route: string; status: number; method: string }): SignalPayload => ({ version: 1, route: event.route, status: event.status, method: event.method });
/** At most this many records wait for `take()`; older ones are dropped first. */
const KEPT = 1000;

/**
 * Stands in for signal delivery: `urlcode test` and `urlcode audit` read what a request would have sent, and
 * `urlcode dev --signal-sink` writes each record as one JSON line. Nothing reaches the network. A runtime given a
 * recorder never calls its signal transport.
 */
export class SignalRecorder {
  readonly #kept: SignalRecord[] = [];
  readonly #keep: boolean;
  readonly #write: ((line: string) => void) | undefined;
  readonly #close: (() => void) | undefined;
  constructor({ keep = true, write, close }: { keep?: boolean; write?: (line: string) => void; close?: () => void } = {}) {
    this.#keep = keep; this.#write = write; this.#close = close;
  }
  /** `stdout`, or a JSON-lines file opened for appending. Keeps nothing for `take()`. */
  static sink(target: string): SignalRecorder {
    if (target === 'stdout') return new SignalRecorder({ keep: false, write: line => { process.stdout.write(line); } });
    const fd = openSync(target, 'a', 0o600);
    return new SignalRecorder({ keep: false, write: line => { writeSync(fd, line); }, close: () => { closeSync(fd); } });
  }
  record(url: string, event: { route: string; status: number; method: string }): SignalRecord {
    const record: SignalRecord = { event: 'signal', outcome: 'captured', destination: egressUrl(url).origin, payload: signalPayload(event) };
    if (this.#keep) { this.#kept.push(record); if (this.#kept.length > KEPT) this.#kept.shift(); }
    try { this.#write?.(`${JSON.stringify(record)}\n`); } catch { /* A sink cannot fail a request. */ }
    return record;
  }
  /** The records kept since the last call, oldest first. */
  take(): SignalRecord[] { return this.#kept.splice(0); }
  close(): void { this.#close?.(); }
}

/** One `expectSignals` entry of a request fixture (schemas/requests.schema.json). */
export interface SignalExpectation { destination?: string; count?: number; match?: Record<string, string | number> }
/** RFC 6901 pointer into a payload; undefined when a segment is missing. */
function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  for (const raw of path.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
const matches = (record: SignalRecord, expected: SignalExpectation): boolean =>
  (expected.destination === undefined || record.destination === expected.destination)
  && Object.entries(expected.match ?? {}).every(([path, value]) => pointer(record.payload, path) === value);
/**
 * The expectations a request's captured signals break, by index. Each entry counts the records it matches: exactly
 * `count` when given, else at least one. An empty list expects no signal at all.
 */
export function unmetSignals(expected: readonly SignalExpectation[], records: readonly SignalRecord[]): { index: number; expected: SignalExpectation; matched: number }[] {
  if (!expected.length) return records.length ? [{ index: -1, expected: { count: 0 }, matched: records.length }] : [];
  return expected.flatMap((item, index) => {
    const matched = records.filter(record => matches(record, item)).length;
    return (item.count === undefined ? matched >= 1 : matched === item.count) ? [] : [{ index, expected: item, matched }];
  });
}
