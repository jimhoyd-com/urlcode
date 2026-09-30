// The audit event contract, exported from `@jimhoyd/urlcode/extensions`: the event shape, its pure validator, the
// query a reader asks with, and the tap, the pull contract an audit log offers so an owner can forward its events to
// any sink. The store records events and serves the tap; a sink consumes it. Neither depends on the other's package.
// Pure: no I/O.

/** Plain JSON an event may carry as metadata. Never secrets or submitted values. */
export type AuditValue = string | number | boolean | null | readonly AuditValue[] | { readonly [key: string]: AuditValue };
/** One recorded action. Validated by `validateAuditEvent`. */
export interface AuditEvent {
  /** Idempotency key: crypto.randomUUID() (lowercase v4). */
  readonly id: string;
  /** The recording extension's name, /^[a-z][a-z0-9-]{0,63}$/ ("store"). */
  readonly source: string;
  /** /^[a-z][a-z0-9_.-]{0,127}$/, for example "store.record.created". */
  readonly action: string;
  /** 1..256 characters, no C0/DEL: a principal id, "anonymous", "operator" or "system". */
  readonly actor: string;
  /** 0..512 characters, no C0/DEL. */
  readonly subject: string;
  /** When it happened, epoch ms, a safe integer >= 0. */
  readonly at: number;
  /** 0..1024 characters, no C0/DEL. Default "". */
  readonly reason?: string;
  /** Plain JSON, depth <= 3, <= 16 keys per object, serialized <= 4096 bytes. */
  readonly metadata?: Readonly<Record<string, AuditValue>>;
}
/** An event as an audit log keeps it: `reason` filled in, `metadata` null when absent, and its position. */
export interface AuditStoredEvent extends Required<Omit<AuditEvent, 'metadata'>> {
  readonly metadata: Readonly<Record<string, AuditValue>> | null;
  /** Record order, an opaque decimal string; the pagination cursor. */
  readonly seq: string;
}
export interface AuditQuery {
  source?: string; actor?: string; subject?: string; action?: string;
  /** Matches action = prefix or an action starting with prefix + "." ("store.record" matches store.record.*). */
  actionPrefix?: string;
  /** Inclusive bounds on `at`. */
  from?: number; to?: number;
  /** A `next` value a previous page with the same filter and order returned. */
  after?: string;
  /** 1..100, default 50. */
  limit?: number;
  /** Default "asc" (record order); "desc" for newest first. */
  order?: 'asc' | 'desc';
}
export interface AuditPage {
  readonly events: readonly AuditStoredEvent[];
  /** Present when more events match; pass it back as `after`. */
  readonly next?: string;
  /** Lowest retained seq at query time, so an exporter can detect pruning mid-export. Absent when the log is empty. */
  readonly oldest?: string;
}
/**
 * The tap: how a sink pulls an audit log's events to forward them anywhere. `peek` returns the oldest events not yet
 * acknowledged, in record order, at most `limit` (1..100); `ack` marks those ids forwarded (unknown or already
 * forwarded ids are ignored) and resolves with how many it marked. Delivery is at least once: a sink that stops
 * between forwarding and `ack` sees the same events again, so it deduplicates on `id`. Events are pruned by the log's
 * retention whether or not they were forwarded, so a sink must keep up within it.
 */
export interface AuditTap {
  peek(limit: number): Promise<readonly AuditStoredEvent[]>;
  ack(ids: readonly string[]): Promise<number>;
}
/** An audit log: its tap and its query. What the store exports as `StoreExports.audit`. */
export interface AuditLog extends AuditTap {
  query(filter?: AuditQuery): Promise<AuditPage>;
}
export type AuditErrorCode = 'invalid_audit_event' | 'invalid_audit_query' | 'audit_inactive' | 'audit_unavailable';
export class AuditError extends Error {
  readonly status: 400 | 503;
  readonly code: AuditErrorCode;
  constructor(status: 400 | 503, code: AuditErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AuditError';
    this.status = status;
    this.code = code;
  }
}

const SOURCE = /^[a-z][a-z0-9-]{0,63}$/;
const ACTION = /^[a-z][a-z0-9_.-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const SEQ = /^[1-9][0-9]{0,15}$/;
const EVENT_KEYS = new Set(['id', 'source', 'action', 'actor', 'subject', 'at', 'reason', 'metadata']);
const QUERY_KEYS = new Set(['source', 'actor', 'subject', 'action', 'actionPrefix', 'from', 'to', 'after', 'limit', 'order']);
/** The bounds every audit log and sink share: metadata size, depth and keys, and the largest batch or page. */
export const auditLimits = Object.freeze({ metadataBytes: 4096, metadataDepth: 3, metadataKeys: 16, batch: 100, defaultLimit: 50 } as const);

/** Messages name the field, never its value. */
function invalid(field: string): never { throw new AuditError(400, 'invalid_audit_event', `Invalid audit event: ${field}`); }
function invalidQuery(field: string): never { throw new AuditError(400, 'invalid_audit_query', `Invalid audit query: ${field}`); }
function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function text(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !CONTROL.test(value) && value.isWellFormed();
}
function time(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
/** A frozen copy of plain JSON within the depth and key bounds; `depth` is the nesting level of `value` (the metadata object is 1). */
function copyValue(value: unknown, depth: number): AuditValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid('metadata'); return value; }
  if (depth >= auditLimits.metadataDepth) invalid('metadata');
  if (Array.isArray(value)) return Object.freeze(value.map(item => copyValue(item, depth + 1)));
  if (!plainObject(value)) invalid('metadata');
  return copyObject(value, depth + 1);
}
function copyObject(value: Record<string, unknown>, depth: number): Readonly<Record<string, AuditValue>> {
  const keys = Object.keys(value);
  if (keys.length > auditLimits.metadataKeys || Object.getOwnPropertySymbols(value).length) invalid('metadata');
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
    if (new TextEncoder().encode(JSON.stringify(copied)).byteLength > auditLimits.metadataBytes) invalid('metadata');
  }
  return Object.freeze({ id, source, action, actor, subject, at, ...(reason === undefined ? {} : { reason }), ...(copied === undefined ? {} : { metadata: copied }) });
}

/** A validated `AuditQuery`: `after` as a number, `limit` and `order` filled in. */
export interface NormalizedAuditQuery {
  source?: string; actor?: string; subject?: string; action?: string; actionPrefix?: string;
  from?: number; to?: number; after?: number; limit: number; order: 'asc' | 'desc';
}
/** Validates a reader's filter; throws AuditError(400, 'invalid_audit_query'). */
export function validateAuditQuery(value: unknown): NormalizedAuditQuery {
  const query: NormalizedAuditQuery = { limit: auditLimits.defaultLimit, order: 'asc' };
  if (value === undefined) return query;
  if (!plainObject(value)) invalidQuery('query');
  for (const key of Object.keys(value)) if (!QUERY_KEYS.has(key)) invalidQuery('unknown field');
  const filter = value as AuditQuery;
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
  if (filter.limit !== undefined) { if (!Number.isInteger(filter.limit) || filter.limit < 1 || filter.limit > auditLimits.batch) invalidQuery('limit'); query.limit = filter.limit; }
  if (filter.order !== undefined) { if (filter.order !== 'asc' && filter.order !== 'desc') invalidQuery('order'); query.order = filter.order; }
  return query;
}
