import { createHash, randomUUID } from 'node:crypto';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import type { AuditEvent } from '@jimhoyd/urlcode-audit';
import { QUERY_LIMITS, parseListQuery, queryableString, runList } from './query.ts';
import type { StoreDatabase } from './database.ts';

/** Reserved names the store owns on every record. */
export const RESERVED_FIELDS = ['id', 'createdAt', 'updatedAt'] as const;
/**
 * The stored owner of a record in an owned collection (`ownership: owner`, urlcode#331): the opaque principal id the
 * store stamped on create. It is kept in the database's `owner` column only. It never appears in a response, a body
 * naming it is refused like any undeclared field, and no request can change it. The leading underscore cannot be a
 * declared field name, so it never collides with one.
 */
export const OWNER_FIELD = '_owner';
/** How a collection scopes its records: `shared` (the default; every caller who reaches the mount sees every record) or `owner` (each record belongs to the principal that created it). */
export type Ownership = 'shared' | 'owner';
export const LIMITS = { fields: 64, records: 10_000, recordBytes: 65_536, pageSize: 200, stringLength: 65_536 } as const;
const IDEMPOTENCY_LIMITS = { keys: 1_000, keyLength: 128 } as const;
/**
 * Undelivered audit events one collection may hold in the outbox table (audit's `auditOutboxLimits.perCollection`).
 * At the cap a write on an audited collection is refused with 503 `audit_backlog` and nothing is written.
 */
export const AUDIT_BACKLOG = 1_000;
/** Audit metadata stays under audit's 4096-byte bound: the field list is cut here and marked truncated. */
const AUDIT_FIELDS_BYTES = 3_584;

export type FieldType = 'string' | 'integer' | 'number' | 'boolean';
export type Scalar = string | number | boolean;
export interface FieldSpec {
  type: FieldType; required?: boolean; default?: Scalar;
  minLength?: number; maxLength?: number; format?: 'http-url'; enum?: (string | number)[]; minimum?: number; maximum?: number;
}
interface IdempotencySpec { maxKeys: number }
export interface CollectionSpec {
  mount: string; fields: Record<string, FieldSpec>;
  maxRecords?: number; maxRecordBytes?: number; pageSize?: number; readOnly?: boolean;
  /** One required bounded string field that callers choose and the collection keeps unique. */
  key?: string;
  /** Numeric fields callers may atomically increase by one through the collection endpoint. */
  increments?: string[];
  /** Optional durable Idempotency-Key retention for mutating HTTP requests. */
  idempotency?: IdempotencySpec;
  /** Declared fields a list request may sort by (`sort=<field>` or `sort=-<field>`). */
  sortable?: string[];
  /** Declared fields a list request may filter by equality (`<field>=<value>`). */
  filterable?: string[];
  /** `owner` scopes every list, read, update, delete and increment to the request principal and stamps it on create. */
  ownership?: Ownership;
  /**
   * On an owned collection only: how many records one principal may hold (urlcode#731). At most `maxRecords`, which
   * stays the ceiling for the whole collection. Records with no owner count toward no principal.
   */
  maxRecordsPerOwner?: number;
  /**
   * Record every write in the audit log (the audit extension): the event is inserted into the store database's outbox
   * table in the same transaction as the record, and audit drains it from there. Field names only, never values.
   */
  audit?: boolean;
}
export type StoredRecord = Record<string, Scalar>;
type FieldErrors = Record<string, string>;

/** Thrown for caller mistakes; carries field names and fixed messages only, never a submitted value. */
export class StoreError extends Error {
  readonly status: number; readonly code: string; readonly fields: FieldErrors | undefined;
  constructor(status: number, code: string, message: string, fields?: FieldErrors) { super(message); this.status = status; this.code = code; this.fields = fields; }
}

/** JSON Schema for one collection declaration; `normalize` enforces the cross-field rules it cannot express. */
export const collectionSchema = {
  type: 'object', additionalProperties: false, required: ['mount', 'fields'],
  properties: {
    mount: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256, description: 'URL path of the collection\'s JSON API; it needs a route <mount>/* with extension: store (GET, HEAD, POST, PUT, PATCH, DELETE).' },
    fields: { description: 'Declared record fields by name; a body naming any other field is refused. id, createdAt and updatedAt are reserved and store-owned.', type: 'object', minProperties: 1, maxProperties: LIMITS.fields, propertyNames: { pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, additionalProperties: {
      type: 'object', additionalProperties: false, required: ['type'],
      properties: {
        type: { enum: ['string', 'integer', 'number', 'boolean'], description: 'Value type; integer must be a safe integer and number a finite number.' },
        required: { type: 'boolean', description: 'true: every record must carry the field and PATCH cannot clear it; not combinable with default.' },
        default: { oneOf: [{ type: 'string', maxLength: LIMITS.stringLength }, { type: 'number' }, { type: 'boolean' }], description: 'Value stored on create when the body omits the field; it must satisfy the field\'s own rules.' },
        minLength: { type: 'integer', minimum: 0, maximum: LIMITS.stringLength, description: 'Fewest characters of a string value.' },
        maxLength: { type: 'integer', minimum: 1, maximum: LIMITS.stringLength, description: 'Most characters of a string value (default 65536); a key needs at most 128, and a sortable or filterable string field a small bound or an enum.' },
        format: { enum: ['http-url'], description: 'http-url: the string must be an absolute HTTP(S) URL without credentials or ASCII whitespace; required for a short-link destination.' },
        enum: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: [{ type: 'string', maxLength: 256 }, { type: 'number' }] }, description: 'The only values the field accepts; not for booleans.' },
        minimum: { type: 'number', description: 'Smallest numeric value; numbers only.' },
        maximum: { type: 'number', description: 'Largest numeric value; numbers only.' },
      },
    } },
    maxRecords: { type: 'integer', minimum: 1, maximum: LIMITS.records, description: 'Records the collection may hold (default 1000); a create beyond it answers 409 collection_full.' },
    maxRecordBytes: { type: 'integer', minimum: 256, maximum: LIMITS.recordBytes, description: 'Largest serialized record in bytes (default 4096); larger answers 413.' },
    pageSize: { type: 'integer', minimum: 1, maximum: LIMITS.pageSize, description: 'Records per list page, and the cap on a list request\'s limit (default 50).' },
    readOnly: { type: 'boolean', description: 'true: the API serves only GET and HEAD (other methods answer 405); short-link click counting still works.' },
    key: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$', description: 'A required string field (maxLength at most 128, no default) whose caller-chosen value the collection keeps unique; a duplicate create answers 409 key_exists. Not allowed with ownership: owner.' },
    increments: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, description: 'Numeric fields with a numeric default that POST <mount>/<id>/increment/<field> raises by exactly one in one database transaction, within the field\'s bounds.' },
    idempotency: { description: 'Enables the Idempotency-Key header on POST, PUT, PATCH, DELETE and increment; a repeated retained key answers 409 idempotency_duplicate. Without it the header answers 400 idempotency_not_enabled. A key is scoped to the network client (and the principal on an owned collection).', type: 'object', additionalProperties: false, required: ['maxKeys'], properties: { maxKeys: { type: 'integer', minimum: 1, maximum: IDEMPOTENCY_LIMITS.keys, description: 'Newest distinct keys the collection retains, across all clients; an evicted key is no longer protected.' } } },
    sortable: { type: 'array', maxItems: QUERY_LIMITS.declared, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, description: 'Declared fields a list request may sort by (sort=<field> or sort=-<field>).' },
    filterable: { type: 'array', maxItems: QUERY_LIMITS.declared, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, description: 'Declared fields a list request may filter by equality (<field>=<value>); limit, cursor and sort cannot be filterable.' },
    ownership: { enum: ['shared', 'owner'], description: 'shared (default): every caller who reaches the mount sees every record. owner: each record belongs to the principal that created it, and every read and write is scoped to it; the mount must carry a principal-providing policy such as auth: true.' },
    maxRecordsPerOwner: { type: 'integer', minimum: 1, maximum: LIMITS.records, description: 'With ownership: owner only: records one principal may hold, at most maxRecords; beyond it a create answers 409 owner_quota_exceeded.' },
    audit: { type: 'boolean', description: 'true: every write is recorded in the audit log (field names and the principal, never values). Needs the audit extension; writes answer 503 audit_backlog while 1000 events wait to drain.' },
  },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object: object, key: string): boolean => Object.hasOwn(object, key);
const reserved = (key: string): boolean => (RESERVED_FIELDS as readonly string[]).includes(key);
/** A strong ETag derived from the record's id and `updatedAt`, which changes on every mutation
 * (including an increment). Used for conditional GET/If-Match, not a secret. */
export function etagOf(record: StoredRecord): string {
  return `"${createHash('sha256').update(`${record.id as string}:${record.updatedAt as string}`).digest('hex').slice(0, 32)}"`;
}

/** Checks one value against its declared field; returns a fixed, value-free message on failure. */
function checkValue(spec: FieldSpec, value: unknown): string | undefined {
  if (spec.type === 'boolean') { if (typeof value !== 'boolean') return 'must be a boolean'; }
  else if (spec.type === 'string') {
    if (typeof value !== 'string') return 'must be a string';
    if (spec.minLength !== undefined && value.length < spec.minLength) return `must be at least ${spec.minLength} characters`;
    if (value.length > (spec.maxLength ?? LIMITS.stringLength)) return `must be at most ${spec.maxLength ?? LIMITS.stringLength} characters`;
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
    if (spec.type === 'integer' && !Number.isSafeInteger(value)) return 'must be an integer';
    if (spec.minimum !== undefined && value < spec.minimum) return `must be at least ${spec.minimum}`;
    if (spec.maximum !== undefined && value > spec.maximum) return `must be at most ${spec.maximum}`;
  }
  if (spec.format === 'http-url') {
    try { const parsed = new URL(value as string); if (/[\u0000-\u0020\u007f]/.test(value as string) || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return 'must be an absolute HTTP(S) URL without credentials or ASCII whitespace'; }
    catch { return 'must be an absolute HTTP(S) URL without credentials or ASCII whitespace'; }
  }
  if (spec.enum && !spec.enum.includes(value as string | number)) return 'is not one of the allowed values';
  return undefined;
}

export interface NormalizedSpec {
  mount: string; fields: Record<string, FieldSpec>; maxRecords: number; maxRecordBytes: number; pageSize: number; readOnly: boolean;
  key?: string; increments: string[]; idempotency?: IdempotencySpec; sortable: string[]; filterable: string[]; ownership: Ownership;
  maxRecordsPerOwner?: number; audit: boolean;
}
/** Validates a declaration beyond JSON Schema; throws plain Errors for the operator. */
export function normalize(name: string, spec: CollectionSpec): NormalizedSpec {
  for (const [field, f] of Object.entries(spec.fields)) {
    if (reserved(field)) throw new Error(`Collection ${name}: field ${field} is reserved`);
    if (f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength) throw new Error(`Collection ${name}: field ${field} minLength exceeds maxLength`);
    if (f.minimum !== undefined && f.maximum !== undefined && f.minimum > f.maximum) throw new Error(`Collection ${name}: field ${field} minimum exceeds maximum`);
    if ((f.type === 'boolean' || f.type === 'string') && (f.minimum !== undefined || f.maximum !== undefined)) throw new Error(`Collection ${name}: field ${field} minimum/maximum apply to numbers only`);
    if (f.type !== 'string' && (f.minLength !== undefined || f.maxLength !== undefined)) throw new Error(`Collection ${name}: field ${field} minLength/maxLength apply to strings only`);
    if (f.type === 'boolean' && f.enum) throw new Error(`Collection ${name}: field ${field} enum does not apply to booleans`);
    if (f.format !== undefined && f.type !== 'string') throw new Error(`Collection ${name}: field ${field} format applies to strings only`);
    if (f.default !== undefined) {
      const problem = checkValue(f, f.default);
      if (problem) throw new Error(`Collection ${name}: default for ${field} ${problem}`);
      if (f.required) throw new Error(`Collection ${name}: field ${field} cannot be both required and defaulted`);
    }
    for (const option of f.enum ?? []) { const problem = checkValue({ ...f, enum: [option] }, option); if (problem) throw new Error(`Collection ${name}: enum value for ${field} ${problem}`); }
  }
  const queryable = (key: 'sortable' | 'filterable'): string[] => {
    const names = spec[key] ?? [];
    for (const field of names) {
      const declared = hasOwn(spec.fields, field) ? spec.fields[field] : undefined;
      if (!declared) throw new Error(`Collection ${name}: ${key} names ${field.slice(0, 64)}, which is not a declared field`);
      if (key === 'filterable' && ['limit', 'cursor', 'sort'].includes(field)) throw new Error(`Collection ${name}: field ${field} cannot be filterable because its name is a list parameter`);
      if (!queryableString(declared)) throw new Error(`Collection ${name}: ${key} field ${field} is a string and needs maxLength of at most ${QUERY_LIMITS.valueLength} or an enum`);
    }
    return names;
  };
  const key = spec.key;
  if (key !== undefined) {
    const field = spec.fields[key];
    if (!field) throw new Error(`Collection ${name}: key ${key} is not a declared field`);
    if (field.type !== 'string' || !field.required || field.default !== undefined || (field.maxLength ?? LIMITS.stringLength) > IDEMPOTENCY_LIMITS.keyLength) throw new Error(`Collection ${name}: key ${key} must be a required string with maxLength at most ${IDEMPOTENCY_LIMITS.keyLength}`);
  }
  const ownership = spec.ownership ?? 'shared';
  // A collection-wide unique key would tell one owner that another owner already uses a value (409 key_exists), and
  // keys exist for public short links, which cannot serve owned records. Refused rather than scoped silently.
  if (ownership === 'owner' && key !== undefined) throw new Error(`Collection ${name}: key is not supported with ownership: owner`);
  const maxRecords = spec.maxRecords ?? 1000, perOwner = spec.maxRecordsPerOwner;
  if (perOwner !== undefined) {
    // A per-owner limit has no owner to count on a shared collection; refused rather than ignored.
    if (ownership !== 'owner') throw new Error(`Collection ${name}: maxRecordsPerOwner needs ownership: owner`);
    if (perOwner > maxRecords) throw new Error(`Collection ${name}: maxRecordsPerOwner exceeds maxRecords (${maxRecords})`);
  }
  const increments = spec.increments ?? [];
  for (const fieldName of increments) {
    const field = spec.fields[fieldName];
    if (!field) throw new Error(`Collection ${name}: increment field ${fieldName} is not declared`);
    if (!['integer', 'number'].includes(field.type) || typeof field.default !== 'number') throw new Error(`Collection ${name}: increment field ${fieldName} must be numeric with a numeric default`);
  }
  return { mount: spec.mount, fields: spec.fields, ...(key === undefined ? {} : { key }), increments, ...(spec.idempotency === undefined ? {} : { idempotency: spec.idempotency }), sortable: queryable('sortable'), filterable: queryable('filterable'), ownership, ...(perOwner === undefined ? {} : { maxRecordsPerOwner: perOwner }), maxRecords, maxRecordBytes: spec.maxRecordBytes ?? 4096, pageSize: spec.pageSize ?? 50, readOnly: spec.readOnly ?? false, audit: spec.audit ?? false };
}

/** What an audited collection needs from the audit extension: its pure event validator, and a wake-up for the drain after a commit that wrote an event. */
export interface CollectionAuditor { validate(value: unknown): AuditEvent; notify(): void }
type AuditAction = 'created' | 'replaced' | 'updated' | 'deleted' | 'incremented';

/** One `store_records` row. */
interface RecordRow { id: string; owner: string | null; key: string | null; created_at: string; updated_at: string; data: string }
const COLUMNS = 'id, owner, key, created_at, updated_at, data';
/** Thrown by `parse` for a row this declaration cannot represent; activation reports it, a request answers 503. */
class RowError extends Error {}

/**
 * The next `updatedAt`: now, or one millisecond past the previous value when the clock has not moved past it. Every
 * mutation therefore gets a distinct `updatedAt`, so the ETag derived from it changes on every write, even two
 * writes in the same millisecond (an `If-Match` taken before either can never match after both).
 */
function stamp(previous?: string): string {
  const now = Date.now(), last = previous === undefined ? Number.NaN : Date.parse(previous);
  return new Date(Number.isFinite(last) && last >= now ? last + 1 : now).toISOString();
}
/** The declared-field part of a record: what the `data` column holds. */
function fieldsOf(record: StoredRecord): StoredRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !reserved(key) && key !== OWNER_FIELD));
}

/**
 * One collection: a view of its rows in the store database (`store_records` where `collection` is its name). Nothing
 * is cached in memory: every read queries the database and every write is one BEGIN IMMEDIATE transaction that reads
 * what it checks (the ETag, the key, the quotas, the retained Idempotency-Keys, the audit backlog) and writes the
 * record, the key claim and the audit event together, or rolls all of it back. Statements are synchronous, so within
 * this process no other request runs between a transaction's check and its write.
 */
export class Collection {
  readonly name: string; readonly spec: NormalizedSpec;
  private db: StoreDatabase | undefined;
  private readonly auditor: CollectionAuditor | undefined;
  private get owned(): boolean { return this.spec.ownership === 'owner'; }
  constructor(name: string, spec: CollectionSpec, auditor?: CollectionAuditor) { this.name = name; this.spec = normalize(name, spec); this.auditor = auditor; }

  /**
   * Binds this view to the open database after validating every stored row against this declaration: a row that
   * violates it refuses activation (plain Error) instead of being served. The `key` column is derived data, so when
   * the declared key changed it is recomputed here, in one transaction; a duplicate value refuses activation.
   */
  open(db: StoreDatabase): void {
    const rows = db.all<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? ORDER BY seq`, this.name);
    if (rows.length > this.spec.maxRecords) throw new Error(`Collection ${this.name}: the store holds more records than maxRecords`);
    const keys = new Set<string>(), derived: [string, string | null][] = [];
    for (const row of rows) {
      let record: StoredRecord;
      try { record = this.parse(row); } catch (error) { throw new Error(error instanceof RowError ? error.message : `Collection ${this.name}: the store holds an invalid record`, { cause: error }); }
      const key = this.spec.key === undefined ? null : record[this.spec.key];
      if (key !== null && (typeof key !== 'string' || keys.has(key))) throw new Error(`Collection ${this.name}: the store holds an invalid record key`);
      if (key !== null) keys.add(key);
      derived.push([row.id, key]);
    }
    if (derived.some(([, key], index) => rows[index]!.key !== key)) db.transaction(() => {
      // Cleared first, so two records that swap values under a newly declared key never collide midway.
      db.run('UPDATE store_records SET key = NULL WHERE collection = ?', this.name);
      for (const [id, key] of derived) if (key !== null) db.run('UPDATE store_records SET key = ? WHERE collection = ? AND id = ?', key, this.name, id);
    });
    this.db = db;
  }
  /** Stops serving from the database; the registration closes it with its last activation. Idempotent. */
  close(): void { this.db = undefined; }

  private database(): StoreDatabase {
    if (!this.db?.open) throw new StoreError(503, 'storage_unavailable', 'The store is not available');
    return this.db;
  }
  /**
   * A row as a record, validated against this declaration. During a reload overlap the retiring view and its
   * replacement share the database, so a row written under the other declaration can reach this one: it answers
   * 503 (via `read`/`write`) instead of serving or overwriting a state it cannot represent.
   */
  private parse(row: RecordRow): StoredRecord {
    let fields: unknown;
    try { fields = JSON.parse(row.data); } catch { throw new RowError(`Collection ${this.name}: the store holds an invalid record`); }
    if (!isRecord(fields) || typeof row.id !== 'string' || typeof row.created_at !== 'string' || typeof row.updated_at !== 'string') throw new RowError(`Collection ${this.name}: the store holds an invalid record`);
    if (row.owner !== null && (typeof row.owner !== 'string' || !principalIdPattern.test(row.owner))) throw new RowError(`Collection ${this.name}: the store holds an invalid record owner`);
    // Serving owned records from a shared collection would hand every user's records to every caller.
    if (row.owner !== null && !this.owned) throw new RowError(`Collection ${this.name}: the store holds owned records but the collection is not declared with ownership: owner`);
    try { this.check(fields, false); } catch { throw new RowError(`Collection ${this.name}: a stored record no longer matches the declared fields`); }
    return { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.owner === null ? {} : { [OWNER_FIELD]: row.owner }), ...fields as StoredRecord };
  }
  private diverged(error: unknown): never {
    if (error instanceof StoreError) throw error;
    if (error instanceof RowError) throw new StoreError(503, 'storage_unavailable', 'This collection was redeclared by a reload; try again');
    throw new StoreError(503, 'storage_unavailable', 'The store could not read this collection'); // no path or SQLite detail
  }
  /** A consistent read (one deferred transaction), with storage and validation failures mapped to 503. */
  private read<T>(work: (db: StoreDatabase) => T): T {
    const db = this.database();
    try { return db.transaction(() => work(db), 'DEFERRED'); } catch (error) { return this.diverged(error); }
  }
  /**
   * One write transaction. `work` returns its result and whether it inserted an audit event; the audit drain is woken
   * only after the commit. A StoreError from `work` rolls back and is rethrown; anything else (a full disk, a lock
   * another process held past the busy timeout) rolls back and is a 503 with no detail.
   */
  private write<T>(work: (db: StoreDatabase) => { result: T; audited: boolean }): T {
    const db = this.database();
    let outcome: { result: T; audited: boolean };
    try { outcome = db.transaction(() => work(db)); }
    catch (error) {
      if (error instanceof StoreError) throw error;
      if (error instanceof RowError) throw new StoreError(503, 'storage_unavailable', 'This collection was redeclared by a reload; try again');
      throw new StoreError(503, 'storage_unavailable', 'The store could not save this change');
    }
    if (outcome.audited) this.auditor?.notify();
    return outcome.result;
  }

  /**
   * Validates caller input against the field schema. `full` applies defaults and required checks. With `unset` (a
   * partial update only), a `null` value asks to remove that field: allowed for an optional field and collected into
   * `unset`, refused for a required field and for an increment field (whose counter needs a number).
   */
  private check(input: Record<string, unknown>, full: boolean, unset?: string[]): StoredRecord {
    const errors: FieldErrors = {}, out: StoredRecord = {};
    for (const key of Object.keys(input)) if (!hasOwn(this.spec.fields, key) && !reserved(key)) errors[key.slice(0, 64)] = 'is not a declared field';
    for (const [key, spec] of Object.entries(this.spec.fields)) {
      if (!hasOwn(input, key) || input[key] === undefined) {
        if (!full) continue;
        if (spec.default !== undefined) out[key] = spec.default; else if (spec.required) errors[key] = 'is required';
        continue;
      }
      if (unset && input[key] === null) {
        if (spec.required) errors[key] = 'is required and cannot be cleared';
        else if (this.spec.increments.includes(key)) errors[key] = 'is an increment field and cannot be cleared';
        else unset.push(key);
        continue;
      }
      const problem = checkValue(spec, input[key]);
      if (problem) errors[key] = problem; else out[key] = input[key] as Scalar;
    }
    if (Object.keys(errors).length) throw new StoreError(400, 'invalid_record', 'Record does not match the collection fields', errors);
    return out;
  }
  private sized(record: StoredRecord): void {
    if (Buffer.byteLength(JSON.stringify(record)) > this.spec.maxRecordBytes) throw new StoreError(413, 'record_too_large', `Record exceeds ${this.spec.maxRecordBytes} bytes`);
  }
  private keyOf(record: StoredRecord): string | null { return this.spec.key === undefined ? null : record[this.spec.key] as string; }
  private insert(db: StoreDatabase, record: StoredRecord): void {
    db.run('INSERT INTO store_records(collection, id, owner, key, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
      this.name, record.id as string, (record[OWNER_FIELD] as string | undefined) ?? null, this.keyOf(record), record.createdAt as string, record.updatedAt as string, JSON.stringify(fieldsOf(record)));
  }
  /** Rewrites one record's mutable columns; `seq` (its place in creation order), `id`, `owner` and `created_at` stay. */
  private replaceRow(db: StoreDatabase, record: StoredRecord): void {
    db.run('UPDATE store_records SET key = ?, updated_at = ?, data = ? WHERE collection = ? AND id = ?', this.keyOf(record), record.updatedAt as string, JSON.stringify(fieldsOf(record)), this.name, record.id as string);
  }
  private keyTaken(db: StoreDatabase, key: string): boolean { return db.get('SELECT 1 AS found FROM store_records WHERE collection = ? AND key = ?', this.name, key) !== undefined; }
  /**
   * Inserts the outbox event for one write, inside the write's transaction: unchanged on an unaudited collection. At
   * the backlog cap the write is refused (and rolled back). The event names the changed fields, never their values; a
   * list too long for audit's metadata bound is cut and marked `truncated`. Returns whether an event was inserted.
   */
  private audited(db: StoreDatabase, action: AuditAction, id: string, fields: readonly string[], actor: string | undefined): boolean {
    if (!this.spec.audit) return false;
    // Activation refuses an audited collection without an active audit, so this is a wiring error, never a request's.
    if (!this.auditor) throw new StoreError(503, 'audit_unavailable', 'The audit log is unavailable');
    if (db.get<{ n: number }>('SELECT count(*) AS n FROM store_audit_outbox WHERE collection = ?', this.name)!.n >= AUDIT_BACKLOG) throw new StoreError(503, 'audit_backlog', 'The audit log is behind; try again later');
    const names = [...fields]; let truncated = false;
    while (Buffer.byteLength(JSON.stringify(names)) > AUDIT_FIELDS_BYTES) { names.pop(); truncated = true; }
    const event = this.auditor.validate({ id: randomUUID(), source: 'store', action: `store.record.${action}`, actor: actor ?? 'anonymous', subject: `${this.name}/${id}`, at: Date.now(), metadata: { collection: this.name, fields: names, ...(truncated ? { truncated: true } : {}) } });
    db.run('INSERT INTO store_audit_outbox(id, collection, at, event) VALUES (?, ?, ?, ?)', event.id, this.name, event.at, JSON.stringify(event));
    return true;
  }
  /** Declared fields whose value differs between two versions of a record (a removed field counts), in declaration order. */
  private changed(before: StoredRecord | undefined, after: StoredRecord | undefined): string[] { return Object.keys(this.spec.fields).filter(field => before?.[field] !== after?.[field]); }
  /**
   * Checks the key against the retained claims (inside the write's transaction, so two concurrent writes with one key
   * cannot both pass), then records it after the write and evicts all but the newest `maxKeys` of this collection.
   * Returns the function that stores the claim; a rollback removes it with everything else.
   */
  private claim(db: StoreDatabase, key: string | undefined): () => void {
    const config = this.idempotencyConfig(db, key);
    if (!key || !config) return () => undefined;
    return () => {
      db.run('INSERT INTO store_idempotency(collection, key, claimed_at) VALUES (?, ?, ?)', this.name, key, Date.now());
      db.run('DELETE FROM store_idempotency WHERE collection = ? AND seq <= (SELECT seq FROM store_idempotency WHERE collection = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)', this.name, this.name, config.maxKeys);
    };
  }
  private idempotencyConfig(db: StoreDatabase, key: string | undefined): IdempotencySpec | undefined {
    if (!key) return undefined;
    const config = this.spec.idempotency;
    if (!config) throw new StoreError(400, 'idempotency_not_enabled', 'This collection does not accept Idempotency-Key');
    if (db.get('SELECT 1 AS found FROM store_idempotency WHERE collection = ? AND key = ?', this.name, key) !== undefined) throw new StoreError(409, 'idempotency_duplicate', 'This mutation has already been processed');
    return config;
  }
  private writable(): void { if (this.spec.readOnly) throw new StoreError(405, 'read_only', 'This collection is read-only'); }
  /**
   * The caller's scope on an owned collection: its principal id, required (a 401 before any data is touched, which
   * `dispatch` also enforces). `undefined` on a shared collection, where every record is visible.
   */
  private scope(owner: string | undefined): string | undefined {
    if (!this.owned) return undefined;
    if (typeof owner !== 'string' || !principalIdPattern.test(owner)) throw new StoreError(401, 'principal_required', 'Sign in to use this collection');
    return owner;
  }
  /** The row filter for the caller's scope: the collection, and on an owned collection the caller's own records only (a record with no owner is in nobody's scope). */
  private where(scope: string | undefined): { sql: string; values: string[] } {
    return scope === undefined ? { sql: 'collection = ?', values: [this.name] } : { sql: 'collection = ? AND owner = ?', values: [this.name, scope] };
  }
  /** The record `id` in `scope` read inside the current transaction; another owner's (or nobody's) record is the same 404 as a missing id. */
  private current(db: StoreDatabase, id: string, scope: string | undefined): StoredRecord {
    const row = db.get<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? AND id = ?`, this.name, id);
    if (!row || (this.owned && row.owner !== scope)) throw new StoreError(404, 'not_found', 'No such record');
    return this.parse(row);
  }

  /**
   * Lists one page of the caller's scope. On an owned collection `total`, the page and the cursor are all computed
   * over the caller's own records only. Throws a 400 StoreError for an undeclared sort or filter name, a malformed
   * value or a cursor that does not belong to the sort.
   *
   * An unsorted, unfiltered page is a counted `LIMIT`/`OFFSET` query in creation order. A sorted or filtered one reads
   * only the id and the named fields of every record in scope (each field as its exact JSON text, so numbers and
   * strings compare exactly as the declared-type rules in query.ts say), orders and filters those in memory, and then
   * reads the page's records by id: bounded by `maxRecords`, never a scan of the full record bodies.
   */
  list(params: URLSearchParams, owner?: string): { items: StoredRecord[]; total: number; next?: string | number } {
    const scope = this.scope(owner), query = parseListQuery(this.spec, params), where = this.where(scope);
    return this.read(db => {
      if (!query.sort && !query.filters.length) {
        const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM store_records WHERE ${where.sql}`, ...where.values)!.n;
        const items = db.all<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE ${where.sql} ORDER BY seq LIMIT ? OFFSET ?`, ...where.values, query.limit, query.offset).map(row => this.parse(row));
        const end = query.offset + items.length;
        return { items, total, ...(end < total ? { next: end } : {}) };
      }
      const fields = [...new Set([...query.filters.map(([field]) => field), ...(query.sort ? [query.sort.field] : [])])];
      const rows = db.all<Record<string, string | null>>(`SELECT id, ${fields.map((_, index) => `data -> ? AS v${index}`).join(', ')} FROM store_records WHERE ${where.sql} ORDER BY seq`, ...fields.map(field => `$.${field}`), ...where.values);
      const projected = rows.map(row => {
        const record: StoredRecord = { id: row.id! };
        fields.forEach((field, index) => { const text = row[`v${index}`]; if (text !== null && text !== undefined) record[field] = JSON.parse(text) as Scalar; });
        return record;
      });
      const page = runList(projected, query);
      const ids = page.items.map(item => item.id as string);
      const found = new Map(db.all<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? AND id IN (SELECT value FROM json_each(?))`, this.name, JSON.stringify(ids)).map(row => [row.id, row]));
      return { ...page, items: ids.map(id => this.parse(found.get(id)!)) };
    });
  }
  /** A record in the caller's scope. A record that exists but belongs to someone else (or to nobody) is the same 404 as a missing id. */
  get(id: string, owner?: string): StoredRecord {
    const scope = this.scope(owner);
    return this.read(db => this.current(db, id, scope));
  }
  getByKey(key: string): StoredRecord {
    return this.read(db => {
      const row = db.get<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? AND key = ?`, this.name, key);
      const record = row && this.parse(row);
      if (!record || this.spec.key === undefined || record[this.spec.key] !== key) throw new StoreError(404, 'not_found', 'No such record');
      return record;
    });
  }
  /** The early Idempotency-Key check `dispatch` makes before reading the body; the write's transaction checks again. */
  validateIdempotency(key: string | undefined): IdempotencySpec | undefined {
    return this.read(db => this.idempotencyConfig(db, key));
  }

  /** Every write takes `actor`: the request principal's id, or `anonymous`. On an audited collection it is the event's actor. */
  create(input: unknown, idempotencyKey?: string, owner?: string, actor?: string): StoredRecord {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => {
      const claim = this.claim(db, idempotencyKey);
      if (!isRecord(input)) throw new StoreError(400, 'invalid_record', 'Body must be a JSON object');
      const clean = this.check(input, true);
      if (this.spec.key && this.keyTaken(db, clean[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
      // Checked before the collection-wide ceiling, and the message is fixed: it states neither the caller's count, any
      // other owner's count nor the collection total (urlcode#731).
      if (scope !== undefined && this.spec.maxRecordsPerOwner !== undefined && db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ? AND owner = ?', this.name, scope)!.n >= this.spec.maxRecordsPerOwner) throw new StoreError(409, 'owner_quota_exceeded', 'You hold the most records this collection allows each user');
      if (db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ?', this.name)!.n >= this.spec.maxRecords) throw new StoreError(409, 'collection_full', `Collection holds its maximum of ${this.spec.maxRecords} records`);
      const now = stamp(), record: StoredRecord = { id: randomUUID(), createdAt: now, updatedAt: now, ...(scope === undefined ? {} : { [OWNER_FIELD]: scope }), ...clean };
      this.sized(record);
      this.insert(db, record); claim();
      return { result: record, audited: this.audited(db, 'created', record.id as string, this.changed(undefined, record), actor) };
    });
  }
  /** `replace` (PUT) rebuilds every declared field with defaults; otherwise (PATCH) only supplied fields change, and a
   * supplied `null` removes an optional field (refused with a field error for a required or increment field).
   * `expectedEtag`, when given, must match the record's current ETag, read inside the same transaction as the write,
   * or the update is refused with 412 instead of silently overwriting a change the caller never saw. */
  update(id: string, input: unknown, replace: boolean, idempotencyKey?: string, expectedEtag?: string, owner?: string, actor?: string): StoredRecord {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => {
      const claim = this.claim(db, idempotencyKey);
      // Scoped before the ETag and body checks, so another owner's record answers exactly like a missing one.
      const current = this.current(db, id, scope);
      if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
      if (!isRecord(input)) throw new StoreError(400, 'invalid_record', 'Body must be a JSON object');
      const unset: string[] = [];
      const clean = this.check(input, replace, replace ? undefined : unset);
      if (!replace && Object.keys(clean).length === 0 && unset.length === 0) throw new StoreError(400, 'invalid_record', 'Body must set or clear at least one declared field');
      const kept = replace ? {} : Object.fromEntries(Object.entries(current).filter(([key]) => !reserved(key) && key !== OWNER_FIELD && !unset.includes(key)));
      // The owner is carried over from the stored record, never from the body (check() refuses an `_owner` key).
      const record: StoredRecord = { id: current.id!, createdAt: current.createdAt!, updatedAt: stamp(current.updatedAt as string), ...(current[OWNER_FIELD] === undefined ? {} : { [OWNER_FIELD]: current[OWNER_FIELD] }), ...kept, ...clean };
      if (this.spec.key && record[this.spec.key] !== current[this.spec.key] && this.keyTaken(db, record[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
      this.sized(record);
      this.replaceRow(db, record); claim();
      return { result: record, audited: this.audited(db, replace ? 'replaced' : 'updated', id, this.changed(current, record), actor) };
    });
  }
  remove(id: string, idempotencyKey?: string, expectedEtag?: string, owner?: string, actor?: string): void {
    const scope = this.scope(owner);
    this.writable();
    this.write(db => {
      const claim = this.claim(db, idempotencyKey);
      const current = this.current(db, id, scope);
      if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
      db.run('DELETE FROM store_records WHERE collection = ? AND id = ?', this.name, id); claim();
      return { result: undefined, audited: this.audited(db, 'deleted', id, this.changed(current, undefined), actor) };
    });
  }
  /** Public increment API (`POST .../increment/<field>`): refused on a `readOnly` collection like every other write. */
  increment(id: string, field: string, idempotencyKey?: string, owner?: string, actor?: string): StoredRecord {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => {
      const claim = this.claim(db, idempotencyKey);
      const record = this.incremented(db, id, field, scope);
      claim();
      return { result: record, audited: this.audited(db, 'incremented', id, [field], actor) };
    });
  }
  /**
   * Store-owned click-counter bookkeeping for a short-link redirect (dispatchShortLink in
   * store.ts), never reachable from the public record API. Per the #552 triage decision, this is
   * the one write a `readOnly` collection still accepts: `readOnly` is documented as closing the
   * public create/update/delete/increment surface, not as disabling the redirect's own click
   * count. It intentionally skips `writable()` and takes no Idempotency-Key — the short-link GET
   * that drives it isn't itself idempotency-scoped. It is never audited: anyone can drive it without credentials or
   * a budget, and audit's retention is shared with every producer's events, which a flood of clicks would prune.
   */
  recordClick(id: string, field: string): StoredRecord {
    // Short links need a key, which an owned collection refuses; this stays unreachable for owned records.
    if (this.owned) throw new StoreError(404, 'not_found', 'No such record');
    return this.write(db => ({ result: this.incremented(db, id, field, undefined), audited: false }));
  }
  private incremented(db: StoreDatabase, id: string, field: string, owner: string | undefined): StoredRecord {
    if (!this.spec.increments.includes(field)) throw new StoreError(404, 'not_found', 'No such increment');
    const current = this.current(db, id, owner), spec = this.spec.fields[field]!;
    const value = (current[field] as number) + 1, problem = checkValue(spec, value);
    if (problem) throw new StoreError(409, 'increment_limit', 'The increment would violate the declared field limits', { [field]: problem });
    const record: StoredRecord = { ...current, updatedAt: stamp(current.updatedAt as string), [field]: value };
    this.sized(record);
    this.replaceRow(db, record);
    return record;
  }
}
