// Pure validation of what producers write and what readers ask for. No I/O: auth's store worker imports it at
// runtime to validate an event before it persists it to its outbox, so no invalid event ever reaches a drain.
import { AuditError } from './types.ts';
import type { AuditEvent, AuditQuery, AuditValue } from './types.ts';

export const SOURCE = /^[a-z][a-z0-9-]{0,63}$/;
export const ACTION = /^[a-z][a-z0-9_.-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SEQ = /^[1-9][0-9]{0,15}$/;
const EVENT_KEYS = new Set(['id', 'source', 'action', 'actor', 'subject', 'at', 'reason', 'metadata']);
const QUERY_KEYS = new Set(['source', 'actor', 'subject', 'action', 'actionPrefix', 'from', 'to', 'after', 'limit', 'order']);
export const MAX_METADATA_BYTES = 4096, MAX_METADATA_DEPTH = 3, MAX_METADATA_KEYS = 16, MAX_BATCH = 100, DEFAULT_LIMIT = 50;

/** Messages name the field, never its value. */
function invalid(field: string): never { throw new AuditError(400, 'invalid_audit_event', `Invalid audit event: ${field}`); }
function invalidQuery(field: string): never { throw new AuditError(400, 'invalid_audit_query', `Invalid audit query: ${field}`); }

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function text(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !CONTROL.test(value);
}
function time(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

/** A frozen copy of plain JSON within the depth and key bounds; `depth` is the nesting level of `value` (the metadata object is 1). */
function copyValue(value: unknown, depth: number): AuditValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid('metadata'); return value; }
  if (depth >= MAX_METADATA_DEPTH) invalid('metadata');
  if (Array.isArray(value)) return Object.freeze(value.map(item => copyValue(item, depth + 1)));
  if (!plainObject(value)) invalid('metadata');
  return copyObject(value, depth + 1);
}
function copyObject(value: Record<string, unknown>, depth: number): Readonly<Record<string, AuditValue>> {
  const keys = Object.keys(value);
  if (keys.length > MAX_METADATA_KEYS || Object.getOwnPropertySymbols(value).length) invalid('metadata');
  // fromEntries defines own properties, so a "__proto__" key stays data and never reaches a prototype.
  return Object.freeze(Object.fromEntries(keys.map(key => {
    if (!key.length || key.length > 128 || CONTROL.test(key)) invalid('metadata');
    return [key, copyValue(value[key], depth)];
  })));
}

/** Pure: returns a frozen, normalized copy of a valid event, or throws AuditError(400, 'invalid_audit_event'). */
export function validateAuditEvent(value: unknown): AuditEvent {
  if (!plainObject(value)) invalid('event');
  for (const key of Object.keys(value)) if (!EVENT_KEYS.has(key)) invalid('unknown field');
  const { id, source, action, actor, subject, at, reason, metadata } = value;
  if (typeof id !== 'string' || !UUID.test(id)) invalid('id');
  if (typeof source !== 'string' || !SOURCE.test(source)) invalid('source');
  if (typeof action !== 'string' || !ACTION.test(action)) invalid('action');
  if (!text(actor, 1, 256)) invalid('actor');
  if (!text(subject, 0, 512)) invalid('subject');
  if (!time(at)) invalid('at');
  if (reason !== undefined && !text(reason, 0, 1024)) invalid('reason');
  let copied: Readonly<Record<string, AuditValue>> | undefined;
  if (metadata !== undefined) {
    if (!plainObject(metadata)) invalid('metadata');
    copied = copyObject(metadata, 1);
    if (Buffer.byteLength(JSON.stringify(copied)) > MAX_METADATA_BYTES) invalid('metadata');
  }
  return Object.freeze({ id, source, action, actor, subject, at, ...(reason === undefined ? {} : { reason }), ...(copied === undefined ? {} : { metadata: copied }) });
}

export interface NormalizedQuery {
  source?: string; actor?: string; subject?: string; action?: string; actionPrefix?: string;
  from?: number; to?: number; after?: number; limit: number; order: 'asc' | 'desc';
}
/** Validates a reader's filter; throws AuditError(400, 'invalid_audit_query'). */
export function validateAuditQuery(value: unknown): NormalizedQuery {
  if (value === undefined) return { limit: DEFAULT_LIMIT, order: 'asc' };
  if (!plainObject(value)) invalidQuery('query');
  for (const key of Object.keys(value)) if (!QUERY_KEYS.has(key)) invalidQuery('unknown field');
  const filter = value as AuditQuery, query: NormalizedQuery = { limit: DEFAULT_LIMIT, order: 'asc' };
  if (filter.source !== undefined) { if (typeof filter.source !== 'string' || !SOURCE.test(filter.source)) invalidQuery('source'); query.source = filter.source; }
  if (filter.action !== undefined) { if (typeof filter.action !== 'string' || !ACTION.test(filter.action)) invalidQuery('action'); query.action = filter.action; }
  if (filter.actionPrefix !== undefined) { if (typeof filter.actionPrefix !== 'string' || !ACTION.test(filter.actionPrefix)) invalidQuery('actionPrefix'); query.actionPrefix = filter.actionPrefix; }
  if (filter.actor !== undefined) { if (!text(filter.actor, 1, 256)) invalidQuery('actor'); query.actor = filter.actor; }
  if (filter.subject !== undefined) { if (!text(filter.subject, 0, 512)) invalidQuery('subject'); query.subject = filter.subject; }
  if (filter.from !== undefined) { if (!time(filter.from)) invalidQuery('from'); query.from = filter.from; }
  if (filter.to !== undefined) { if (!time(filter.to)) invalidQuery('to'); query.to = filter.to; }
  if (filter.after !== undefined) {
    if (typeof filter.after !== 'string' || !SEQ.test(filter.after) || !Number.isSafeInteger(Number(filter.after))) invalidQuery('after');
    query.after = Number(filter.after);
  }
  if (filter.limit !== undefined) { if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_BATCH) invalidQuery('limit'); query.limit = filter.limit; }
  if (filter.order !== undefined) { if (filter.order !== 'asc' && filter.order !== 'desc') invalidQuery('order'); query.order = filter.order; }
  return query;
}
