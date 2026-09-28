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
const TRANSITION_LIMITS = { transitions: 16, fields: 8, stamps: 4 } as const;
const MOUNT = { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256 } as const;
const FIELD_NAME = '^[a-z][A-Za-z0-9_]{0,63}$';
const SCALAR = { oneOf: [{ type: 'string', maxLength: 256 }, { type: 'number' }, { type: 'boolean' }] } as const;
export interface FieldSpec {
  type: FieldType; required?: boolean; default?: Scalar;
  minLength?: number; maxLength?: number; format?: 'http-url'; enum?: (string | number)[]; minimum?: number; maximum?: number;
  /** Only a declared transition changes it: a create takes its default, and a body naming it is refused. */
  transitionOnly?: boolean;
}
interface IdempotencySpec { maxKeys: number }
/** Who may run a transition on an owned collection: the record's owner, or any principal except its owner. */
export type TransitionActor = 'owner' | 'others';
/**
 * One declared transition (#835): `POST <mount>/<id>/<name>` (or `POST <transition mount>/<id>` for `by: others`)
 * changes one record from the state `from` names to the constants `set` names and the store-owned values `stamp`
 * names, in one transaction, or refuses and writes nothing. It is a bounded state change, not an expression language.
 */
export interface TransitionSpec {
  /** Every named field must currently hold exactly this value, or the transition answers 409 transition_conflict. */
  from: Record<string, Scalar>;
  /** The constant values the transition writes. */
  set: Record<string, Scalar>;
  /** String fields the store fills: `actor` (the principal's id) or `now` (the commit time, ISO 8601). */
  stamp?: Record<string, 'actor' | 'now'>;
  /** Owned collections only: `owner` (default) or `others` (any principal but the record's owner; needs its own mount). */
  by?: TransitionActor;
  /** With `by: others` only, and required there: the separate mount serving `POST <mount>/<id>`, guarded by its own route. */
  mount?: string;
  /** A membership collection (`membership: true`): only principals it lists may run the transition. */
  members?: string;
}
/**
 * Cross-owner reads on an owned collection: members of the named membership collection list and read every owner's
 * records, read-only, on a separate mount guarded by a principal-providing policy.
 */
export interface ReadersSpec { mount: string; members: string }
export interface CollectionSpec {
  /** Required, except on a membership collection, which has none. */
  mount?: string; fields: Record<string, FieldSpec>;
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
  /** Declared conditional state changes by name (#835). */
  transitions?: Record<string, TransitionSpec>;
  /**
   * A membership list (#863): its `key` field holds principal ids, and a transition's or reader mount's `members` names
   * it. It has no mount and no HTTP API; the operator maintains it (`addMember`, or `StoreExports`).
   */
  membership?: boolean;
  /** On an owned collection: who may list and read every owner's records, and where. */
  readers?: ReadersSpec;
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
  type: 'object', additionalProperties: false, required: ['fields'],
  properties: {
    mount: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256, description: 'URL path of the collection\'s JSON API; it needs a route <mount>/* with extension: store (GET, HEAD, POST, PUT, PATCH, DELETE). Required, except on a membership collection, which has none.' },
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
        transitionOnly: { type: 'boolean', description: 'true: only a declared transition (its set or stamp) changes the field. A create stores its default (or leaves it unset), PUT keeps its value, and a POST, PUT or PATCH body naming it answers 400. Not combinable with required, key or increments. A screen shows it read-only.' },
      },
    } },
    maxRecords: { type: 'integer', minimum: 1, maximum: LIMITS.records, description: 'Records the collection may hold (default 1000); a create beyond it answers 409 collection_full.' },
    maxRecordBytes: { type: 'integer', minimum: 256, maximum: LIMITS.recordBytes, description: 'Largest serialized record in bytes (default 4096); larger answers 413.' },
    pageSize: { type: 'integer', minimum: 1, maximum: LIMITS.pageSize, description: 'Records per list page, and the cap on a list request\'s limit (default 50).' },
    readOnly: { type: 'boolean', description: 'true: the API serves only GET and HEAD (other methods answer 405); short-link click counting still works.' },
    key: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$', description: 'A required string field (maxLength at most 128, no default) whose caller-chosen value the collection keeps unique; a duplicate create answers 409 key_exists. Not allowed with ownership: owner.' },
    increments: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, description: 'Numeric fields with a numeric default that POST <mount>/<id>/increment/<field> raises by exactly one in one database transaction, within the field\'s bounds.' },
    idempotency: { description: 'Enables the Idempotency-Key header on POST, PUT, PATCH, DELETE, increment and transitions. A retry with a retained key and the same request (method, path, body) replays the first answer\'s status with the record as it is now; the same key on a different request answers 422 idempotency_key_reused. Without it the header answers 400 idempotency_not_enabled. A key is scoped to the request principal, or to the network client when there is none.', type: 'object', additionalProperties: false, required: ['maxKeys'], properties: { maxKeys: { type: 'integer', minimum: 1, maximum: IDEMPOTENCY_LIMITS.keys, description: 'Newest distinct keys the collection retains, across all callers; an evicted key is no longer protected and a retry with it runs again.' } } },
    sortable: { type: 'array', maxItems: QUERY_LIMITS.declared, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, description: 'Declared fields a list request may sort by (sort=<field> or sort=-<field>).' },
    filterable: { type: 'array', maxItems: QUERY_LIMITS.declared, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, description: 'Declared fields a list request may filter by equality (<field>=<value>); limit, cursor and sort cannot be filterable.' },
    ownership: { enum: ['shared', 'owner'], description: 'shared (default): every caller who reaches the mount sees every record. owner: each record belongs to the principal that created it, and every read and write is scoped to it; the mount must carry a principal-providing policy such as auth: true.' },
    maxRecordsPerOwner: { type: 'integer', minimum: 1, maximum: LIMITS.records, description: 'With ownership: owner only: records one principal may hold, at most maxRecords; beyond it a create answers 409 owner_quota_exceeded.' },
    audit: { type: 'boolean', description: 'true: every write is recorded in the audit log (field names and the principal, never values). Needs the audit extension; writes answer 503 audit_backlog while 1000 events wait to drain.' },
    transitions: { description: 'Declared conditional state changes by name: POST <mount>/<id>/<name> moves one record from the from values to the set (and stamp) values in one transaction, honouring If-Match and Idempotency-Key; a record not in the from state answers 409 transition_conflict and nothing is written. Not an expression language.', type: 'object', maxProperties: TRANSITION_LIMITS.transitions, propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' }, additionalProperties: {
      type: 'object', additionalProperties: false, required: ['from', 'set'],
      properties: {
        from: { type: 'object', minProperties: 1, maxProperties: TRANSITION_LIMITS.fields, propertyNames: { pattern: FIELD_NAME }, additionalProperties: SCALAR, description: 'Declared fields and the exact value each must currently hold; each value must be valid for its field.' },
        set: { type: 'object', minProperties: 1, maxProperties: TRANSITION_LIMITS.fields, propertyNames: { pattern: FIELD_NAME }, additionalProperties: SCALAR, description: 'Declared fields and the constant value the transition writes; not the collection key.' },
        stamp: { type: 'object', maxProperties: TRANSITION_LIMITS.stamps, propertyNames: { pattern: FIELD_NAME }, additionalProperties: { enum: ['actor', 'now'] }, description: 'String fields the store fills: actor (the principal id, needs maxLength of at least 128) or now (the commit time in ISO 8601, needs maxLength of at least 24). No enum or format.' },
        by: { enum: ['owner', 'others'], description: 'With ownership: owner only. owner (default): only the record\'s owner, on the collection mount. others: any principal except the record\'s owner (the owner gets 403 own_record_refused), served on its own mount.' },
        mount: { ...MOUNT, description: 'Required with by: others, refused otherwise: the transition is served as POST <mount>/<id> on a route <mount>/* with extension: store (POST) and a principal-providing policy.' },
        members: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'A membership collection (membership: true): only principals it lists may run the transition; anyone else gets 403 membership_required before any record is read. Checked inside the write transaction, so a membership change applies to the next request.' },
      },
    } },
    membership: { type: 'boolean', description: 'true: a membership list. Its key field holds principal ids (one record per member); transitions and readers name it in members. It has no mount and no HTTP API: the operator maintains it with addMember/removeMember or trusted extension code (StoreExports). Needs key; takes no mount, ownership, transitions, readers, increments, idempotency, sortable, filterable, readOnly or audit.' },
    readers: { description: 'With ownership: owner only: members of a membership collection list and read every owner\'s records, read-only, as GET <mount> (with the collection\'s limit, cursor, sort and filters) and GET <mount>/<id>. Owners keep their own view on the collection mount. The stored owner is never shown.', type: 'object', additionalProperties: false, required: ['mount', 'members'], properties: {
      mount: { ...MOUNT, description: 'A separate mount: a route <mount>/* with extension: store (GET, HEAD) and a principal-providing policy.' },
      members: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'A membership collection: anyone it does not list gets 403 membership_required before any record is read.' },
    } },
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
  mount?: string; fields: Record<string, FieldSpec>; maxRecords: number; maxRecordBytes: number; pageSize: number; readOnly: boolean;
  key?: string; increments: string[]; idempotency?: IdempotencySpec; sortable: string[]; filterable: string[]; ownership: Ownership;
  maxRecordsPerOwner?: number; audit: boolean; transitions: Record<string, NormalizedTransition>;
  membership: boolean; readers?: ReadersSpec;
}
/** A validated transition. `by` is `any` on a shared collection, whose records have no owner to compare. */
export interface NormalizedTransition { from: Record<string, Scalar>; set: Record<string, Scalar>; stamp: Record<string, 'actor' | 'now'>; by: TransitionActor | 'any'; mount?: string; members?: string }

/** Validates the declared transitions against the collection's fields and ownership; throws plain Errors for the operator. */
function transitionsOf(name: string, spec: CollectionSpec, ownership: Ownership, key: string | undefined): Record<string, NormalizedTransition> {
  const out: Record<string, NormalizedTransition> = {};
  for (const [transition, declared] of Object.entries(spec.transitions ?? {})) {
    const where = `Collection ${name}: transition ${transition}`;
    if (transition === 'increment') throw new Error(`${where}: the name increment is reserved`);
    const values = (kind: 'from' | 'set'): Record<string, Scalar> => {
      for (const [field, value] of Object.entries(declared[kind])) {
        const fieldSpec = hasOwn(spec.fields, field) ? spec.fields[field] : undefined;
        if (!fieldSpec) throw new Error(`${where}: ${kind} names ${field.slice(0, 64)}, which is not a declared field`);
        const problem = checkValue(fieldSpec, value);
        if (problem) throw new Error(`${where}: ${kind} value for ${field} ${problem}`);
        if (kind === 'set' && field === key) throw new Error(`${where}: set cannot change the collection key`);
      }
      return { ...declared[kind] };
    };
    const stamp = { ...declared.stamp ?? {} };
    for (const [field, source] of Object.entries(stamp)) {
      const fieldSpec = hasOwn(spec.fields, field) ? spec.fields[field] : undefined;
      if (!fieldSpec) throw new Error(`${where}: stamp names ${field.slice(0, 64)}, which is not a declared field`);
      if (hasOwn(declared.set, field)) throw new Error(`${where}: ${field} is both set and stamped`);
      if (field === key) throw new Error(`${where}: stamp cannot change the collection key`);
      const needed = source === 'actor' ? 128 : 24;
      if (fieldSpec.type !== 'string' || fieldSpec.enum || fieldSpec.format || (fieldSpec.maxLength ?? LIMITS.stringLength) < needed || (fieldSpec.minLength ?? 0) > 1) throw new Error(`${where}: stamp field ${field} must be a string with no enum or format and maxLength of at least ${needed}`);
    }
    const by = declared.by;
    if (ownership === 'shared' && by !== undefined) throw new Error(`${where}: by needs ownership: owner`);
    if (by === 'others' && declared.mount === undefined) throw new Error(`${where}: by: others needs its own mount`);
    if (by !== 'others' && declared.mount !== undefined) throw new Error(`${where}: mount is only for by: others`);
    if (declared.mount === spec.mount) throw new Error(`${where}: mount must differ from the collection mount`);
    out[transition] = { from: values('from'), set: values('set'), stamp, by: ownership === 'shared' ? 'any' : by ?? 'owner', ...(declared.mount === undefined ? {} : { mount: declared.mount }), ...(declared.members === undefined ? {} : { members: declared.members }) };
  }
  return out;
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
  const membership = spec.membership === true;
  if (membership) {
    // A membership list is authorization data: served over a collection API, anyone the route admits could add
    // themselves or enumerate members. It has no mount, and nothing that only makes sense with one.
    const refused = (['mount', 'ownership', 'transitions', 'readers', 'increments', 'idempotency', 'sortable', 'filterable', 'readOnly', 'audit'] as const).filter(option => spec[option] !== undefined);
    if (refused.length) throw new Error(`Collection ${name}: a membership collection takes no ${refused.join(', ')}`);
    if (key === undefined) throw new Error(`Collection ${name}: a membership collection needs a key, the field holding each member's principal id`);
  } else if (spec.mount === undefined) throw new Error(`Collection ${name}: mount is required`);
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
  const transitions = transitionsOf(name, spec, ownership, key);
  const readers = spec.readers;
  if (readers !== undefined) {
    // Readers widen an owned collection's view to members; a shared collection's mount already shows every record.
    if (ownership !== 'owner') throw new Error(`Collection ${name}: readers needs ownership: owner`);
    if (readers.mount === spec.mount) throw new Error(`Collection ${name}: the readers mount must differ from the collection mount`);
    if (Object.values(transitions).some(transition => transition.mount === readers.mount)) throw new Error(`Collection ${name}: the readers mount must differ from every transition mount`);
  }
  for (const [field, f] of Object.entries(spec.fields)) {
    if (!f.transitionOnly) continue;
    if (f.required) throw new Error(`Collection ${name}: field ${field} cannot be both required and transitionOnly`);
    if (field === key || increments.includes(field)) throw new Error(`Collection ${name}: field ${field} is the key or an increment and cannot be transitionOnly`);
    if (!Object.values(transitions).some(transition => hasOwn(transition.set, field) || hasOwn(transition.stamp, field))) throw new Error(`Collection ${name}: field ${field} is transitionOnly but no transition sets or stamps it`);
  }
  return { ...(spec.mount === undefined ? {} : { mount: spec.mount }), fields: spec.fields, ...(key === undefined ? {} : { key }), increments, ...(spec.idempotency === undefined ? {} : { idempotency: spec.idempotency }), sortable: queryable('sortable'), filterable: queryable('filterable'), ownership, ...(perOwner === undefined ? {} : { maxRecordsPerOwner: perOwner }), maxRecords, maxRecordBytes: spec.maxRecordBytes ?? 4096, pageSize: spec.pageSize ?? 50, readOnly: spec.readOnly ?? false, audit: spec.audit ?? false, transitions, membership, ...(readers === undefined ? {} : { readers: { mount: readers.mount, members: readers.members } }) };
}

/** What an audited collection needs from the audit extension: its pure event validator, and a wake-up for the drain after a commit that wrote an event. */
export interface CollectionAuditor { validate(value: unknown): AuditEvent; notify(): void }
type AuditAction = 'created' | 'replaced' | 'updated' | 'deleted' | 'incremented' | 'transitioned';
/**
 * An `Idempotency-Key` a write carries (#835): `key`, the header value hashed with the caller's scope (the principal,
 * or the network client when there is none), and `fingerprint`, the hash of the request it was first used for.
 */
export interface Retry { key: string; fingerprint: string }
/**
 * A write's answer: its success status, the record (absent after a delete) and whether it replays a retained
 * `Idempotency-Key`. A replay carries the first answer's status and the record as it is now.
 */
export interface Written { status: number; record: StoredRecord | undefined; replayed: boolean }
/** What one write step inside a transaction produced: the record it left and whether it inserted an audit event. */
export interface Step { record: StoredRecord | undefined; audited: boolean }
/**
 * Maps a failure inside a store transaction to what a caller may see: a StoreError is kept, a row this declaration
 * cannot represent or a SQLite failure (a full disk, a lock held past the busy timeout) is a 503 with no detail, and
 * with `rethrowOthers` anything else (a trusted host transaction's own error) is rethrown unchanged.
 */
export function storageFailure(error: unknown, rethrowOthers: boolean): never {
  if (error instanceof StoreError) throw error;
  if (error instanceof RowError) throw new StoreError(503, 'storage_unavailable', 'This collection was redeclared by a reload; try again');
  if (rethrowOthers && !(error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR')) throw error;
  throw new StoreError(503, 'storage_unavailable', 'The store could not save this change');
}

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

  /** The open database this view serves from; a closed one is a 503. Host transactions (records.ts) open theirs here. */
  database(): StoreDatabase {
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
  /** A consistent read (one deferred transaction), with storage and validation failures mapped to 503. */
  private read<T>(work: (db: StoreDatabase) => T): T {
    const db = this.database();
    try { return db.transaction(() => work(db), 'DEFERRED'); }
    catch (error) {
      if (error instanceof StoreError || error instanceof RowError) return storageFailure(error, false);
      throw new StoreError(503, 'storage_unavailable', 'The store could not read this collection'); // no path or SQLite detail
    }
  }
  /**
   * One write transaction. `work` returns its answer and whether it inserted an audit event; the audit drain is woken
   * only after the commit. A StoreError from `work` rolls back and is rethrown; anything else (a full disk, a lock
   * another process held past the busy timeout) rolls back and is a 503 with no detail.
   */
  private write(work: (db: StoreDatabase) => { result: Written; audited: boolean }): Written {
    const db = this.database();
    let outcome: { result: Written; audited: boolean };
    try { outcome = db.transaction(() => work(db)); } catch (error) { return storageFailure(error, false); }
    if (outcome.audited) this.notifyAudit();
    return outcome.result;
  }
  /** Wakes the audit drain after a commit that inserted one of this collection's events. */
  notifyAudit(): void { this.auditor?.notify(); }

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
      const problem = checkValue(spec, input[key]) ?? (this.spec.membership && key === this.spec.key && !principalIdPattern.test(input[key] as string) ? 'must be a principal id' : undefined);
      if (problem) errors[key] = problem; else out[key] = input[key] as Scalar;
    }
    if (Object.keys(errors).length) throw new StoreError(400, 'invalid_record', 'Record does not match the collection fields', errors);
    return out;
  }
  /** A body may not name a `transitionOnly` field: only a declared transition changes it. */
  private guarded(input: Record<string, unknown>): void {
    const errors: FieldErrors = {};
    for (const [field, spec] of Object.entries(this.spec.fields)) if (spec.transitionOnly && hasOwn(input, field)) errors[field] = 'is changed only by a transition';
    if (Object.keys(errors).length) throw new StoreError(400, 'invalid_record', 'Record does not match the collection fields', errors);
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
  private audited(db: StoreDatabase, action: AuditAction, id: string, fields: readonly string[], actor: string | undefined, transition?: string): boolean {
    if (!this.spec.audit) return false;
    // Activation refuses an audited collection without an active audit, so this is a wiring error, never a request's.
    if (!this.auditor) throw new StoreError(503, 'audit_unavailable', 'The audit log is unavailable');
    if (db.get<{ n: number }>('SELECT count(*) AS n FROM store_audit_outbox WHERE collection = ?', this.name)!.n >= AUDIT_BACKLOG) throw new StoreError(503, 'audit_backlog', 'The audit log is behind; try again later');
    const names = [...fields]; let truncated = false;
    while (Buffer.byteLength(JSON.stringify(names)) > AUDIT_FIELDS_BYTES) { names.pop(); truncated = true; }
    const event = this.auditor.validate({ id: randomUUID(), source: 'store', action: `store.record.${action}`, actor: actor ?? 'anonymous', subject: `${this.name}/${id}`, at: Date.now(), metadata: { collection: this.name, ...(transition === undefined ? {} : { transition }), fields: names, ...(truncated ? { truncated: true } : {}) } });
    db.run('INSERT INTO store_audit_outbox(id, collection, at, event) VALUES (?, ?, ?, ?)', event.id, this.name, event.at, JSON.stringify(event));
    return true;
  }
  /** Declared fields whose value differs between two versions of a record (a removed field counts), in declaration order. */
  private changed(before: StoredRecord | undefined, after: StoredRecord | undefined): string[] { return Object.keys(this.spec.fields).filter(field => before?.[field] !== after?.[field]); }
  /**
   * Result-aware `Idempotency-Key` handling inside the write's transaction (#835). Without a key, `work` just runs.
   * With one, the retained claim is read under the write lock, so of racing requests with one key exactly one runs
   * `work`: a claim with the same request fingerprint replays (the first answer's status, and the record `reread`
   * finds now, in the caller's scope: a record since deleted or moved out of it is the ordinary 404), and a claim with
   * a different fingerprint is 422 `idempotency_key_reused`. Neither writes anything. Otherwise `work` runs and the
   * claim, with its result, is inserted in the same transaction; the newest `maxKeys` claims of the collection stay.
   * A refused or failed write rolls back and retains nothing, so its retry is evaluated again.
   */
  private idempotent(db: StoreDatabase, retry: Retry | undefined, status: number, reread: (id: string) => StoredRecord, work: () => Step): { result: Written; audited: boolean } {
    if (retry === undefined) { const step = work(); return { result: { status, record: step.record, replayed: false }, audited: step.audited }; }
    const config = this.idempotencyConfig(retry.key)!;
    const claimed = db.get<{ fingerprint: string; status: number; record_id: string | null }>('SELECT fingerprint, status, record_id FROM store_idempotency WHERE collection = ? AND key = ?', this.name, retry.key);
    if (claimed) {
      if (claimed.fingerprint !== retry.fingerprint) throw new StoreError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
      return { result: { status: claimed.status, record: claimed.status === 204 || claimed.record_id === null ? undefined : reread(claimed.record_id), replayed: true }, audited: false };
    }
    const step = work();
    db.run('INSERT INTO store_idempotency(collection, key, fingerprint, status, record_id, claimed_at) VALUES (?, ?, ?, ?, ?, ?)', this.name, retry.key, retry.fingerprint, status, (step.record?.id as string | undefined) ?? null, Date.now());
    db.run('DELETE FROM store_idempotency WHERE collection = ? AND seq <= (SELECT seq FROM store_idempotency WHERE collection = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)', this.name, this.name, config.maxKeys);
    return { result: { status, record: step.record, replayed: false }, audited: step.audited };
  }
  /** The collection's idempotency settings when `key` is given; a key on a collection that did not enable them is a 400. */
  idempotencyConfig(key: string | undefined): IdempotencySpec | undefined {
    if (key === undefined) return undefined;
    if (!this.spec.idempotency) throw new StoreError(400, 'idempotency_not_enabled', 'This collection does not accept Idempotency-Key');
    return this.spec.idempotency;
  }
  private writable(): void { if (this.spec.readOnly) throw new StoreError(405, 'read_only', 'This collection is read-only'); }
  /**
   * The caller's scope on an owned collection: its principal id, required (a 401 before any data is touched, which
   * `dispatch` also enforces). `undefined` on a shared collection, where every record is visible.
   */
  private scope(owner: string | undefined): string | undefined {
    if (!this.owned) return undefined;
    return this.principal(owner);
  }
  private principal(id: string | undefined): string {
    if (typeof id !== 'string' || !principalIdPattern.test(id)) throw new StoreError(401, 'principal_required', 'Sign in to use this collection');
    return id;
  }
  /**
   * The row filter for the caller's scope: the collection, and on an owned collection the caller's own records only (a
   * record with no owner is in nobody's scope). `null` is a reader's scope: every owned record.
   */
  private where(scope: string | undefined | null): { sql: string; values: string[] } {
    if (scope === null) return { sql: 'collection = ? AND owner IS NOT NULL', values: [this.name] };
    return scope === undefined ? { sql: 'collection = ?', values: [this.name] } : { sql: 'collection = ? AND owner = ?', values: [this.name, scope] };
  }
  /** The record `id` in `scope` read inside the current transaction; another owner's (or nobody's) record is the same 404 as a missing id. */
  private current(db: StoreDatabase, id: string, scope: string | undefined): StoredRecord {
    const row = db.get<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? AND id = ?`, this.name, id);
    if (!row || (this.owned && row.owner !== scope)) throw new StoreError(404, 'not_found', 'No such record');
    return this.parse(row);
  }
  /** For a `by: others` transition: any owned record (a record with no owner is nobody's, so a 404 like a missing id). */
  private anyOwned(db: StoreDatabase, id: string): StoredRecord {
    const row = db.get<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? AND id = ?`, this.name, id);
    if (!row || row.owner === null) throw new StoreError(404, 'not_found', 'No such record');
    return this.parse(row);
  }

  /**
   * The membership gate (#863): with `members` (a membership collection's name), `principal` must be one of its keys,
   * or the request is 403 `membership_required`. It runs first inside the caller's transaction, before any record of
   * this collection is read, so a non-member gets the same answer for an existing id and a missing one, and a
   * membership change committed before the transaction began applies to it.
   */
  private admit(db: StoreDatabase, members: string | undefined, principal: string): void {
    if (members !== undefined && db.get('SELECT 1 AS found FROM store_records WHERE collection = ? AND key = ?', members, principal) === undefined) throw new StoreError(403, 'membership_required', 'You are not allowed to do this');
  }
  /**
   * The readers mount (#863), for a member of `readers.members`: one page of every owner's records (`total`, sort,
   * filters and cursor over all of them; a record with no owner is nobody's and is left out). The principal (401)
   * and the membership gate (403) come first, in the same read transaction, before the query is parsed or any
   * record is read. Read-only.
   */
  listAcross(params: URLSearchParams, principal: string | undefined): { items: StoredRecord[]; total: number; next?: string | number } {
    return this.across(principal, db => this.listIn(db, parseListQuery(this.spec, params), null));
  }
  /** One owned record for a member of `readers.members` (the gate as `listAcross`); a missing or malformed id is 404. */
  getAcross(id: string, principal: string | undefined): StoredRecord {
    return this.across(principal, db => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new StoreError(404, 'not_found', 'No such record');
      return this.anyOwned(db, id);
    });
  }
  private across<T>(principal: string | undefined, work: (db: StoreDatabase) => T): T {
    const readers = this.spec.readers;
    if (!readers) throw new StoreError(404, 'not_found', 'No such collection');
    const caller = this.principal(principal);
    return this.read(db => { this.admit(db, readers.members, caller); return work(db); });
  }

  /**
   * Lists one page of the caller's scope. On an owned collection `total`, the page and the cursor are all computed
   * over the caller's own records only. Throws a 400 StoreError for an undeclared sort or filter name, a malformed
   * value or a cursor that does not belong to the sort.
   */
  list(params: URLSearchParams, owner?: string): { items: StoredRecord[]; total: number; next?: string | number } {
    const scope = this.scope(owner), query = parseListQuery(this.spec, params);
    return this.read(db => this.listIn(db, query, scope));
  }
  /**
   * One page inside an open transaction. An unsorted, unfiltered page is a counted `LIMIT`/`OFFSET` query in creation
   * order. A sorted or filtered one reads only the id and the named fields of every record in scope (each field as its
   * exact JSON text, so numbers and strings compare exactly as the declared-type rules in query.ts say), orders and
   * filters those in memory, and then reads the page's records by id: bounded by `maxRecords`, never a scan of the
   * full record bodies.
   */
  private listIn(db: StoreDatabase, query: ReturnType<typeof parseListQuery>, scope: string | undefined | null): { items: StoredRecord[]; total: number; next?: string | number } {
    const where = this.where(scope);
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

  /** Every write takes `actor`: the request principal's id, or `anonymous`. On an audited collection it is the event's actor. */
  create(input: unknown, retry?: Retry, owner?: string, actor?: string): Written {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => this.idempotent(db, retry, 201, id => this.current(db, id, scope), () => this.createIn(db, input, scope, actor)));
  }
  /** `replace` (PUT) rebuilds every declared field with defaults; otherwise (PATCH) only supplied fields change, and a
   * supplied `null` removes an optional field (refused with a field error for a required or increment field).
   * `expectedEtag`, when given, must match the record's current ETag, read inside the same transaction as the write,
   * or the update is refused with 412 instead of silently overwriting a change the caller never saw. */
  update(id: string, input: unknown, replace: boolean, retry?: Retry, expectedEtag?: string, owner?: string, actor?: string): Written {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => this.idempotent(db, retry, 200, found => this.current(db, found, scope), () => this.updateIn(db, id, input, replace, expectedEtag, scope, actor)));
  }
  remove(id: string, retry?: Retry, expectedEtag?: string, owner?: string, actor?: string): Written {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => this.idempotent(db, retry, 204, found => this.current(db, found, scope), () => this.removeIn(db, id, expectedEtag, scope, actor)));
  }
  /** Public increment API (`POST .../increment/<field>`): refused on a `readOnly` collection like every other write. */
  increment(id: string, field: string, retry?: Retry, owner?: string, actor?: string): Written {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => this.idempotent(db, retry, 200, found => this.current(db, found, scope), () => {
      const record = this.incremented(db, id, field, scope);
      return { record, audited: this.audited(db, 'incremented', id, [field], actor) };
    }));
  }
  /**
   * Runs the declared transition `name` on record `id` for `principal` (#835). An unknown name is a 404. Checked in
   * this order, all inside the one write transaction: with `members`, the membership gate (403); the retained
   * `Idempotency-Key`; the record in the transition's
   * scope (404); for `by: others`, that the caller is not its owner (403); `If-Match` (412); every `from` value (409
   * `transition_conflict`). Only then are the `set` values, the `stamp` values and `updatedAt` written with the claim
   * and the audit event. Any refusal writes nothing.
   */
  transition(id: string, name: string, retry?: Retry, expectedEtag?: string, principal?: string, actor?: string): Written {
    const transition = hasOwn(this.spec.transitions, name) ? this.spec.transitions[name]! : undefined;
    if (!transition) throw new StoreError(404, 'not_found', 'No such transition');
    // `principal` is checked before anything is read: owner scoping, the caller an others transition compares, or a member.
    const caller = this.caller(transition, principal);
    this.writable();
    // The membership gate comes before the retained key, so a removed member's retry is refused rather than replayed.
    return this.write(db => {
      if (caller !== undefined) this.admit(db, transition.members, caller);
      return this.idempotent(db, retry, 200, found => this.transitionTarget(db, found, transition, caller), () => this.transitionIn(db, id, name, expectedEtag, caller, actor));
    });
  }
  /** Who runs a transition: any caller on an ungated shared one, otherwise a principal (401 without one). */
  private caller(transition: NormalizedTransition, principal: string | undefined): string | undefined {
    return transition.by === 'any' && transition.members === undefined ? principal : this.principal(principal);
  }
  recordClick(id: string, field: string): StoredRecord {
    // Store-owned click-counter bookkeeping for a short-link redirect (dispatchShortLink in store.ts), never reachable
    // from the public record API. Per the #552 triage decision, this is the one write a `readOnly` collection still
    // accepts: `readOnly` closes the public create/update/delete/increment surface, not the redirect's own click
    // count. It skips `writable()` and takes no Idempotency-Key. It is never audited: anyone can drive it without
    // credentials or a budget, and audit's retention is shared with every producer's events, which a flood of clicks
    // would prune. Short links need a key, which an owned collection refuses; this stays unreachable for owned records.
    if (this.owned) throw new StoreError(404, 'not_found', 'No such record');
    return this.write(db => ({ result: { status: 200, record: this.incremented(db, id, field, undefined), replayed: false }, audited: false })).record!;
  }

  // The write steps. Each runs inside a transaction its caller opened (`write` above, or a host transaction in
  // records.ts) and returns the record it left and whether it inserted an audit event. They are the only code that
  // changes a record, so the HTTP API, the records export and host transactions apply one set of rules.

  /** The record `id` in the owner's scope, inside an open transaction (a host transaction's `get`). */
  getIn(db: StoreDatabase, id: string, owner: string | undefined): StoredRecord { return this.current(db, id, this.scope(owner)); }
  /** One page inside an open transaction (a host transaction's `list`). */
  listPageIn(db: StoreDatabase, params: URLSearchParams, owner: string | undefined): { items: StoredRecord[]; total: number; next?: string | number } {
    const scope = this.scope(owner);
    return this.listIn(db, parseListQuery(this.spec, params), scope);
  }
  createIn(db: StoreDatabase, input: unknown, scope: string | undefined, actor: string | undefined): Step {
    this.writable();
    if (!isRecord(input)) throw new StoreError(400, 'invalid_record', 'Body must be a JSON object');
    this.guarded(input);
    const clean = this.check(input, true);
    if (this.spec.key && this.keyTaken(db, clean[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
    // Checked before the collection-wide ceiling, and the message is fixed: it states neither the caller's count, any
    // other owner's count nor the collection total (urlcode#731).
    if (scope !== undefined && this.spec.maxRecordsPerOwner !== undefined && db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ? AND owner = ?', this.name, scope)!.n >= this.spec.maxRecordsPerOwner) throw new StoreError(409, 'owner_quota_exceeded', 'You hold the most records this collection allows each user');
    if (db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ?', this.name)!.n >= this.spec.maxRecords) throw new StoreError(409, 'collection_full', `Collection holds its maximum of ${this.spec.maxRecords} records`);
    const now = stamp(), record: StoredRecord = { id: randomUUID(), createdAt: now, updatedAt: now, ...(scope === undefined ? {} : { [OWNER_FIELD]: scope }), ...clean };
    this.sized(record);
    this.insert(db, record);
    return { record, audited: this.audited(db, 'created', record.id as string, this.changed(undefined, record), actor) };
  }
  /** Creates in the owner's scope inside an open transaction (a host transaction's `create`). */
  createFor(db: StoreDatabase, input: unknown, owner: string | undefined, actor: string | undefined): Step { return this.createIn(db, input, this.scope(owner), actor); }
  updateIn(db: StoreDatabase, id: string, input: unknown, replace: boolean, expectedEtag: string | undefined, scope: string | undefined, actor: string | undefined): Step {
    this.writable();
    // Scoped before the ETag and body checks, so another owner's record answers exactly like a missing one.
    const current = this.current(db, id, scope);
    if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
    if (!isRecord(input)) throw new StoreError(400, 'invalid_record', 'Body must be a JSON object');
    this.guarded(input);
    const unset: string[] = [];
    const clean = this.check(input, replace, replace ? undefined : unset);
    if (!replace && Object.keys(clean).length === 0 && unset.length === 0) throw new StoreError(400, 'invalid_record', 'Body must set or clear at least one declared field');
    // PUT rebuilds the declared fields from the body and defaults, except transitionOnly ones, which keep their value.
    const only = (key: string) => this.spec.fields[key]?.transitionOnly === true;
    if (replace) for (const key of Object.keys(clean)) if (only(key)) delete clean[key];
    const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !reserved(key) && key !== OWNER_FIELD && (replace ? only(key) : !unset.includes(key))));
    // The owner is carried over from the stored record, never from the body (check() refuses an `_owner` key).
    const record: StoredRecord = { id: current.id!, createdAt: current.createdAt!, updatedAt: stamp(current.updatedAt as string), ...(current[OWNER_FIELD] === undefined ? {} : { [OWNER_FIELD]: current[OWNER_FIELD] }), ...kept, ...clean };
    if (this.spec.key && record[this.spec.key] !== current[this.spec.key] && this.keyTaken(db, record[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
    this.sized(record);
    this.replaceRow(db, record);
    return { record, audited: this.audited(db, replace ? 'replaced' : 'updated', id, this.changed(current, record), actor) };
  }
  /** A partial update in the owner's scope inside an open transaction (a host transaction's `update`). */
  updateFor(db: StoreDatabase, id: string, patch: unknown, expectedEtag: string | undefined, owner: string | undefined, actor: string | undefined): Step { return this.updateIn(db, id, patch, false, expectedEtag, this.scope(owner), actor); }
  removeIn(db: StoreDatabase, id: string, expectedEtag: string | undefined, scope: string | undefined, actor: string | undefined): Step {
    this.writable();
    const current = this.current(db, id, scope);
    if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
    db.run('DELETE FROM store_records WHERE collection = ? AND id = ?', this.name, id);
    return { record: undefined, audited: this.audited(db, 'deleted', id, this.changed(current, undefined), actor) };
  }
  /** Deletes in the owner's scope inside an open transaction (a host transaction's `remove`). */
  removeFor(db: StoreDatabase, id: string, expectedEtag: string | undefined, owner: string | undefined, actor: string | undefined): Step { return this.removeIn(db, id, expectedEtag, this.scope(owner), actor); }
  /** The record a transition acts on: in the owner's scope, any owned record for `by: others`, any record on a shared collection. */
  private transitionTarget(db: StoreDatabase, id: string, transition: NormalizedTransition, caller: string | undefined): StoredRecord {
    return transition.by === 'others' ? this.anyOwned(db, id) : this.current(db, id, transition.by === 'owner' ? caller : undefined);
  }
  transitionIn(db: StoreDatabase, id: string, name: string, expectedEtag: string | undefined, principal: string | undefined, actor: string | undefined): Step {
    this.writable();
    const transition = hasOwn(this.spec.transitions, name) ? this.spec.transitions[name]! : undefined;
    if (!transition) throw new StoreError(404, 'not_found', 'No such transition');
    const caller = this.caller(transition, principal);
    if (caller !== undefined) this.admit(db, transition.members, caller);
    const current = this.transitionTarget(db, id, transition, caller);
    // The owner learns nothing here it does not already know: the record is its own.
    if (transition.by === 'others' && current[OWNER_FIELD] === caller) throw new StoreError(403, 'own_record_refused', 'This transition cannot be applied to your own record');
    if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
    if (Object.entries(transition.from).some(([field, value]) => current[field] !== value)) throw new StoreError(409, 'transition_conflict', 'The record is not in a state this transition applies to');
    const updatedAt = stamp(current.updatedAt as string);
    const stamped = Object.fromEntries(Object.entries(transition.stamp).map(([field, source]) => [field, source === 'now' ? updatedAt : actor ?? 'anonymous']));
    const record: StoredRecord = { ...current, updatedAt, ...transition.set, ...stamped };
    this.sized(record);
    this.replaceRow(db, record);
    return { record, audited: this.audited(db, 'transitioned', id, this.changed(current, record), actor, name) };
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
