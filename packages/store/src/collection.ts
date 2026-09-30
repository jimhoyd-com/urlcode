import { createHash, randomUUID } from 'node:crypto';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { bodyIssues, bodySchemaDialect, compileBodySchema } from '@jimhoyd/urlcode/body-schema';
import type { BodySchema, BodySchemaIssue, CompiledBodySchema } from '@jimhoyd/urlcode/body-schema';
import type { AuditEvent } from '@jimhoyd/urlcode-audit';
import { QUERY_LIMITS, parseListQuery, queryableString, runList } from './query.ts';
import { STORE_SCHEMA_VERSION, declarationOf, liveServer } from './database.ts';
import type { StoreDatabase } from './database.ts';
import { listInSql, listPlan } from './listing.ts';
import type { ListPlan } from './listing.ts';

/** Reserved names the store owns on every record. */
export const RESERVED_FIELDS = ['id', 'createdAt', 'updatedAt'] as const;
/**
 * The stored owner of a record in an owned collection (`ownership: owner`, urlcode#331): the opaque principal id the
 * store stamped on create. It is kept in the database's `owner` column only. It never appears in a response, a body
 * naming it is refused like any undeclared property, and no request can change it. The leading underscore cannot be a
 * declared property name, so it never collides with one.
 */
export const OWNER_FIELD = '_owner';
/** How a collection scopes its records: `shared` (the default; every caller who reaches the mount sees every record) or `owner` (each record belongs to the principal that created it). */
export type Ownership = 'shared' | 'owner';
export const LIMITS = { properties: 64, records: 10_000, recordBytes: 65_536, pageSize: 200 } as const;
const IDEMPOTENCY_LIMITS = { keys: 1_000, keyLength: 128 } as const;
/**
 * Undelivered audit events one collection may hold in the outbox table (audit's `auditOutboxLimits.perCollection`).
 * At the cap a write on an audited collection is refused with 503 `audit_backlog` and nothing is written.
 */
export const AUDIT_BACKLOG = 1_000;
/** Audit metadata stays under audit's 4096-byte bound: the property list is cut here and marked truncated. */
const AUDIT_FIELDS_BYTES = 3_584;

/** The value type of one record property: a record holds scalars only. */
export type PropertyType = 'string' | 'integer' | 'number' | 'boolean';
export type Scalar = string | number | boolean;
const PROPERTY_TYPES: readonly PropertyType[] = ['string', 'integer', 'number', 'boolean'];
const TRANSITION_LIMITS = { transitions: 16, fields: 8, stamps: 4 } as const;
const INTERVAL_LIMITS = { within: 4, when: 8 } as const;
/** A `length` or `step` for date-time bounds: an ISO 8601 duration in whole days, hours, minutes and seconds. */
const DURATION = '^P(?:([0-9]{1,5})D)?(?:T(?:([0-9]{1,6})H)?(?:([0-9]{1,8})M)?(?:([0-9]{1,10})S)?)?$';
/** The size of a `DURATION` in milliseconds (a UTC day is always 86,400 seconds), or undefined for an empty or zero one. */
function durationMs(text: string): number | undefined {
  const match = new RegExp(DURATION).exec(text);
  if (!match || text.endsWith('T')) return undefined;
  const [days, hours, minutes, seconds] = match.slice(1).map(part => Number(part ?? 0)) as [number, number, number, number];
  const ms = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return ms > 0 && Number.isSafeInteger(ms) ? ms : undefined;
}
const TRANSFER_LIMITS = { transfers: 8 } as const;
const RECORD_ID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/**
 * The body every declared transfer takes (#902): two record ids and a positive integer amount no larger than a safe
 * integer, nothing else. Generated, never declared, so every transfer of every collection validates alike.
 */
export const transferBodySchema = {
  type: 'object', additionalProperties: false, required: ['from', 'to', 'amount'],
  properties: {
    from: { type: 'string', maxLength: 36, pattern: RECORD_ID, description: 'The record debited; on an owned collection one the caller owns.' },
    to: { type: 'string', maxLength: 36, pattern: RECORD_ID, description: 'The record credited: another record of the same collection.' },
    amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'The whole number moved, in the property\'s units (minor units for a currency). A fraction is refused.' },
  },
} as const;
const compiledTransferBody = compileBodySchema(transferBodySchema as unknown as BodySchema);
/** A transfer body validated against `transferBodySchema`, and its two ids distinct; otherwise 422 `invalid_transfer`. */
export function transferBody(input: unknown): TransferBody {
  const issues = bodyIssues(compiledTransferBody, input);
  if (!issues.length && (input as TransferBody).from === (input as TransferBody).to) issues.push({ pointer: '/to', keyword: 'transfer', message: 'must differ from from' });
  if (issues.length) throw new StoreError(422, 'invalid_transfer', 'The transfer request is not valid', { issues });
  const { from, to, amount } = input as TransferBody;
  return { from, to, amount };
}
/** A collection name, as the store's configuration schema admits it; an interval constraint embeds it in its index. */
const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** The only date-time an interval bound takes: RFC 3339 in UTC (`Z`) with at most millisecond precision. */
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** A grid origin (#945): RFC 3339 with `Z` or a fixed `±hh:mm` offset, at most millisecond precision. */
const OFFSET_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(?:Z|([+-])(\d{2}):(\d{2}))$/;
/** Readers mounts one collection may declare (#944). */
export const READER_LIMITS = { mounts: 8 } as const;
const MOUNT = { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256 } as const;
const FIELD_NAME = '^[a-z][A-Za-z0-9_]{0,63}$';
const SCALAR = { oneOf: [{ type: 'string', maxLength: 256 }, { type: 'number' }, { type: 'boolean' }] } as const;
/** A state (#952): readOnly properties, each with one value or a list of values it may hold. */
const stateSchema = (description: string) => ({ type: 'object', minProperties: 1, maxProperties: TRANSITION_LIMITS.fields, propertyNames: { pattern: FIELD_NAME }, additionalProperties: { anyOf: [SCALAR, { type: 'array', minItems: 1, maxItems: TRANSITION_LIMITS.transitions, uniqueItems: true, items: SCALAR }] }, description }) as const;
/**
 * One record property: a JSON Schema 2020-12 schema in core's request body profile with exactly one scalar `type`.
 * What the store does with a property beyond its value shape (a default, transition-only) is the collection's
 * `defaults` and `readOnlyProperties`, never a keyword here.
 */
export interface PropertySchema { type: PropertyType; [keyword: string]: unknown }
/**
 * A collection's record schema: a JSON Schema 2020-12 object schema in core's request body profile (the same
 * profile, validator and 422 issue shape as `request.body.<METHOD>.schema`), restricted to a flat object of scalar
 * properties. `additionalProperties: false` is required and written out, so the schema says what the store enforces.
 * It is exactly a request body schema, so the same schema can be a project named schema (top-level `schemas:`)
 * that a route body and an MCP tool name too.
 */
export interface RecordSchema {
  $schema?: string; $comment?: string; title?: string; description?: string;
  type: 'object'; additionalProperties: false; properties: Record<string, PropertySchema>; required?: string[];
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
  /** Every named property must currently hold exactly this value, or the transition answers 409 transition_conflict. */
  from: Record<string, Scalar>;
  /** The constant values the transition writes. */
  set: Record<string, Scalar>;
  /** String properties the store fills: `actor` (the principal's id) or `now` (the commit time, ISO 8601). */
  stamp?: Record<string, 'actor' | 'now'>;
  /** Owned collections only: `owner` (default) or `others` (any principal but the record's owner; needs its own mount). */
  by?: TransitionActor;
  /** With `by: others` only, and required there: the separate mount serving `POST <mount>/<id>`, guarded by its own route. */
  mount?: string;
  /** A membership collection (`membership: true`): only principals it lists may run the transition. */
  members?: string;
}
/**
 * One cross-owner read mount on an owned collection: members of the named membership collection (or, on a
 * projection without `members`, every principal) list and read every owner's records, read-only, on a separate mount
 * guarded by a principal-providing policy. A collection declares them by name (#944), each with its own gate and view.
 */
export interface ReadersSpec {
  mount: string;
  /** A membership collection: only principals it lists may read. Required unless `properties` narrows what is shown. */
  members?: string;
  /** Include each record's owner (its opaque principal id) as `_owner` in this mount's answers, and nowhere else. */
  showOwner?: boolean;
  /**
   * A projection (#929): the declared properties this mount shows. Each record is answered as `id` and these only (no
   * timestamps, no other property), sort and filters take only these, and without `members` every principal the
   * mount's route admits may read them: a directory of record ids by name, with balances kept private.
   */
  properties?: string[];
}
/** A validated readers mount. */
export interface NormalizedReaders { mount: string; members?: string; showOwner: boolean; properties?: string[] }
/** Who may create a record (#929): with `members`, only principals that membership collection lists. */
export interface CreateSpec { members?: string }
export interface CollectionSpec {
  /** Required, except on a membership collection, which has none. */
  mount?: string;
  /**
   * The record schema: a `RecordSchema` written inline, or the name of one of the project's named schemas (top-level
   * `schemas:`, `ExtensionActivation.schemas`) that satisfies the same restrictions. The store-owned facts below name
   * its properties.
   */
  schema: RecordSchema | string;
  /** Values stored on create (and on PUT) for properties the body omits; each must satisfy its property's schema. */
  defaults?: Record<string, Scalar>;
  /**
   * Properties only a declared transition (its `set` or `stamp`) or transfer (its `amount`) changes: a create stores the default (or leaves them
   * unset), PUT keeps the stored value, and a body naming one answers 422. The OpenAPI record marks them readOnly.
   */
  readOnlyProperties?: string[];
  maxRecords?: number; maxRecordBytes?: number; pageSize?: number; readOnly?: boolean;
  /** One required bounded string property that callers choose and the collection keeps unique. */
  key?: string;
  /** Numeric properties callers may atomically increase by one through the collection endpoint. */
  increments?: string[];
  /** Optional durable Idempotency-Key retention for mutating HTTP requests. */
  idempotency?: IdempotencySpec;
  /** Declared properties a list request may sort by (`sort=<property>` or `sort=-<property>`). */
  sortable?: string[];
  /** Declared properties a list request may filter by equality (`<property>=<value>`). */
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
   * table in the same transaction as the record, and audit drains it from there. Property names only, never values.
   * On a membership collection an added or removed member is `store.membership.added`/`removed`, naming the member.
   */
  audit?: boolean;
  /** Declared conditional state changes by name (#835). */
  transitions?: Record<string, TransitionSpec>;
  /**
   * A membership list (#863): its `key` property holds principal ids, and a transition's or reader mount's `members`
   * names it. It has no mount and no HTTP API; the operator maintains it (`addMember`, or `StoreExports`).
   */
  membership?: boolean;
  /** On an owned collection: the named mounts on which others list and read every owner's records, each with who and what (#944). */
  readers?: Record<string, ReadersSpec>;
  /** Who may create a record: `{members}` admits only a membership collection's principals (403 before anything is written). */
  create?: CreateSpec;
  /** A non-overlap constraint (#902): no two records in one scope hold overlapping half-open `[start, end)` intervals. */
  intervals?: IntervalSpec;
  /** Declared transfers by name (#902): `POST <mount>/transfers/<name>` moves an integer amount between two records. */
  transfers?: Record<string, TransferSpec>;
  /** The states in which `PUT` and `PATCH` may change a record (#952); in any other a write body is 409 `record_locked`. */
  editable?: StateSpec;
  /** The states in which a record may be deleted (#952); in any other a delete is 409 `record_locked`. */
  deletable?: StateSpec;
  /** String properties no two records hold alike, across owners on an owned collection (#953); a duplicate is 409 `value_taken`. */
  unique?: string[];
}
/**
 * A record state (#952), in the shape of a transition's `from`: each named property (a `readOnlyProperties` one, so
 * only a transition moves it) and the value, or one of the values, it must hold.
 */
export type StateSpec = Record<string, Scalar | Scalar[]>;
/** A validated state: every named property with the values it may hold. */
export type NormalizedState = Record<string, Scalar[]>;
/**
 * One declared transfer (#902): `POST <mount>/transfers/<name>` with `{from, to, amount}` subtracts `amount` from the
 * `from` record's `amount` property and adds it to the `to` record's, in one transaction, so the sum over the
 * collection never changes. On an owned collection the caller may debit only a record it owns; the credited record
 * may be anyone's. Integers only: a currency is counted in minor units.
 */
export interface TransferSpec {
  /** A required integer property with an integer default, not an increment or interval property: the balance moved. */
  amount: string;
  /** The lowest value the debited record may be left holding (default 0: no overdraft). */
  min?: number;
  /** A membership collection (`membership: true`): only principals it lists may run the transfer. */
  members?: string;
}
/** A validated transfer. */
export interface NormalizedTransfer { amount: string; min: number; members?: string }
/** A transfer request body, as the generated schema admits it. */
export interface TransferBody { from: string; to: string; amount: number }
/** Where an interval constraint applies: every record of the collection, or each owner's records on their own. */
export type IntervalScope = 'collection' | 'owner';
/**
 * A declared non-overlap constraint (#902): among the records it applies to (those holding every `when` value), no two
 * in the same scope with equal `within` values may hold overlapping half-open `[start, end)` intervals. Checked inside
 * every write's transaction against an index, so the check never reads the whole collection.
 */
export interface IntervalSpec {
  /** A required property holding the interval's start: a UTC date-time string (`format: date-time`) or a number. */
  start: string;
  /** A required property of the same kind holding its end, which must be after `start`. */
  end: string;
  /** Required properties that partition the constraint (a room, a calendar): intervals conflict only when all are equal. */
  within?: string[];
  /** `collection` (default): every record blocks every other, across owners. `owner`: each owner's records only. */
  scope?: IntervalScope;
  /** Only records holding exactly these values take part (for example `{status: booked}`, so a cancelled one frees its slot). */
  when?: Record<string, Scalar>;
  /**
   * The exact length every interval has (#929): an ISO 8601 duration such as `PT1H` for date-time bounds, a positive
   * integer for integer bounds. `end - start` must equal it, or the write is 422.
   */
  length?: string | number;
  /**
   * The grid both bounds sit on (#929): each must be a whole multiple of `step` counted from `origin`, so `PT1H` means
   * on the hour, UTC (by default). With `length`, `length` must be a multiple of `step`.
   */
  step?: string | number;
  /**
   * Where the `step` grid counts from (#945): a date-time (`Z` or a fixed offset such as `+05:30`) for date-time bounds,
   * an integer for integer bounds. Default: 1970-01-01T00:00:00Z, or 0. A fixed offset, never a time zone's rules.
   */
  origin?: string | number;
}
/** A declared `length` or `step`: what the declaration wrote, and its size in the bounds' units (milliseconds for a date-time). */
export interface IntervalDuration { declared: string | number; units: number }
/**
 * A declared grid origin (#945): what the declaration wrote, and its residue modulo the step in the bounds' units, so
 * a bound is on the grid when its own residue equals it. Residues keep the arithmetic exact for any safe integer.
 */
export interface IntervalOrigin { declared: string | number; residue: number }
export type StoredRecord = Record<string, Scalar>;
type FieldErrors = Record<string, string>;
/**
 * What a refusal carries besides its code: query parameter names with fixed messages, record schema issues, or (on a
 * 409 `interval_conflict`) the conflicting record's id, only when the caller may read that record.
 */
export interface StoreErrorDetails { fields?: FieldErrors; issues?: readonly BodySchemaIssue[]; conflict?: { id: string } }

/**
 * Thrown for caller mistakes; carries names and fixed messages only, never a submitted value. A record that breaks
 * the collection schema is 422 `invalid_record` with `issues` in core's body-validation issue shape; a list query is
 * 400 `invalid_query` with `fields` naming the offending parameters.
 */
export class StoreError extends Error {
  readonly status: number; readonly code: string; readonly fields: FieldErrors | undefined; readonly issues: readonly BodySchemaIssue[] | undefined; readonly conflict: { id: string } | undefined;
  constructor(status: number, code: string, message: string, details: StoreErrorDetails = {}) { super(message); this.status = status; this.code = code; this.fields = details.fields; this.issues = details.issues; this.conflict = details.conflict; }
}
/**
 * Refuses deleting a record that still holds a transfer balance (#928): on a collection declaring `transfers`, the sum
 * of each amount property never changes, so a record leaves only at 0. 409 `balance_not_zero`, naming no amount; every
 * delete path (HTTP DELETE, a host transaction's `remove`, the operator's ownerless-delete) calls it
 * before writing anything.
 */
export function refuseBalance(spec: Pick<NormalizedSpec, 'transfers'>, record: Readonly<StoredRecord>): void {
  for (const transfer of Object.values(spec.transfers)) {
    const held = record[transfer.amount];
    if (held !== undefined && held !== 0) throw new StoreError(409, 'balance_not_zero', 'The record still holds a balance; transfer it to another record before deleting it');
  }
}
/** The 422 for a record that breaks the collection schema (or a store rule on a named property). */
export const invalidRecord = (issues: readonly BodySchemaIssue[]): StoreError => new StoreError(422, 'invalid_record', 'Record does not match the collection schema', { issues });

const describedKeywords = 'type, enum, const, minLength, maxLength, pattern, format, minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, allOf, anyOf, oneOf, not, title, description, $comment, examples, deprecated';
/** JSON Schema for the store-owned part of one property (its one scalar `type`); every other profile keyword is checked by core's profile. */
const propertySchema = {
  type: 'object', required: ['type'],
  description: `One record property: a JSON Schema 2020-12 schema in the request body profile with one scalar type, using ${describedKeywords}. Its default and transition-only marking are the collection's defaults and readOnlyProperties, not keywords here.`,
  properties: {
    type: { enum: PROPERTY_TYPES, description: 'The one scalar type the property holds; records hold scalars only.' },
  },
} as const;

/** JSON Schema for one collection declaration; `normalize` enforces the cross-field rules it cannot express. */
export const collectionSchema = {
  type: 'object', additionalProperties: false, required: ['schema'],
  properties: {
    mount: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256, description: 'URL path of the collection\'s JSON API; it needs a route <mount>/* with extension: store (GET, HEAD, POST, PUT, PATCH, DELETE). Required, except on a membership collection, which has none.' },
    schema: { anyOf: [{ type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$', description: 'The name of one of the project\'s named schemas (top-level schemas:), which a route body and an MCP tool can name too. It must satisfy the same restrictions as an inline record schema, or activation refuses it.' }, {
      description: 'The record schema: a JSON Schema 2020-12 object schema in the same bounded profile as request.body.<METHOD>.schema, validated by the same validator, with a flat set of scalar properties. A body that breaks it answers 422 invalid_record with the same issue list a body-schema route answers. id, createdAt and updatedAt are reserved and store-owned.',
      type: 'object', additionalProperties: false, required: ['type', 'properties', 'additionalProperties'],
      properties: {
        $schema: { const: bodySchemaDialect, description: 'Optional; only the JSON Schema 2020-12 dialect.' },
        $comment: { type: 'string', maxLength: 4096, description: 'A note for readers; not validated.' },
        title: { type: 'string', maxLength: 4096, description: 'A short name for the record type.' },
        description: { type: 'string', maxLength: 4096, description: 'What a record of this collection is.' },
        type: { const: 'object', description: 'Always object: a record is a JSON object.' },
        additionalProperties: { const: false, description: 'Always false, written out: a body naming a property the schema does not declare is refused.' },
        required: { type: 'array', maxItems: LIMITS.properties, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'Properties every record must carry: a create or PUT without one (and without a default) answers 422, and PATCH cannot clear one.' },
        properties: { type: 'object', minProperties: 1, maxProperties: LIMITS.properties, propertyNames: { pattern: FIELD_NAME }, additionalProperties: propertySchema, description: 'The record properties by name, each a scalar schema. A string property needs maxLength (or an enum) to be sortable or filterable.' },
      },
    }], description: 'The record schema, inline or by the name of a project named schema (top-level schemas:). Either way it is a request body schema restricted to a flat record: the collection\'s defaults and readOnlyProperties carry what the store does beyond value shape.' },
    defaults: { type: 'object', maxProperties: LIMITS.properties, propertyNames: { pattern: FIELD_NAME }, additionalProperties: { oneOf: [{ type: 'string', maxLength: 65_536 }, { type: 'number' }, { type: 'boolean' }] }, description: 'Declared properties and the value stored on create (and on PUT) when the body omits them; each value must satisfy its property\'s schema. A required property with a default may be omitted from a create.' },
    readOnlyProperties: { type: 'array', maxItems: LIMITS.properties, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'Declared properties only a declared transition (its set or stamp) or transfer (its amount) changes. A create stores the default (or leaves them unset), PUT keeps the stored value, and a POST, PUT or PATCH body naming one answers 422. A required one needs a default, and some transition must set or stamp it or some transfer move it. Not the key or an increment. The OpenAPI record marks them readOnly.' },
    maxRecords: { type: 'integer', minimum: 1, maximum: LIMITS.records, description: 'Records the collection may hold (default 1000); a create beyond it answers 409 collection_full.' },
    maxRecordBytes: { type: 'integer', minimum: 256, maximum: LIMITS.recordBytes, description: 'Largest serialized record in bytes (default 4096); larger answers 413.' },
    pageSize: { type: 'integer', minimum: 1, maximum: LIMITS.pageSize, description: 'Records per list page, and the cap on a list request\'s limit (default 50).' },
    readOnly: { type: 'boolean', description: 'true: the API serves only GET and HEAD (other methods answer 405); short-link click counting still works.' },
    key: { type: 'string', pattern: FIELD_NAME, description: 'A required string property (maxLength at most 128, no default) whose caller-chosen value the collection keeps unique; a duplicate create answers 409 key_exists. Not allowed with ownership: owner (use unique).' },
    increments: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'Numeric properties with a numeric default that POST <mount>/<id>/increment/<property> raises by exactly one in one database transaction, within the property\'s schema (409 increment_limit otherwise).' },
    idempotency: { description: 'Enables the Idempotency-Key header on POST, PUT, PATCH, DELETE, increment, transitions and transfers. A retry with a retained key and the same request (method, path, body) replays the first answer\'s status with the record as it is now; the same key on a different request answers 422 idempotency_key_reused. Without it the header answers 400 idempotency_not_enabled. A key is scoped to the request principal, or to the network client when there is none.', type: 'object', additionalProperties: false, required: ['maxKeys'], properties: { maxKeys: { type: 'integer', minimum: 1, maximum: IDEMPOTENCY_LIMITS.keys, description: 'Newest distinct keys the collection retains, across all callers; an evicted key is no longer protected and a retry with it runs again.' } } },
    sortable: { type: 'array', maxItems: QUERY_LIMITS.declared, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'Declared properties a list request may sort by (sort=<property> or sort=-<property>).' },
    filterable: { type: 'array', maxItems: QUERY_LIMITS.declared, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'Declared properties a list request may filter by equality (<property>=<value>); a value the property\'s schema refuses answers 400 invalid_query. limit, cursor and sort cannot be filterable.' },
    ownership: { enum: ['shared', 'owner'], description: 'shared (default): every caller who reaches the mount sees every record. owner: each record belongs to the principal that created it, and every read and write is scoped to it; the mount must carry a principal-providing policy such as auth: true.' },
    maxRecordsPerOwner: { type: 'integer', minimum: 1, maximum: LIMITS.records, description: 'With ownership: owner only: records one principal may hold, at most maxRecords; beyond it a create answers 409 owner_quota_exceeded.' },
    audit: { type: 'boolean', description: 'true: every write is recorded in the audit log (property names and the principal, never values), in the same transaction as the write. On a membership collection, adding or removing a member (from any path, the operator CLI included) records store.membership.added or store.membership.removed with the member\'s principal id in the subject. Needs the audit extension; writes answer 503 audit_backlog while 1000 events wait to drain.' },
    transitions: { description: 'Declared conditional state changes by name: POST <mount>/<id>/<name> moves one record from the from values to the set (and stamp) values in one transaction, honouring If-Match and Idempotency-Key; a record not in the from state answers 409 transition_conflict and nothing is written. Not an expression language.', type: 'object', maxProperties: TRANSITION_LIMITS.transitions, propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' }, additionalProperties: {
      type: 'object', additionalProperties: false, required: ['from', 'set'],
      properties: {
        from: { type: 'object', minProperties: 1, maxProperties: TRANSITION_LIMITS.fields, propertyNames: { pattern: FIELD_NAME }, additionalProperties: SCALAR, description: 'Declared properties and the exact value each must currently hold; each value must satisfy its property\'s schema.' },
        set: { type: 'object', minProperties: 1, maxProperties: TRANSITION_LIMITS.fields, propertyNames: { pattern: FIELD_NAME }, additionalProperties: SCALAR, description: 'Declared properties and the constant value the transition writes; each must satisfy its property\'s schema. Not the collection key.' },
        stamp: { type: 'object', maxProperties: TRANSITION_LIMITS.stamps, propertyNames: { pattern: FIELD_NAME }, additionalProperties: { enum: ['actor', 'now'] }, description: 'String properties the store fills: actor (the principal id, needs maxLength of at least 128) or now (the commit time in ISO 8601, needs maxLength of at least 24). No enum, const, pattern, format or composition keyword on them.' },
        by: { enum: ['owner', 'others'], description: 'With ownership: owner only. owner (default): only the record\'s owner, on the collection mount. others: any principal except the record\'s owner (the owner gets 403 own_record_refused), served on its own mount.' },
        mount: { ...MOUNT, description: 'Required with by: others, refused otherwise: the transition is served as POST <mount>/<id> on a route <mount>/* with extension: store (POST) and a principal-providing policy.' },
        members: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'A membership collection (membership: true): only principals it lists may run the transition; anyone else gets 403 membership_required before any record is read. Checked inside the write transaction, so a membership change applies to the next request.' },
      },
    } },
    membership: { type: 'boolean', description: 'true: a membership list. Its key property holds principal ids (one record per member); transitions and readers name it in members. It has no mount and no HTTP API: the operator maintains it with urlcode-store members or trusted extension code (StoreExports); a member\'s key cannot be changed, only removed and added. Needs key; takes no mount, ownership, transitions, transfers, readers, create, increments, idempotency, sortable, filterable or readOnly. With audit: true every added and removed member is recorded.' },
    readers: { description: 'With ownership: owner only: named read-only mounts on which others list and read every owner\'s records, each as GET <mount> (with the collection\'s limit, cursor, sort and filters) and GET <mount>/<id>, and each with its own gate and view, for example a members-gated reviewer mount beside a projected directory. Owners keep their own view on the collection mount. The stored owner is shown only with showOwner. With properties, a mount shows only id and those properties, and members becomes optional: a directory every signed-in principal may search without seeing the rest of any record.', type: 'object', minProperties: 1, maxProperties: READER_LIMITS.mounts, propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' }, additionalProperties: { type: 'object', additionalProperties: false, required: ['mount'], properties: {
      mount: { ...MOUNT, description: 'A separate mount: a route <mount>/* with extension: store (GET, HEAD) and a principal-providing policy.' },
      members: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'A membership collection: anyone it does not list gets 403 membership_required before any record is read. Required unless properties is given; without it every principal the route admits may read the listed properties, and showOwner is refused.' },
      showOwner: { type: 'boolean', description: 'true: every record this mount answers carries _owner, the opaque principal id of the owner (for auth, the user id; never an email or name), so a member can tell requesters apart. Needs members: activation refuses it on a mount without a gate, so only members ever receive it. Only this mount shows it: the owner\'s mount, transitions and StoreExports never do.' },
      properties: { type: 'array', minItems: 1, maxItems: LIMITS.properties, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'A projection: the declared properties this mount shows. Each record is answered as id and these properties only (no createdAt, updatedAt or other property); sort and filters take only these; its ETag is of what it shows, so it changes only when a listed property does (it is not the record\'s own ETag, which If-Match takes); may lists only transitions whose from names only these. Use it for a directory (a wallet\'s name, never its balance).' },
    } } },
    create: { description: 'Who may create a record. members: only principals a membership collection lists may POST <mount> (and create through StoreExports or a host transaction); anyone else gets 401 principal_required without a principal, or 403 membership_required inside the write transaction before the Idempotency-Key or anything else is read or written.', type: 'object', additionalProperties: false, required: ['members'], properties: {
      members: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'A membership collection (membership: true): only principals it lists may create.' },
    } },
    intervals: { description: 'A non-overlap constraint for scheduling: among the records it applies to, no two in the same scope (and with equal within values) may hold overlapping half-open [start, end) intervals, so an interval ending where another starts is allowed. Checked inside the write transaction of every create, PUT, PATCH and transition against an index, never a scan of the collection; an overlap answers 409 interval_conflict and nothing is written, so a move that would overlap keeps the record where it was. Activation refuses stored records that already overlap. Not on a membership collection.', type: 'object', additionalProperties: false, required: ['start', 'end'], properties: {
      start: { type: 'string', pattern: FIELD_NAME, description: 'A required property holding the start: a string with format: date-time, whose values must be UTC (ending in Z) with at most millisecond precision and compare as instants, or an integer or number.' },
      end: { type: 'string', pattern: FIELD_NAME, description: 'A required property of the same kind as start holding the end; a record whose end is not after its start answers 422 invalid_record.' },
      within: { type: 'array', maxItems: INTERVAL_LIMITS.within, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'Required properties that partition the constraint (a room, a resource): two intervals conflict only when every one of these is equal.' },
      scope: { enum: ['collection', 'owner'], description: 'collection (default): every record blocks every other, across owners on an owned collection (another owner\'s conflicting record is never named). owner: with ownership: owner only, each owner\'s records are constrained among themselves.' },
      when: { type: 'object', minProperties: 1, maxProperties: INTERVAL_LIMITS.when, propertyNames: { pattern: FIELD_NAME }, additionalProperties: SCALAR, description: 'Only records holding exactly these values take part, for example {status: booked} so a cancelled booking frees its slot; each value must satisfy its property\'s schema. Without it every record takes part.' },
      length: { oneOf: [{ type: 'string', pattern: DURATION, maxLength: 40 }, { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }], description: 'The exact length of every interval: an ISO 8601 duration in whole days, hours, minutes and seconds (PT1H, PT30M, P1D) for date-time bounds, a positive integer for integer bounds. A record whose end is not exactly start plus length answers 422 invalid_record. Applies to every record, whatever when says.' },
      step: { oneOf: [{ type: 'string', pattern: DURATION, maxLength: 40 }, { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }], description: 'The grid the bounds sit on: start and end must each be a whole multiple of step, counted from origin (by default 1970-01-01T00:00:00Z for date-times, so PT1H is on the hour, UTC, and PT15M on the quarter hour; 0 for integers), or the write answers 422 invalid_record. Without length it makes every interval a whole number of steps; with length, length must be a multiple of step.' },
      origin: { oneOf: [{ type: 'string', pattern: OFFSET_INSTANT.source, maxLength: 40 }, { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }], description: 'With step only: the instant (date-time bounds) or integer (integer bounds) the step grid counts from. A date-time may carry a fixed offset: step PT1H with origin 1970-01-01T00:00:00+05:30 is on the local hour at UTC+05:30, and P1D with it is local midnight there. It is a fixed offset, not a time zone: nothing follows daylight saving, so a daily grid in a zone that changes its offset moves by the change twice a year (an hourly grid does not when the change is a whole hour). Record bounds stay UTC.' },
    } },
    transfers: { description: 'Declared transfers by name: POST <mount>/transfers/<name> with the JSON body {from, to, amount} (two distinct record ids and a positive whole number) subtracts amount from the from record\'s amount property and adds it to the to record\'s in one transaction, so the sum over the collection never changes (a record is created at 0 and deleted only at 0, else 409 balance_not_zero); a debit that would leave from below min answers 409 insufficient_balance and nothing is written; a credit the to record cannot take (only a row stored outside the declaration) answers one fixed 409 transfer_conflict. On an owned collection the caller may debit only its own record and may credit any owned record (a transfer between owners); on a shared collection anyone who reaches the mount may move between any two records, so gate it with members or the route. Honours If-Match (on from) and Idempotency-Key; audited as store.record.transferred on both records. Not on a membership collection.', type: 'object', maxProperties: TRANSFER_LIMITS.transfers, propertyNames: { pattern: '^[a-z][a-z0-9_-]{0,63}$' }, additionalProperties: {
      type: 'object', additionalProperties: false, required: ['amount'],
      properties: {
        amount: { type: 'string', pattern: FIELD_NAME, description: 'A required integer property with default 0 (a currency in minor units), listed under readOnlyProperties: the balance moved. Only transfers change it: not an increment, not set or stamped by a transition and not named by intervals. A record still holding a nonzero balance cannot be deleted (409 balance_not_zero). Its schema bounds a balance from below only (type, minimum, exclusiveMinimum and annotations; no maximum, exclusiveMaximum, multipleOf, enum, const or combinator), and every write measures maxRecordBytes with the amount at its widest, so nothing about the credited record\'s balance decides a transfer\'s answer.' },
        min: { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, description: 'The lowest value the debited record may be left holding (default 0: no overdraft). A negative min on a members-gated transfer is an issuer: its records may go below zero, which is the supply outstanding, and the sum still never changes. On an owned collection a negative min needs members (activation refuses it without, since every signed-in principal could mint); on a shared one the route is the gate. The lowest min times maxRecords must stay within the safe integers, so no balance can leave them.' },
        members: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'A membership collection (membership: true): only principals it lists may run the transfer; anyone else gets 403 membership_required before any record is read.' },
      },
    } },
    editable: stateSchema('The states in which PUT and PATCH may change a record, in the shape of a transition\'s from: each property must hold its value, or one of its listed values, for example {status: [draft]}. In any other state a PUT or PATCH (on HTTP, StoreExports or a host transaction) and POST <mount>/<id>/increment/<property> answer 409 record_locked and write nothing, decided under the write lock. Each property must be in readOnlyProperties, so only a transition moves a record in or out. Transitions, transfers and the click count of a short link are not affected.'),
    deletable: stateSchema('The states in which a record may be deleted, in the same shape as editable, for example {status: [draft, rejected]}; in any other a DELETE (or a host transaction\'s remove) answers 409 record_locked. Each property must be in readOnlyProperties.'),
    unique: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'String properties (maxLength at most 128, no default, not readOnly, not the key, not set by a transition) that no two records hold alike, across every owner on an owned collection: a create or update that would duplicate one answers 409 value_taken, checked under the write lock through an index. An absent value claims nothing. The 409 tells the caller the value is in use by someone, so declare it only for a public handle, never an email or anything private.' },
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

/** The root keywords a record schema may use; everything a property may use is core's body profile. */
const ROOT_KEYWORDS = new Set(['$schema', '$comment', 'title', 'description', 'type', 'additionalProperties', 'required', 'properties']);
/** Keywords that would let a stamped value fail its property's schema; a stamp property has none of them. */
const CONSTRAINING = ['enum', 'const', 'pattern', 'format', 'allOf', 'anyOf', 'oneOf', 'not', 'multipleOf'];

/**
 * A record schema checked and compiled with the collection's store layer: the schema (deep-frozen; a named one
 * resolved), its properties, the name it was referenced by (when it is a project named schema), the collection's
 * `defaults` and `readOnlyProperties`, and two validators built by core's body-schema compiler from the schema as it
 * is. `record` is the whole schema; `partial` drops `required` and judges one property at a time (a filter value, a
 * transition value, a default, an increment) and every stored row.
 */
export interface CompiledRecordSchema {
  schema: Readonly<RecordSchema>; schemaName?: string; properties: Readonly<Record<string, PropertySchema>>; required: readonly string[];
  defaults: Readonly<StoredRecord>; readOnly: readonly string[];
  record: CompiledBodySchema; partial: CompiledBodySchema;
}
/** What a collection carries beside its record schema about the properties the store acts on. */
export interface RecordLayer { defaults?: Readonly<Record<string, unknown>>; readOnlyProperties?: readonly string[] }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
/**
 * Checks and compiles a collection's record schema (inline, or a name resolved against the project's named
 * `schemas`) with its store layer; throws plain Errors naming the collection (and the named schema) for the operator.
 */
export function compileRecordSchema(name: string, declared: unknown, layer: RecordLayer = {}, schemas: Readonly<Record<string, unknown>> = {}): CompiledRecordSchema {
  let where = `Collection ${name}: schema`, schemaName: string | undefined, schema = declared;
  if (typeof declared === 'string') {
    if (!hasOwn(schemas, declared)) throw new Error(`${where} names ${declared.slice(0, 64)}, which the project does not declare under schemas`);
    schemaName = declared; schema = schemas[declared];
    where = `Collection ${name}: schema ${declared} (top-level schemas:) cannot be a record schema:`;
  }
  if (!isRecord(schema)) throw new Error(`${where} must be a JSON Schema object`);
  for (const key of Object.keys(schema)) if (!ROOT_KEYWORDS.has(key)) throw new Error(`${where} /${key.slice(0, 64)}: a record schema takes only ${[...ROOT_KEYWORDS].join(', ')} at its root${key === '$defs' ? ' (a flat record has no subschemas to share; a schema file that references another file is bundled into $defs)' : ''}`);
  if (schema.type !== 'object') throw new Error(`${where} /type must be object`);
  if (schema.additionalProperties !== false) throw new Error(`${where} /additionalProperties must be false, written out: the store refuses a property the schema does not declare`);
  const properties = schema.properties;
  if (!isRecord(properties) || Object.keys(properties).length < 1 || Object.keys(properties).length > LIMITS.properties) throw new Error(`${where} /properties must declare 1 to ${LIMITS.properties} properties`);
  for (const [property, value] of Object.entries(properties)) {
    const at = `${where} /properties/${property.slice(0, 64)}`;
    if (!new RegExp(FIELD_NAME).test(property)) throw new Error(`${at}: a property name is a letter a-z then up to 63 letters, digits or _`);
    if (reserved(property)) throw new Error(`${at}: ${property} is reserved and store-owned`);
    if (!isRecord(value) || typeof value.type !== 'string' || !(PROPERTY_TYPES as readonly string[]).includes(value.type)) throw new Error(`${at}/type must be one of ${PROPERTY_TYPES.join(', ')}: a record holds scalars only`);
    // The store's own annotations live in the collection's layer, so a record schema is exactly a request body schema.
    if (hasOwn(value, 'default')) throw new Error(`${at}/default: a record schema carries value shape only; write the default under the collection's defaults (defaults: {${property}: ...})`);
    if (hasOwn(value, 'readOnly')) throw new Error(`${at}/readOnly: a record schema carries value shape only; list the property under the collection's readOnlyProperties`);
  }
  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || !required.every(entry => typeof entry === 'string')) throw new Error(`${where} /required must list property names`);
  const { required: _required, ...partialSchema } = schema;
  const compile = (value: unknown): CompiledBodySchema => {
    // Core's diagnostics name the pointer as `Body schema <pointer>`; here it is the collection's schema.
    try { return compileBodySchema(value as BodySchema); } catch (error) { throw new Error(`${where} ${(error as Error).message.replace(/^Body schema /, '')}`, { cause: error }); }
  };
  const record = compile(schema), partial = compile(partialSchema);
  const defaults: StoredRecord = {};
  for (const [property, value] of Object.entries(layer.defaults ?? {})) {
    const at = `Collection ${name}: defaults.${property.slice(0, 64)}`;
    if (!hasOwn(properties, property)) throw new Error(`${at}: ${property.slice(0, 64)} is not a declared property`);
    if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`${at} must be a string, number or boolean`);
    const issue = unicodeIssue(property, value) ?? bodyIssues(partial, { [property]: value }, 1)[0];
    if (issue) throw new Error(`${at} ${issue.message}`);
    defaults[property] = value as Scalar;
  }
  const readOnly = [...layer.readOnlyProperties ?? []];
  for (const property of readOnly) if (!hasOwn(properties, property)) throw new Error(`Collection ${name}: readOnlyProperties names ${property.slice(0, 64)}, which is not a declared property`);
  return { schema: deepFreeze(structuredClone(schema) as unknown as RecordSchema), ...(schemaName === undefined ? {} : { schemaName }), properties: deepFreeze(structuredClone(properties) as Record<string, PropertySchema>), required: Object.freeze([...required as string[]]), defaults: Object.freeze(defaults), readOnly: Object.freeze(readOnly), record, partial };
}
/**
 * A string holding an unpaired UTF-16 surrogate (#988). The store keeps only well-formed text: SQLite's `->>` and a
 * bound parameter would carry such a string as different bytes, so `unique`, `intervals.within`, `key` and the SQL
 * list order could not compare it. Core refuses one in every JSON body; this covers `StoreExports`, host
 * transactions, declarations and rows already stored.
 */
function unicodeIssue(property: string, value: unknown): BodySchemaIssue | undefined {
  return typeof value === 'string' && !value.isWellFormed() ? { pointer: `/${property}`, keyword: 'unicode', message: 'must be well-formed Unicode (it holds an unpaired surrogate)' } : undefined;
}
/** The first issue of one property value against its schema (a filter, a transition value, an increment), or undefined. */
export function propertyIssue(compiled: CompiledRecordSchema, property: string, value: unknown): BodySchemaIssue | undefined {
  return unicodeIssue(property, value) ?? bodyIssues(compiled.partial, { [property]: value }, 1)[0];
}

export interface NormalizedSpec {
  mount?: string; records: CompiledRecordSchema; maxRecords: number; maxRecordBytes: number; pageSize: number; readOnly: boolean;
  key?: string; increments: string[]; idempotency?: IdempotencySpec; sortable: string[]; filterable: string[]; ownership: Ownership;
  maxRecordsPerOwner?: number; audit: boolean; transitions: Record<string, NormalizedTransition>;
  membership: boolean; readers: Record<string, NormalizedReaders>; create?: { members: string }; intervals?: NormalizedIntervals; transfers: Record<string, NormalizedTransfer>;
  editable?: NormalizedState; deletable?: NormalizedState; unique?: string[];
}
/**
 * A validated interval constraint and its SQL, built once from the declaration. `kind` says how a bound compares
 * (`date-time` as UTC epoch milliseconds, `number` as itself). `create` builds the partial expression index `index`
 * over the records the constraint applies to; `latest` finds, through it, the record in the same scope whose interval
 * starts last before a given end; `scan` reads every constrained interval in index order (activation, operator
 * commands). Every name embedded in the SQL passed FIELD_NAME or COLLECTION_NAME; every `when` value is a quoted literal.
 */
export interface NormalizedIntervals {
  start: string; end: string; within: string[]; scope: IntervalScope; when: Record<string, Scalar>; kind: 'date-time' | 'number';
  length?: IntervalDuration; step?: IntervalDuration; origin?: IntervalOrigin;
  index: string; create: string; latest: string; scan: string;
}
/** A validated transition. `by` is `any` on a shared collection, whose records have no owner to compare. */
export interface NormalizedTransition { from: Record<string, Scalar>; set: Record<string, Scalar>; stamp: Record<string, 'actor' | 'now'>; by: TransitionActor | 'any'; mount?: string; members?: string }

/** Validates the declared transitions against the collection's schema and ownership; throws plain Errors for the operator. */
function transitionsOf(name: string, spec: CollectionSpec, records: CompiledRecordSchema, ownership: Ownership, key: string | undefined): Record<string, NormalizedTransition> {
  const out: Record<string, NormalizedTransition> = {};
  for (const [transition, declared] of Object.entries(spec.transitions ?? {})) {
    const where = `Collection ${name}: transition ${transition}`;
    if (transition === 'increment') throw new Error(`${where}: the name increment is reserved`);
    const values = (kind: 'from' | 'set'): Record<string, Scalar> => {
      for (const [field, value] of Object.entries(declared[kind])) {
        if (!hasOwn(records.properties, field)) throw new Error(`${where}: ${kind} names ${field.slice(0, 64)}, which is not a declared property`);
        const issue = propertyIssue(records, field, value);
        if (issue) throw new Error(`${where}: ${kind} value for ${field} ${issue.message}`);
        if (kind === 'set' && field === key) throw new Error(`${where}: set cannot change the collection key`);
      }
      return { ...declared[kind] };
    };
    const stamp = { ...declared.stamp ?? {} };
    for (const [field, source] of Object.entries(stamp)) {
      const property = hasOwn(records.properties, field) ? records.properties[field] : undefined;
      if (!property) throw new Error(`${where}: stamp names ${field.slice(0, 64)}, which is not a declared property`);
      if (hasOwn(declared.set, field)) throw new Error(`${where}: ${field} is both set and stamped`);
      if (field === key) throw new Error(`${where}: stamp cannot change the collection key`);
      const needed = source === 'actor' ? 128 : 24;
      if (property.type !== 'string' || CONSTRAINING.some(keyword => hasOwn(property, keyword)) || typeof property.maxLength !== 'number' || property.maxLength < needed || (typeof property.minLength === 'number' && property.minLength > 1)) throw new Error(`${where}: stamp property ${field} must be a string with maxLength of at least ${needed} and no ${CONSTRAINING.join(', ')}`);
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
/**
 * Validates a declaration beyond JSON Schema; throws plain Errors for the operator. `schemas` is the project's named
 * schemas (`ExtensionActivation.schemas`), which a collection's `schema: <name>` resolves against.
 */
export function normalize(name: string, spec: CollectionSpec, schemas: Readonly<Record<string, unknown>> = {}): NormalizedSpec {
  const records = compileRecordSchema(name, spec.schema, spec, schemas);
  const property = (field: string): PropertySchema | undefined => hasOwn(records.properties, field) ? records.properties[field] : undefined;
  const queryable = (key: 'sortable' | 'filterable'): string[] => {
    const names = spec[key] ?? [];
    for (const field of names) {
      const declared = property(field);
      if (!declared) throw new Error(`Collection ${name}: ${key} names ${field.slice(0, 64)}, which is not a declared property`);
      if (key === 'filterable' && ['limit', 'cursor', 'sort'].includes(field)) throw new Error(`Collection ${name}: property ${field} cannot be filterable because its name is a list parameter`);
      if (!queryableString(declared)) throw new Error(`Collection ${name}: ${key} property ${field} is a string and needs maxLength of at most ${QUERY_LIMITS.valueLength} or an enum`);
    }
    return names;
  };
  const key = spec.key;
  const membership = spec.membership === true;
  if (membership) {
    // A membership list is authorization data: served over a collection API, anyone the route admits could add
    // themselves or enumerate members. It has no mount, and nothing that only makes sense with one.
    const refused = (['mount', 'ownership', 'transitions', 'readers', 'increments', 'idempotency', 'sortable', 'filterable', 'readOnly', 'transfers', 'create', 'editable', 'deletable', 'unique'] as const).filter(option => spec[option] !== undefined);
    if (refused.length) throw new Error(`Collection ${name}: a membership collection takes no ${refused.join(', ')}`);
    if (key === undefined) throw new Error(`Collection ${name}: a membership collection needs a key, the property holding each member's principal id`);
  } else if (spec.mount === undefined) throw new Error(`Collection ${name}: mount is required`);
  if (key !== undefined) {
    const declared = property(key);
    if (!declared) throw new Error(`Collection ${name}: key ${key} is not a declared property`);
    if (declared.type !== 'string' || !records.required.includes(key) || hasOwn(records.defaults, key) || records.readOnly.includes(key) || typeof declared.maxLength !== 'number' || declared.maxLength > IDEMPOTENCY_LIMITS.keyLength) throw new Error(`Collection ${name}: key ${key} must be a required string property with maxLength at most ${IDEMPOTENCY_LIMITS.keyLength}, no default and not readOnly`);
  }
  const ownership = spec.ownership ?? 'shared';
  // A key exists for public short links, which cannot serve owned records; a value unique across owners is `unique`.
  if (ownership === 'owner' && key !== undefined) throw new Error(`Collection ${name}: key is not supported with ownership: owner; declare unique: [${key}] for a value no two owners may share`);
  const maxRecords = spec.maxRecords ?? 1000, perOwner = spec.maxRecordsPerOwner;
  if (perOwner !== undefined) {
    // A per-owner limit has no owner to count on a shared collection; refused rather than ignored.
    if (ownership !== 'owner') throw new Error(`Collection ${name}: maxRecordsPerOwner needs ownership: owner`);
    if (perOwner > maxRecords) throw new Error(`Collection ${name}: maxRecordsPerOwner exceeds maxRecords (${maxRecords})`);
  }
  const increments = spec.increments ?? [];
  for (const field of increments) {
    const declared = property(field);
    if (!declared) throw new Error(`Collection ${name}: increment property ${field} is not declared`);
    if (!['integer', 'number'].includes(declared.type) || typeof records.defaults[field] !== 'number' || records.readOnly.includes(field)) throw new Error(`Collection ${name}: increment property ${field} must be numeric with a numeric default and not readOnly`);
  }
  const transitions = transitionsOf(name, spec, records, ownership, key);
  const readers: Record<string, NormalizedReaders> = {};
  for (const [reader, declared] of Object.entries(spec.readers ?? {})) {
    const where = `Collection ${name}: readers ${reader}`;
    // Readers widen an owned collection's view; a shared collection's mount already shows every record.
    if (ownership !== 'owner') throw new Error(`Collection ${name}: readers needs ownership: owner`);
    if (declared.mount === spec.mount) throw new Error(`${where}: its mount must differ from the collection mount`);
    if (Object.values(transitions).some(transition => transition.mount === declared.mount)) throw new Error(`${where}: its mount must differ from every transition mount`);
    const shared = Object.keys(readers).find(other => readers[other]!.mount === declared.mount);
    if (shared !== undefined) throw new Error(`${where}: its mount is also readers ${shared}'s; each readers mount has one gate and one view`);
    // Without a gate every signed-in principal reads the mount, so what it shows must be listed, never the whole record.
    if (declared.members === undefined && declared.properties === undefined) throw new Error(`${where} needs members, or properties listing what every signed-in principal may see`);
    // _owner is a principal id that links every record to one account; only a membership list may be trusted with it (#972).
    if (declared.showOwner === true && declared.members === undefined) throw new Error(`${where}: showOwner needs members; without a gate every signed-in principal would receive every owner's principal id`);
    for (const field of declared.properties ?? []) if (!property(field)) throw new Error(`${where}: properties names ${String(field).slice(0, 64)}, which is not a declared property`);
    readers[reader] = { mount: declared.mount, ...(declared.members === undefined ? {} : { members: declared.members }), showOwner: declared.showOwner === true, ...(declared.properties === undefined ? {} : { properties: [...declared.properties] }) };
  }
  if (spec.create !== undefined && spec.readOnly === true) throw new Error(`Collection ${name}: create needs a writable collection; a readOnly one takes no create`);
  const intervals = spec.intervals === undefined ? undefined : intervalsOf(name, spec.intervals, records, ownership, membership, increments);
  const transfers = transfersOf(name, spec, records, ownership, maxRecords, increments, intervals, transitions);
  for (const field of records.readOnly) {
    // A create never carries a readOnly property, so a required one is satisfiable only through its default.
    if (records.required.includes(field) && !hasOwn(records.defaults, field)) throw new Error(`Collection ${name}: property ${field} is required and readOnly, so it needs a default`);
    if (!Object.values(transitions).some(transition => hasOwn(transition.set, field) || hasOwn(transition.stamp, field)) && !Object.values(transfers).some(transfer => transfer.amount === field)) throw new Error(`Collection ${name}: property ${field} is readOnly but no transition sets or stamps it and no transfer moves it`);
  }
  const editable = stateOf(name, 'editable', spec, records), deletable = stateOf(name, 'deletable', spec, records);
  const unique = [...spec.unique ?? []];
  for (const field of unique) {
    const declared = property(field), where = `Collection ${name}: unique property ${String(field).slice(0, 64)}`;
    if (!declared) throw new Error(`${where} is not declared`);
    if (field === key) throw new Error(`${where} is the key, which is unique already`);
    if (!COLLECTION_NAME.test(name) || declared.type !== 'string' || typeof declared.maxLength !== 'number' || declared.maxLength > IDEMPOTENCY_LIMITS.keyLength || hasOwn(records.defaults, field) || records.readOnly.includes(field)) throw new Error(`${where} must be a string property with maxLength at most ${IDEMPOTENCY_LIMITS.keyLength}, no default and not readOnly`);
    // A transition writes a constant (or its caller's id), which a second record could never hold as well.
    const setter = Object.keys(transitions).find(transition => hasOwn(transitions[transition]!.set, field) || hasOwn(transitions[transition]!.stamp, field));
    if (setter !== undefined) throw new Error(`${where} is set by transition ${setter}`);
  }
  return { ...(spec.mount === undefined ? {} : { mount: spec.mount }), records, ...(key === undefined ? {} : { key }), increments, ...(spec.idempotency === undefined ? {} : { idempotency: spec.idempotency }), sortable: queryable('sortable'), filterable: queryable('filterable'), ownership, ...(perOwner === undefined ? {} : { maxRecordsPerOwner: perOwner }), maxRecords, maxRecordBytes: spec.maxRecordBytes ?? 4096, pageSize: spec.pageSize ?? 50, readOnly: spec.readOnly ?? false, audit: spec.audit ?? false, transitions, membership, readers, ...(spec.create?.members === undefined ? {} : { create: { members: spec.create.members } }), ...(intervals === undefined ? {} : { intervals }), transfers, ...(editable === undefined ? {} : { editable }), ...(deletable === undefined ? {} : { deletable }), ...(unique.length ? { unique } : {}) };
}

/**
 * Validates `editable` or `deletable` (#952): declared properties, each listed under `readOnlyProperties` (so a body
 * can neither leave the state nor enter it; only a transition does), with values its schema accepts.
 */
function stateOf(name: string, option: 'editable' | 'deletable', spec: CollectionSpec, records: CompiledRecordSchema): NormalizedState | undefined {
  const declared = spec[option];
  if (declared === undefined) return undefined;
  const where = `Collection ${name}: ${option}`;
  if (spec.readOnly === true) throw new Error(`${where} needs a writable collection`);
  const out: NormalizedState = {};
  for (const [field, value] of Object.entries(declared)) {
    if (!hasOwn(records.properties, field)) throw new Error(`${where} names ${field.slice(0, 64)}, which is not a declared property`);
    if (!records.readOnly.includes(field)) throw new Error(`${where}: ${field} must be listed under readOnlyProperties, so only a transition changes the state`);
    const values = Array.isArray(value) ? [...value] : [value];
    for (const one of values) { const issue = propertyIssue(records, field, one); if (issue) throw new Error(`${where} value for ${field} ${issue.message}`); }
    out[field] = values;
  }
  return out;
}
/** Whether `record` is in `state`: it holds one of the listed values of every named property (no state: always). */
export const inState = (state: NormalizedState | undefined, record: Readonly<StoredRecord>): boolean => !state || Object.entries(state).every(([field, values]) => record[field] !== undefined && values.includes(record[field]!));
/**
 * Refuses a body write (`editable`) or a delete (`deletable`) of a record outside its declared states (#952): 409
 * `record_locked`, naming no state. Every update and delete step calls it under the write lock, after `If-Match`.
 */
export function refuseLocked(spec: Pick<NormalizedSpec, 'editable' | 'deletable'>, option: 'editable' | 'deletable', record: Readonly<StoredRecord>): void {
  if (!inState(spec[option], record)) throw new StoreError(409, 'record_locked', `The record cannot be ${option === 'editable' ? 'changed' : 'deleted'} in its current state`);
}
/**
 * The lookup behind one `unique` property (#953): a partial expression index over the collection's values, and the
 * query that finds another record holding a value. Both embed only a name that passed COLLECTION_NAME and FIELD_NAME.
 */
export function uniqueIndex(name: string, field: string): { index: string; create: string; taken: string } {
  const filter = `collection = '${name}'`, path = `(data ->> '$.${field}')`;
  const index = `store_unique_${createHash('sha256').update(`${path} WHERE ${filter}`).digest('hex').slice(0, 24)}`;
  return { index, create: `CREATE INDEX IF NOT EXISTS "${index}" ON store_records(${path}) WHERE ${filter}`, taken: `SELECT 1 AS found FROM store_records WHERE ${filter} AND ${path} = ? AND id <> ? LIMIT 1` };
}

/**
 * Validates the declared transfers (#902). The amount property is a required integer with an integer default, so every
 * record created under the declaration holds a whole balance. The sum over the collection never changes (#928), so
 * only a transfer may change the amount: it is readOnly (no create, PUT or PATCH body names it), its default is 0 (a
 * create adds nothing to the sum), no transition sets or stamps it, it is not an increment and no interval constraint
 * reads it (a transfer does not run the interval check). A delete of a record still holding a balance is refused at
 * write time (`refuseBalance`).
 */
function transfersOf(name: string, spec: CollectionSpec, records: CompiledRecordSchema, ownership: Ownership, maxRecords: number, increments: readonly string[], intervals: NormalizedIntervals | undefined, transitions: Record<string, NormalizedTransition>): Record<string, NormalizedTransfer> {
  const out: Record<string, NormalizedTransfer> = {};
  const intervalFields = intervals ? [intervals.start, intervals.end, ...intervals.within, ...Object.keys(intervals.when)] : [];
  for (const [transfer, declared] of Object.entries(spec.transfers ?? {})) {
    const where = `Collection ${name}: transfer ${transfer}`, field = declared.amount;
    const property = hasOwn(records.properties, field) ? records.properties[field] : undefined;
    if (!property) throw new Error(`${where}: amount names ${String(field).slice(0, 64)}, which is not a declared property`);
    if (property.type !== 'integer' || !records.required.includes(field) || !Number.isSafeInteger(records.defaults[field])) throw new Error(`${where}: amount property ${field} must be a required integer property with an integer default (count a currency in minor units)`);
    if (increments.includes(field)) throw new Error(`${where}: amount property ${field} is an increment, which would change the sum outside a transfer`);
    if (intervalFields.includes(field)) throw new Error(`${where}: amount property ${field} is named by intervals, which a transfer does not check`);
    if (!records.readOnly.includes(field)) throw new Error(`${where}: amount property ${field} must be listed under readOnlyProperties, so only a transfer changes it and the sum never does`);
    if (records.defaults[field] !== 0) throw new Error(`${where}: amount property ${field} must default to 0, so a new record adds nothing to the sum; fund records with a transfer from an issuer (a negative min)`);
    const setter = Object.keys(transitions).find(transition => hasOwn(transitions[transition]!.set, field) || hasOwn(transitions[transition]!.stamp, field));
    if (setter !== undefined) throw new Error(`${where}: amount property ${field} is set by transition ${setter}, which would change the sum outside a transfer`);
    // #973: a credit only raises a balance, so a keyword that can refuse a higher value would let the payer read the
    // credited record's hidden balance from the refusal. The amount property bounds a balance from below only.
    const bounding = Object.keys(property).filter(keyword => !AMOUNT_KEYWORDS.has(keyword));
    if (bounding.length) throw new Error(`${where}: amount property ${field} takes only ${[...AMOUNT_KEYWORDS].join(', ')}, not ${bounding.map(keyword => keyword.slice(0, 64)).join(', ')}; a limit that a credit can break would tell the payer the credited record's balance`);
    const min = declared.min ?? 0;
    if (!Number.isSafeInteger(min)) throw new Error(`${where}: min must be a safe integer`);
    // #974: on an owned collection every principal the route admits holds records, so an ungated floor below zero lets
    // each of them mint.
    if (min < 0 && ownership === 'owner' && declared.members === undefined) throw new Error(`${where}: a negative min is an issuer, so it needs members: <a membership collection> naming who may issue; without it every signed-in principal could take an empty record below zero and credit anyone`);
    out[transfer] = { amount: field, min, ...(declared.members === undefined ? {} : { members: declared.members }) };
  }
  // #973: the sum stays 0 and no record goes below the lowest min, so no balance can exceed |min| x maxRecords. Kept
  // within the safe integers, a credit can never overflow, and the credited record's balance never decides the answer.
  const floor = Math.min(0, ...Object.values(out).map(transfer => transfer.min));
  if (-floor * maxRecords > Number.MAX_SAFE_INTEGER) throw new Error(`Collection ${name}: transfers: the lowest min (${floor}) times maxRecords (${maxRecords}) exceeds ${Number.MAX_SAFE_INTEGER}, so a balance could leave the safe integers; raise the min or lower maxRecords`);
  return out;
}
/** The keywords a transfer's amount property may carry (#973): its type, a lower bound and annotations. */
const AMOUNT_KEYWORDS: ReadonlySet<string> = new Set(['type', 'minimum', 'exclusiveMinimum', 'title', 'description', '$comment', 'deprecated', 'examples']);

/**
 * Validates an interval constraint and builds its SQL. The bounds are both UTC date-times or both numbers, and they
 * and the `within` properties are required, so every record the constraint applies to has an interval to compare.
 * No property it names may be an increment, which would change an interval without the check.
 */
function intervalsOf(name: string, declared: IntervalSpec, records: CompiledRecordSchema, ownership: Ownership, membership: boolean, increments: readonly string[]): NormalizedIntervals {
  const where = `Collection ${name}: intervals`;
  if (!COLLECTION_NAME.test(name)) throw new Error(`${where}: the collection name is not valid`);
  if (membership) throw new Error(`${where}: a membership collection takes no intervals`);
  const property = (field: string): PropertySchema => {
    if (typeof field !== 'string' || !new RegExp(FIELD_NAME).test(field) || !hasOwn(records.properties, field)) throw new Error(`${where}: ${String(field).slice(0, 64)} is not a declared property`);
    if (increments.includes(field)) throw new Error(`${where}: ${field} is an increment property, which would change an interval without the check`);
    return records.properties[field]!;
  };
  const kindOf = (field: string): 'date-time' | 'number' => {
    const schema = property(field);
    if (!records.required.includes(field)) throw new Error(`${where}: ${field} must be required`);
    if (schema.type === 'integer' || schema.type === 'number') return 'number';
    if (schema.type === 'string' && schema.format === 'date-time') return 'date-time';
    throw new Error(`${where}: ${field} must be a string with format: date-time, an integer or a number`);
  };
  const { start, end } = declared, kind = kindOf(start);
  if (start === end) throw new Error(`${where}: start and end must be different properties`);
  if (kindOf(end) !== kind) throw new Error(`${where}: start and end must both be date-times or both be numbers`);
  const within = [...declared.within ?? []];
  for (const field of within) {
    property(field);
    if (field === start || field === end) throw new Error(`${where}: within cannot name start or end`);
    if (!records.required.includes(field)) throw new Error(`${where}: within property ${field} must be required`);
  }
  // A length or step is exact arithmetic on the bounds, so they are whole milliseconds (a date-time) or integers.
  const duration = (option: 'length' | 'step'): IntervalDuration | undefined => {
    const value = declared[option];
    if (value === undefined) return undefined;
    if (kind === 'date-time') {
      const units = typeof value === 'string' ? durationMs(value) : undefined;
      if (units === undefined) throw new Error(`${where}: ${option} must be an ISO 8601 duration of whole days, hours, minutes and seconds longer than zero (PT1H, PT30M, P1D) for date-time bounds`);
      return { declared: value, units };
    }
    if (records.properties[start]!.type !== 'integer' || records.properties[end]!.type !== 'integer') throw new Error(`${where}: ${option} needs integer bounds (or date-times); a number bound has no exact multiple`);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${where}: ${option} must be a positive integer for integer bounds`);
    return { declared: value, units: value };
  };
  const length = duration('length'), step = duration('step');
  if (length && step && length.units % step.units !== 0) throw new Error(`${where}: length must be a whole multiple of step, or no interval could have both`);
  // The grid's origin (#945) is kept as its residue modulo the step, so the check stays exact for any safe integer bound.
  let origin: IntervalOrigin | undefined;
  if (declared.origin !== undefined) {
    if (!step) throw new Error(`${where}: origin needs step; it is where the step grid counts from`);
    const units = kind === 'date-time' ? originMs(declared.origin) : typeof declared.origin === 'number' && Number.isSafeInteger(declared.origin) ? declared.origin : undefined;
    if (units === undefined) throw new Error(kind === 'date-time' ? `${where}: origin must be an RFC 3339 date-time with Z or a fixed offset (+05:30) and at most millisecond precision, for date-time bounds` : `${where}: origin must be an integer for integer bounds`);
    origin = { declared: declared.origin, residue: residue(units, step.units) };
  }
  const scope = declared.scope ?? 'collection';
  if (scope === 'owner' && ownership !== 'owner') throw new Error(`${where}: scope: owner needs ownership: owner`);
  const when: Record<string, Scalar> = {};
  for (const [field, value] of Object.entries(declared.when ?? {})) {
    property(field);
    const issue = propertyIssue(records, field, value);
    if (issue) throw new Error(`${where}: when value for ${field} ${issue.message}`);
    if (typeof value === 'string' && value.includes('\u0000')) throw new Error(`${where}: when value for ${field} cannot contain NUL`);
    when[field] = value;
  }
  // `->>` yields SQL text for a JSON string, the number for a number and 1 or 0 for a boolean.
  const path = (field: string): string => `(data ->> '$.${field}')`;
  const instant = (field: string): string => kind === 'date-time' ? `CAST(round(unixepoch(${path(field)}, 'subsec') * 1000) AS INTEGER)` : path(field);
  const literal = (value: Scalar): string => typeof value === 'boolean' ? (value ? '1' : '0') : typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
  // The collection and the `when` terms are literals, so SQLite can prove that a query repeating them may use the partial index.
  const filter = [`collection = '${name}'`, ...Object.entries(when).map(([field, value]) => `${path(field)} = ${literal(value)}`)].join(' AND ');
  const columns = [...scope === 'owner' ? ['owner'] : [], ...within.map(path), instant(start)];
  const index = `store_intervals_${createHash('sha256').update(`${columns.join(', ')} WHERE ${filter}`).digest('hex').slice(0, 24)}`;
  return {
    start, end, within, scope, when, kind, ...(length === undefined ? {} : { length }), ...(step === undefined ? {} : { step }), ...(origin === undefined ? {} : { origin }), index,
    create: `CREATE INDEX IF NOT EXISTS "${index}" ON store_records(${columns.join(', ')}) WHERE ${filter}`,
    latest: `SELECT id, owner, ${instant(end)} AS until FROM store_records WHERE ${filter}${scope === 'owner' ? ' AND owner = ?' : ''}${within.map(field => ` AND ${path(field)} = ?`).join('')} AND ${instant(start)} < ? AND id <> ? ORDER BY ${instant(start)} DESC LIMIT 1`,
    scan: `SELECT id, owner, ${[...within.map((field, at) => `${path(field)} AS w${at}`), `${instant(start)} AS since`, `${instant(end)} AS until`].join(', ')} FROM store_records WHERE ${filter} ORDER BY ${columns.join(', ')}`,
  };
}
/** `value` modulo `step`, from 0 up to `step`: exact for any safe integer, whatever its sign. */
const residue = (value: number, step: number): number => ((value % step) + step) % step;
/**
 * A grid origin as epoch milliseconds (#945): RFC 3339 with `Z` or a fixed offset, whose date and time must exist as
 * written (no 30 February, no hour 24) and whose offset is at most 23:59. Undefined for anything else.
 */
function originMs(value: unknown): number | undefined {
  const match = typeof value === 'string' ? OFFSET_INSTANT.exec(value) : null;
  if (!match) return undefined;
  const local = instantOf('date-time', `${match[1]!}Z`), hours = Number(match[3] ?? 0), minutes = Number(match[4] ?? 0);
  if (local === undefined || hours > 23 || minutes > 59) return undefined;
  return local - (match[2] === '-' ? -1 : 1) * (hours * 60 + minutes) * 60_000;
}
/** An interval bound as the constraint compares it: UTC epoch milliseconds for a date-time, the number itself otherwise. */
function instantOf(kind: NormalizedIntervals['kind'], value: unknown): number | undefined {
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !UTC_INSTANT.test(value)) return undefined;
  const ms = Date.parse(value);
  // The round trip refuses what Date.parse would roll over or reject (a 30 February, a leap second).
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : undefined;
}
/** Whether the constraint applies to `record`: it holds every `when` value. */
const constrained = (intervals: NormalizedIntervals, record: Readonly<Record<string, unknown>>): boolean => Object.entries(intervals.when).every(([field, value]) => record[field] === value);
/** The record-level interval rules, as schema issues: each present bound is a comparable value, and `end` is after `start`. */
function intervalIssues(intervals: NormalizedIntervals, values: Readonly<Record<string, unknown>>): BodySchemaIssue[] {
  const start = instantOf(intervals.kind, values[intervals.start]), end = instantOf(intervals.kind, values[intervals.end]);
  const utc = 'must be a UTC date-time ending in Z, with at most millisecond precision';
  const issues: BodySchemaIssue[] = [];
  // A missing bound is the schema's own `required` issue.
  if (start === undefined && values[intervals.start] !== undefined) issues.push({ pointer: `/${intervals.start}`, keyword: 'intervals', message: utc });
  if (end === undefined && values[intervals.end] !== undefined) issues.push({ pointer: `/${intervals.end}`, keyword: 'intervals', message: utc });
  if (start !== undefined && end !== undefined && end <= start) issues.push({ pointer: `/${intervals.end}`, keyword: 'intervals', message: `must be after ${intervals.start}` });
  if (issues.length || start === undefined || end === undefined) return issues;
  // The declared length and grid (#929). The messages name the declaration, never the submitted value.
  const { length, step } = intervals, grid = step && `must be a whole multiple of ${step.declared}${gridOrigin(intervals)}`;
  if (step && grid) for (const [field, value] of [[intervals.start, start], [intervals.end, end]] as const) if (residue(value, step.units) !== (intervals.origin?.residue ?? 0)) issues.push({ pointer: `/${field}`, keyword: 'intervals', message: grid });
  if (length && end - start !== length.units) issues.push({ pointer: `/${intervals.end}`, keyword: 'intervals', message: `must be exactly ${length.declared} after ${intervals.start}` });
  return issues;
}
/** Where a step grid counts from, as its messages name it: the declared origin, else the epoch for date-times (and nothing for integers, whose grid counts from 0). */
export const gridOrigin = (intervals: Pick<NormalizedIntervals, 'kind' | 'origin'>): string => intervals.origin ? ` from ${intervals.origin.declared}` : intervals.kind === 'date-time' ? ' from 1970-01-01T00:00:00Z' : '';
/** A property value as SQLite compares it through `->>`: a boolean is 1 or 0. */
const bound = (value: Scalar | undefined): string | number | null => value === undefined ? null : typeof value === 'boolean' ? (value ? 1 : 0) : value;
/**
 * The first pair of constrained records in one scope whose intervals overlap, or `undefined`: one pass in index order
 * (scope, then start), keeping the latest end seen in the current scope. Records with no owner are nobody's under
 * `scope: owner` and are skipped there, as the write check never matches them. With `moving` (an operator command about
 * to give `from`'s records to `to`, or with `from` null the ownerless ones), only the two principals' records are
 * judged, as if the move had happened, before anything is written.
 */
export function overlapping(db: StoreDatabase, intervals: NormalizedIntervals, moving?: { from: string | null; to: string }): [string, string] | undefined {
  type Row = { id: string; group: string; since: number | null; until: number | null };
  let rows: Row[] = db.all<Record<string, string | number | null>>(intervals.scan).flatMap(row => {
    let owner = intervals.scope === 'owner' ? row.owner as string | null : null;
    if (moving && intervals.scope === 'owner') {
      if (owner !== moving.from && owner !== moving.to) return [];
      owner = moving.to;
    }
    if (intervals.scope === 'owner' && owner === null) return [];
    return [{ id: row.id as string, group: JSON.stringify([owner, ...intervals.within.map((_, at) => row[`w${at}`])]), since: row.since as number | null, until: row.until as number | null }];
  });
  // The scan is in index order already; merging two owners' records needs ordering again.
  if (moving) rows = rows.sort((a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : (a.since ?? 0) - (b.since ?? 0));
  let previous: { id: string; group: string; until: number } | undefined;
  for (const row of rows) {
    if (previous?.group === row.group && row.since !== null && previous.until > row.since) return [previous.id, row.id];
    if (row.until !== null && (previous?.group !== row.group || row.until > previous.until)) previous = { id: row.id, group: row.group, until: row.until };
  }
  return undefined;
}

/**
 * Whether a short link may redirect to `value`: an absolute HTTP(S) URL without credentials or ASCII whitespace. The
 * destination property's own schema (`format: uri`) admits any scheme; this is the short link's rule on top of it.
 */
export function redirectable(value: unknown): boolean {
  if (typeof value !== 'string' || /[\u0000- \u007f]/.test(value)) return false;
  try { const parsed = new URL(value); return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password; }
  catch { return false; }
}

/**
 * Inserts one store event into the outbox inside the caller's open transaction, after audit's own validator accepted
 * it. At the collection's backlog cap it refuses with 503 `audit_backlog`, which rolls the caller's write back too.
 */
export function writeAuditEvent(db: StoreDatabase, collection: string, validate: (value: unknown) => AuditEvent, body: { action: string; actor: string; subject: string; metadata: Record<string, unknown> }): void {
  if (db.get<{ n: number }>('SELECT count(*) AS n FROM store_audit_outbox WHERE collection = ?', collection)!.n >= AUDIT_BACKLOG) throw new StoreError(503, 'audit_backlog', 'The audit log is behind; try again later');
  const event = validate({ id: randomUUID(), source: 'store', at: Date.now(), ...body });
  db.run('INSERT INTO store_audit_outbox(id, collection, at, event) VALUES (?, ?, ?, ?)', event.id, collection, event.at, JSON.stringify(event));
}
/**
 * The event for one membership change (#866): the member's principal id is the subject, because who was granted or
 * lost the right is the evidence. It is an opaque id the principal provider set, never an email or a name.
 */
export const membershipEvent = (collection: string, change: 'added' | 'removed', member: string, actor: string) =>
  ({ action: `store.membership.${change}`, actor, subject: `${collection}/${member}`, metadata: { collection } });

/** What an audited collection needs from the audit extension: its pure event validator, and a wake-up for the drain after a commit that wrote an event. */
export interface CollectionAuditor { validate(value: unknown): AuditEvent; notify(): void }
type AuditAction = 'created' | 'replaced' | 'updated' | 'deleted' | 'incremented' | 'transitioned' | 'transferred';
/**
 * An `Idempotency-Key` a write carries (#835): `key`, the header value hashed with the caller's scope (the principal,
 * or the network client when there is none), and `fingerprint`, the hash of the request it was first used for.
 */
export interface Retry { key: string; fingerprint: string }
/**
 * A write's answer: its success status, the record (absent after a delete) and whether it replays a retained
 * `Idempotency-Key`. A replay carries the first answer's status and the record as it is now.
 */
export interface Written { status: number; record: StoredRecord | undefined; replayed: boolean; may?: string[] }
/**
 * A transfer's answer (#902): the debited record and, when the caller may read it, the credited one (on an owned
 * collection only the caller's own), each as it is now; `replayed` as for `Written`.
 */
export interface Transferred { status: number; from: StoredRecord | undefined; to: StoredRecord | undefined; replayed: boolean }
/**
 * Who a response is computed for (#873): with a viewer, a list page, a read and a write's answer carry `may`, the
 * transitions that viewer may run on each record right now. Trusted callers (StoreExports, the operator CLI) pass none.
 */
export interface Viewer { principal: string | undefined }
/** One list page; `may` is present when the page was read for a `Viewer`. */
export interface Page { items: StoredRecord[]; total: number; next?: string | number; may?: Record<string, string[]> }
/** What one write step inside a transaction produced: the record it left and whether it inserted an audit event. */
export interface Step { record: StoredRecord | undefined; audited: boolean }
/** A transfer step: `record` is the debited record, `to` the credited one as the write left it. */
export interface TransferStep extends Step { record: StoredRecord; to: StoredRecord }
/**
 * Maps a failure inside a store transaction to what a caller may see: a StoreError is kept, a row this declaration
 * cannot represent or a SQLite failure (a full disk, a lock held past the busy timeout) is a 503 with no detail, and
 * with `rethrowOthers` anything else (a trusted host transaction's own error) is rethrown unchanged.
 */
export function storageFailure(error: unknown, rethrowOthers: boolean): never {
  if (error instanceof StoreError) throw error;
  if (error instanceof RowError) throw new StoreError(503, 'storage_unavailable', STORED_OUTSIDE);
  if (rethrowOthers && !(error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR')) throw error;
  throw new StoreError(503, 'storage_unavailable', 'The store could not save this change');
}

/** A JSON value with object keys sorted at every depth: two values that differ only in key order serialize alike. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/**
 * The declaration fingerprint (#927): the SHA-256 of the normalized declaration, which is everything a write checks
 * (the record schema with a named schema resolved, defaults, readOnly properties, key, increments, limits, ownership,
 * audit, transitions, membership, readers, intervals, transfers, idempotency, mounts). Two processes that normalize the
 * same declaration get the same fingerprint, however it was written.
 */
export function declarationFingerprint(spec: NormalizedSpec): string {
  const { records, ...rest } = spec;
  return createHash('sha256').update(canonical({ ...rest, records: { schema: records.schema, required: records.required, defaults: records.defaults, readOnly: records.readOnly } })).digest('hex');
}
/**
 * The 503 for a stored row this declaration cannot represent (`RowError`): one written under another declaration
 * during a reload overlap, or one changed in the database. Fixed, naming no record or value; activation names the
 * record to the operator.
 */
export const STORED_OUTSIDE = 'A stored record does not match this collection\'s declaration';
/** The 503 a write answers when the declaration fence refuses it: bounded, naming nothing. */
export const REDECLARED = 'The collection was redeclared by another process';
/**
 * The operator commands' fence (#927): they carry the project's declaration, which may differ from the one served. A
 * command is refused when a live server has recorded a different declaration of `collection` (or runs another store
 * schema): its writes would break rules the server enforces. With no live server, or nothing recorded, it proceeds.
 */
export function operatorFence(db: StoreDatabase, collection: string, fingerprint: string): void {
  const recorded = declarationOf(db, collection);
  if (recorded === undefined || (recorded.fingerprint === fingerprint && recorded.schema_version === STORE_SCHEMA_VERSION)) return;
  if (liveServer(db, Date.now())) throw new StoreError(503, 'storage_unavailable', `Collection ${collection}: the serving process declares it differently from this project (or runs another store release); run the command with the project it serves, or stop it first`);
}

/** A record read for a viewer, with the transitions it may run on it (`Viewer`). */
export interface Shown { record: StoredRecord; may: string[] }
/** Whether `principal` is listed in the membership collection `members`: one lookup on its unique key index. */
const isMember = (db: StoreDatabase, members: string, principal: string): boolean => db.get('SELECT 1 AS found FROM store_records WHERE collection = ? AND key = ?', members, principal) !== undefined;

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
export function stamp(previous?: string): string {
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
 * what it checks (the ETag, the key, the quotas, the declared intervals, the retained Idempotency-Keys, the audit backlog) and writes the
 * record, the key claim and the audit event together, or rolls all of it back. Statements are synchronous, so within
 * this process no other request runs between a transaction's check and its write.
 */
export class Collection {
  readonly name: string; readonly spec: NormalizedSpec;
  private db: StoreDatabase | undefined;
  private readonly auditor: CollectionAuditor | undefined;
  private get owned(): boolean { return this.spec.ownership === 'owner'; }
  /** Properties a short link redirects to (store.ts): every write also requires `redirectable` values there. */
  private readonly destinations: readonly string[];
  /** The declaration fingerprint (`declarationFingerprint`) the fence compares. */
  readonly fingerprint: string;
  /**
   * Which fence a write passes (#927). `serving` (set by the store's activation once it recorded its declarations): the
   * recorded fingerprint, schema version and `user_version` must all equal this view's, or the write is a 503 and writes
   * nothing. `operator` (the default, for the operator commands): `operatorFence`.
   */
  fence: 'serving' | 'operator' = 'operator';
  constructor(name: string, spec: CollectionSpec, auditor?: CollectionAuditor, destinations: readonly string[] = [], schemas: Readonly<Record<string, unknown>> = {}) { this.name = name; this.spec = normalize(name, spec, schemas); this.fingerprint = declarationFingerprint(this.spec); this.auditor = auditor; this.destinations = destinations; }
  /**
   * The declaration fence, first inside every write transaction, under the write lock: one indexed read of the recorded
   * declaration and the file's `user_version`. A newer activation (a reload here, or another process: a blue/green
   * candidate, a newer release that migrated the file) recorded its own, so this view's writes would enforce rules
   * nobody declares any more. Reads are not fenced.
   */
  fenced(db: StoreDatabase): void {
    if (this.fence === 'operator') return operatorFence(db, this.name, this.fingerprint);
    const recorded = declarationOf(db, this.name);
    if (recorded?.fingerprint !== this.fingerprint || recorded.schema_version !== STORE_SCHEMA_VERSION || recorded.version !== STORE_SCHEMA_VERSION) throw new StoreError(503, 'storage_unavailable', REDECLARED);
  }

  /**
   * Binds this view to the open database after validating every stored row against this declaration: a row that
   * violates it refuses activation (plain Error) instead of being served. The `key` column is derived data, so when
   * the declared key changed it is recomputed here, in one transaction; a duplicate value refuses activation.
   */
  open(db: StoreDatabase): void {
    const rows = db.all<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? ORDER BY seq`, this.name);
    if (rows.length > this.spec.maxRecords) throw new Error(`Collection ${this.name}: the store holds more records than maxRecords`);
    const keys = new Set<string>(), derived: [string, string | null][] = [], unique = this.spec.unique ?? [], held = unique.map(() => new Set<Scalar>());
    for (const row of rows) {
      let record: StoredRecord;
      try { record = this.parse(row); } catch (error) { throw new Error(error instanceof RowError ? error.message : `Collection ${this.name}: the store holds an invalid record`, { cause: error }); }
      if (this.spec.intervals && intervalIssues(this.spec.intervals, record).length) throw new Error(`Collection ${this.name}: record ${row.id} holds an interval that intervals refuses (an end not after its start, a date-time that is not UTC with at most millisecond precision, or a length or step it does not keep)`);
      const key = this.spec.key === undefined ? null : record[this.spec.key];
      if (key !== null && (typeof key !== 'string' || keys.has(key))) throw new Error(`Collection ${this.name}: the store holds an invalid record key`);
      if (key !== null) keys.add(key);
      unique.forEach((field, at) => {
        const value = record[field];
        if (value !== undefined && held[at]!.has(value)) throw new Error(`Collection ${this.name}: two records hold the same ${field}, which unique refuses; change one of them first`);
        if (value !== undefined) held[at]!.add(value);
      });
      derived.push([row.id, key]);
    }
    if (derived.some(([, key], index) => rows[index]!.key !== key)) db.transaction(() => {
      // Cleared first, so two records that swap values under a newly declared key never collide midway.
      db.run('UPDATE store_records SET key = NULL WHERE collection = ?', this.name);
      for (const [id, key] of derived) if (key !== null) db.run('UPDATE store_records SET key = ? WHERE collection = ? AND id = ?', key, this.name, id);
    });
    for (const field of unique) db.run(uniqueIndex(this.name, field).create);
    const intervals = this.spec.intervals;
    if (intervals) {
      // The index is derived from the declaration and built once; the check below and every write's check read through it.
      db.run(intervals.create);
      const pair = overlapping(db, intervals);
      if (pair) throw new Error(`Collection ${this.name}: records ${pair[0]} and ${pair[1]} hold overlapping intervals, which intervals refuses; move or delete one of them first`);
    }
    // The list indexes (#951) are derived from the declaration like the interval index, built before it is served.
    const listing = this.listing;
    if (listing) db.transaction(() => { for (const create of listing.indexes.values()) db.run(create); });
    this.db = db;
  }
  /**
   * Refuses activation while a stored row holds a balance these transfers could not serve under the declaration
   * (plain Error, naming the record and the fix for the operator): an amount property that is missing or not a whole
   * number within the safe integers, a record over `maxRecordBytes` with its amounts at their widest, or stored
   * balances that could together grow past 2^53 - 1. Rows written under an earlier declaration, or by an earlier
   * release, are held to the same rules as every write under this one, so a transfer's answer never depends on what
   * the credited record holds. The ceiling a balance can reach is the sum over stored rows of how far each stands above
   * its property's lowest `min`, plus that `min`'s magnitude for every record still to be created; under the
   * declaration it is at most `-min` times `maxRecords`, which activation already keeps within the safe integers.
   * Runs inside the transaction that records the declaration (store.ts), so no write through another declaration can
   * land between the check and the fence.
   */
  balancesHeld(db: StoreDatabase): void {
    const transfers = Object.values(this.spec.transfers);
    if (!transfers.length) return;
    const floors = new Map<string, number>();
    for (const transfer of transfers) floors.set(transfer.amount, Math.min(floors.get(transfer.amount) ?? 0, transfer.min));
    const rows = db.all<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? ORDER BY seq`, this.name);
    const ceilings = new Map([...floors.keys()].map(field => [field, 0n]));
    for (const row of rows) {
      let record: StoredRecord;
      try { record = this.parse(row); } catch (error) { throw new Error(error instanceof RowError ? error.message : `Collection ${this.name}: the store holds an invalid record`, { cause: error }); }
      for (const [field, floor] of floors) {
        const held = record[field];
        if (!Number.isSafeInteger(held)) throw new Error(`Collection ${this.name}: record ${row.id} holds no whole-number ${field}, which a transfer moves; set it in the database (0 for a record that never held a balance) or delete the record first`);
        if ((held as number) > floor) ceilings.set(field, ceilings.get(field)! + BigInt(held as number) - BigInt(floor));
      }
      if (this.oversized(record)) throw new Error(`Collection ${this.name}: record ${row.id} exceeds maxRecordBytes (${this.spec.maxRecordBytes}) with its transfer amounts at their widest; shorten it in the database or raise maxRecordBytes first`);
    }
    for (const [field, floor] of floors) {
      const ceiling = ceilings.get(field)! + BigInt(this.spec.maxRecords - rows.length) * BigInt(-floor);
      if (ceiling > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Collection ${this.name}: the stored ${field} balances could grow past ${Number.MAX_SAFE_INTEGER} under this declaration (how far each stored balance stands above the lowest min, ${floor}, plus that min for every record maxRecords still allows); move balances back to the issuer, raise the lowest min or lower maxRecords first`);
    }
  }
  /** What sorted and filtered lists read through (listing.ts), derived from the declaration once. */
  private get listing(): ListPlan | undefined { return (this.plan ??= [listPlan(this.name, this.spec)])[0]; }
  private plan: [ListPlan | undefined] | undefined;
  /**
   * The derived indexes this declaration reads through: interval (#902), unique (#953) and list (#951). store.ts drops
   * the ones no live declaration names.
   */
  get indexes(): string[] { return [...this.spec.intervals ? [this.spec.intervals.index] : [], ...(this.spec.unique ?? []).map(field => uniqueIndex(this.name, field).index), ...this.listing?.indexes.keys() ?? []]; }
  /**
   * The methods `<mount>/<id>` takes on `record` now, on a collection declaring `editable` or `deletable` (#952), else
   * undefined: the `Allow` header and a list's `allow`, a hint the write checks again under its lock.
   */
  allowed(record: Readonly<StoredRecord>): string[] | undefined {
    if (!this.spec.editable && !this.spec.deletable) return undefined;
    return ['GET', 'HEAD', ...inState(this.spec.editable, record) ? ['PUT', 'PATCH'] : [], ...inState(this.spec.deletable, record) ? ['DELETE'] : []];
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
    // Judged without `required`: a record stored before a property became required is still served, and its next
    // write must supply it.
    if (bodyIssues(this.spec.records.partial, fields, 1).length) throw new RowError(`Collection ${this.name}: a stored record no longer matches the collection schema`);
    // Written before #988 refused them at write time; `unique`, `intervals` and `key` could not compare it.
    const illFormed = Object.keys(fields).find(field => unicodeIssue(field, fields[field]));
    if (illFormed !== undefined) throw new RowError(`Collection ${this.name}: record ${row.id} holds ${illFormed.slice(0, 64)} as a string with an unpaired UTF-16 surrogate (a \\uD800-\\uDFFF escape), which the store no longer accepts because unique, intervals and key cannot compare it; change or delete that record in the database first`);
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
   * One write transaction, fenced first (`fenced`). `work` returns its answer and whether it inserted an audit event; the audit drain is woken
   * only after the commit. A StoreError from `work` rolls back and is rethrown; anything else (a full disk, a lock
   * another process held past the busy timeout) rolls back and is a 503 with no detail.
   */
  private write(work: (db: StoreDatabase) => { result: Written; audited: boolean }, viewer?: Viewer): Written {
    const db = this.database();
    let outcome: { result: Written; audited: boolean };
    try {
      outcome = db.transaction(() => {
        this.fenced(db);
        const done = work(db), record = done.result.record;
        // Computed after the write, in its transaction: what the viewer may run on the record as it now stands.
        if (viewer && record) done.result.may = this.mayIn(db, [record], viewer.principal)[record.id as string]!;
        return done;
      });
    } catch (error) { return storageFailure(error, false); }
    if (outcome.audited) this.notifyAudit();
    return outcome.result;
  }
  /** Wakes the audit drain after a commit that inserted one of this collection's events. */
  notifyAudit(): void { this.auditor?.notify(); }

  /**
   * The properties a create, PUT or PATCH body names. A body that is not an object gets the schema's own type issue;
   * the store-owned names (`id`, `createdAt`, `updatedAt`) are ignored, so a client may send back a record it read;
   * a readOnly property is refused, because only a transition changes it.
   */
  private bodyOf(input: unknown): Record<string, unknown> {
    if (!isRecord(input)) throw invalidRecord(bodyIssues(this.spec.records.record, input));
    const body = Object.fromEntries(Object.entries(input).filter(([key]) => !reserved(key)));
    const fixed = this.spec.records.readOnly.filter(field => hasOwn(body, field));
    if (fixed.length) throw invalidRecord(fixed.map(field => ({ pointer: `/${field}`, keyword: 'readOnly', message: 'is changed only by a transition' })));
    return body;
  }
  /**
   * The properties a write leaves, validated as a whole against the collection schema (422 `invalid_record` with
   * core's issues), then by the store's own rules on named properties: a membership key is a principal id, and a
   * short link's destination is `redirectable`. Returned in declaration order.
   */
  private validated(values: Record<string, unknown>): StoredRecord {
    // The interval rules judge a record the schema accepts, so a bound is already of its declared type.
    const unicode = Object.keys(this.spec.records.properties).map(field => unicodeIssue(field, values[field])).filter(issue => issue !== undefined);
    const issues = unicode.length ? unicode : [...bodyIssues(this.spec.records.record, values)];
    if (!issues.length && this.spec.intervals) issues.push(...intervalIssues(this.spec.intervals, values));
    if (issues.length) throw invalidRecord(issues);
    const key = this.spec.key;
    if (this.spec.membership && key !== undefined && !principalIdPattern.test(values[key] as string)) throw invalidRecord([{ pointer: `/${key}`, keyword: 'membership', message: 'must be a principal id' }]);
    for (const field of this.destinations) if (hasOwn(values, field) && !redirectable(values[field])) throw invalidRecord([{ pointer: `/${field}`, keyword: 'format', message: 'must be an absolute HTTP(S) URL without credentials or ASCII whitespace' }]);
    return Object.fromEntries(Object.keys(this.spec.records.properties).filter(field => hasOwn(values, field)).map(field => [field, values[field] as Scalar]));
  }
  private sized(record: StoredRecord): void {
    if (this.oversized(record)) throw new StoreError(413, 'record_too_large', `Record exceeds ${this.spec.maxRecordBytes} bytes`);
  }
  /**
   * Whether `record` exceeds `maxRecordBytes`, measured with every transfer amount at its widest safe integer (#973):
   * every write reserves the room a balance can take, so a later credit can never push a record over the limit and
   * the credited record's size never decides a transfer's answer.
   */
  private oversized(record: StoredRecord): boolean {
    const widest = Object.fromEntries(Object.values(this.spec.transfers).map(transfer => [transfer.amount, -Number.MAX_SAFE_INTEGER]));
    return Buffer.byteLength(JSON.stringify({ ...record, ...widest })) > this.spec.maxRecordBytes;
  }
  /**
   * The interval check (#902), inside the write's transaction and before its row is written: when the constraint
   * applies to `record`, the record in its scope whose interval starts last before `record` ends (the record itself
   * excluded, so a move is judged against the others) must end by the time `record` starts. Since the stored intervals
   * of a scope never overlap, that one record is the only candidate, found by one descending step of the index.
   * Otherwise 409 `interval_conflict`, naming the conflicting record only when `reader` may read it: on a shared
   * collection anyone who reaches the mount may; on an owned one only its owner, so another owner's booking blocks
   * the slot without being disclosed.
   */
  private fits(db: StoreDatabase, record: StoredRecord, reader: string | undefined): void {
    const intervals = this.spec.intervals;
    if (!intervals || !constrained(intervals, record)) return;
    const start = instantOf(intervals.kind, record[intervals.start])!, end = instantOf(intervals.kind, record[intervals.end])!;
    const scope = intervals.scope === 'owner' ? [(record[OWNER_FIELD] as string | undefined) ?? null] : [];
    const latest = db.get<{ id: string; owner: string | null; until: number | null }>(intervals.latest, ...scope, ...intervals.within.map(field => bound(record[field])), end, record.id as string);
    if (latest && latest.until !== null && latest.until > start) {
      const visible = !this.owned || (reader !== undefined && latest.owner === reader);
      throw new StoreError(409, 'interval_conflict', 'The interval overlaps another record', visible ? { conflict: { id: latest.id } } : {});
    }
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
   * The `unique` check (#953), under the write lock before the row is written: no other record, whoever owns it, holds
   * a value `record` gives a unique property (one it kept from `previous` is its own already). 409 `value_taken`
   * names the property, never the value or the record holding it.
   */
  private uniqueIn(db: StoreDatabase, record: StoredRecord, previous?: StoredRecord): void {
    for (const field of this.spec.unique ?? []) {
      const value = record[field];
      if (value === undefined || value === previous?.[field] || !db.get(uniqueIndex(this.name, field).taken, value as string, record.id as string)) continue;
      throw new StoreError(409, 'value_taken', 'Another record already uses this value', { issues: [{ pointer: `/${field}`, keyword: 'unique', message: 'is already used by another record' }] });
    }
  }
  /**
   * Inserts the outbox event for one write, inside the write's transaction: unchanged on an unaudited collection. At
   * the backlog cap the write is refused (and rolled back). The event names the changed fields, never their values; a
   * list too long for audit's metadata bound is cut and marked `truncated`. Returns whether an event was inserted.
   */
  private audited(db: StoreDatabase, action: AuditAction, id: string, fields: readonly string[], actor: string | undefined, extra: Record<string, string> = {}, record?: StoredRecord): boolean {
    if (!this.spec.audit) return false;
    const who = this.actorOf(actor);
    // Activation refuses an audited collection without an active audit, so this is a wiring error, never a request's.
    if (!this.auditor) throw new StoreError(503, 'audit_unavailable', 'The audit log is unavailable');
    // A membership collection records who gained or lost the right; any other write to it is an ordinary record event.
    if (this.spec.membership && record !== undefined && (action === 'created' || action === 'deleted')) {
      writeAuditEvent(db, this.name, this.auditor.validate, membershipEvent(this.name, action === 'created' ? 'added' : 'removed', record[this.spec.key!] as string, who));
      return true;
    }
    const names = [...fields]; let truncated = false;
    while (Buffer.byteLength(JSON.stringify(names)) > AUDIT_FIELDS_BYTES) { names.pop(); truncated = true; }
    writeAuditEvent(db, this.name, this.auditor.validate, { action: `store.record.${action}`, actor: who, subject: `${this.name}/${id}`, metadata: { collection: this.name, ...extra, fields: names, ...(truncated ? { truncated: true } : {}) } });
    return true;
  }
  /** Declared properties whose value differs between two versions of a record (a removed one counts), in declaration order. */
  private changed(before: StoredRecord | undefined, after: StoredRecord | undefined): string[] { return Object.keys(this.spec.records.properties).filter(field => before?.[field] !== after?.[field]); }
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
  /** A principal where none is required: absent stays absent, but one that is given must be a principal id (#1015). */
  private optionalPrincipal(id: string | undefined): string | undefined { return id === undefined ? undefined : this.principal(id); }
  /**
   * The actor a write stamps or records (#1015): the principal id, or `anonymous`. Every entry point passes a validated
   * one; checked again here because a stamped or audited actor is stored, and one outside `principalIdPattern` (a lone
   * surrogate, over 128 characters) would leave a row the collection can no longer serve.
   */
  private actorOf(actor: string | undefined): string {
    if (actor === undefined) return 'anonymous';
    return this.principal(actor);
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
  private admit(db: StoreDatabase, members: string | undefined, principal: string | undefined): void {
    if (members !== undefined && (principal === undefined || !isMember(db, members, principal))) throw new StoreError(403, 'membership_required', 'You are not allowed to do this');
  }
  /**
   * `may` (#873): for each record, the names of the transitions `principal` may run on it right now, by the rules
   * `transition` applies, read in the caller's transaction: the record holds every `from` value; `by: owner` needs the
   * caller to own it and `by: others` needs it to be someone else's; a `members` gate needs the caller listed. Only
   * the caller's own membership is looked up, once per distinct gate and never per record, so the answer is bounded
   * by the page and says nothing about anyone else's. Without a principal only an ungated transition on a shared
   * collection can be offered, which the declaration already says. A read-only collection runs none.
   */
  private mayIn(db: StoreDatabase, records: readonly StoredRecord[], principal: string | undefined, shown?: readonly string[]): Record<string, string[]> {
    const caller = typeof principal === 'string' && principalIdPattern.test(principal) ? principal : undefined, gates = new Map<string, boolean>();
    const admitted = (members: string): boolean => {
      if (!gates.has(members)) gates.set(members, isMember(db, members, caller!));
      return gates.get(members)!;
    };
    // On a projected readers mount (`shown`), a transition whose `from` names a hidden property would disclose its value.
    const declared = this.spec.readOnly ? [] : Object.entries(this.spec.transitions).filter(([, transition]) => shown === undefined || Object.keys(transition.from).every(field => shown.includes(field)));
    // The gate is asked last and remembered, so a page no gated transition applies to looks nothing up.
    return Object.fromEntries(records.map(record => [record.id as string, declared.filter(([, transition]) =>
      // Who: anyone for an ungated shared transition; otherwise a principal, which `by` then compares with the owner.
      (transition.by === 'any' && transition.members === undefined || caller !== undefined && (transition.by === 'any' || (transition.by === 'owner' ? record[OWNER_FIELD] === caller : record[OWNER_FIELD] !== undefined && record[OWNER_FIELD] !== caller)))
      && Object.entries(transition.from).every(([field, value]) => record[field] === value)
      && (transition.members === undefined || admitted(transition.members))).map(([name]) => name)]));
  }
  /**
   * The readers mount `reader` (#863, #944), for a member of its `members` (or, on a projection without `members`, any
   * principal): one page of every owner's records (`total`, sort, filters and cursor over all of them; a record with no
   * owner is nobody's and is left out). The principal (401) and the membership gate (403) come first, in the same read
   * transaction, before the query is parsed or any record is read. Read-only.
   */
  listAcross(reader: string, params: URLSearchParams, principal: string | undefined): Page {
    return this.across(reader, principal, (db, shown) => {
      // A projection (#929) sorts and filters by the properties it shows only: an order or a match on a hidden one
      // would disclose it (a sort by balance ranks every wallet).
      const spec = shown === undefined ? this.spec : { ...this.spec, sortable: this.spec.sortable.filter(field => shown.includes(field)), filterable: this.spec.filterable.filter(field => shown.includes(field)) };
      const page = this.listIn(db, parseListQuery(spec, params), null);
      return { ...page, may: this.mayIn(db, page.items, principal, shown) };
    });
  }
  /** One owned record and its `may` on the readers mount `reader` (the gate as `listAcross`); a missing or malformed id is 404. */
  getAcross(reader: string, id: string, principal: string | undefined): Shown {
    return this.across(reader, principal, (db, shown) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new StoreError(404, 'not_found', 'No such record');
      const record = this.anyOwned(db, id);
      return { record, may: this.mayIn(db, [record], principal, shown)[record.id as string]! };
    });
  }
  private across<T>(reader: string, principal: string | undefined, work: (db: StoreDatabase, shown: readonly string[] | undefined) => T): T {
    const readers = Object.hasOwn(this.spec.readers, reader) ? this.spec.readers[reader] : undefined;
    if (!readers) throw new StoreError(404, 'not_found', 'No such collection');
    const caller = this.principal(principal);
    return this.read(db => { this.admit(db, readers.members, caller); return work(db, readers.properties); });
  }

  /**
   * Lists one page of the caller's scope. On an owned collection `total`, the page and the cursor are all computed
   * over the caller's own records only. Throws a 400 StoreError for an undeclared sort or filter name, a malformed
   * value or a cursor that does not belong to the sort.
   */
  list(params: URLSearchParams, owner?: string, viewer?: Viewer): Page {
    const scope = this.scope(owner), query = parseListQuery(this.spec, params);
    return this.read(db => this.viewed(db, this.listIn(db, query, scope), viewer));
  }
  /** A page with `may` for its records when it was read for a viewer, in the same transaction. */
  private viewed(db: StoreDatabase, page: Page, viewer: Viewer | undefined): Page {
    return viewer ? { ...page, may: this.mayIn(db, page.items, viewer.principal) } : page;
  }
  private shown(db: StoreDatabase, record: StoredRecord, principal: string | undefined): Shown {
    return { record, may: this.mayIn(db, [record], principal)[record.id as string]! };
  }
  /**
   * One page inside an open transaction. An unsorted, unfiltered page is a counted `LIMIT`/`OFFSET` query in creation
   * order. A sorted or filtered one is a counted keyset query through the declared list indexes (listing.ts, #951). When
   * a row or value is one the SQL key cannot order exactly (listing.ts `anomaly`), the in-memory path answers instead:
   * it reads only the id and the named fields of every record in scope (each field as its exact JSON text, so numbers
   * and strings compare exactly as the declared-type rules in query.ts say), orders and filters those in memory, and
   * then reads the page's records by id. Both answer the same page, `total` and cursors.
   */
  private listIn(db: StoreDatabase, query: ReturnType<typeof parseListQuery>, scope: string | undefined | null): Page {
    const where = this.where(scope);
    if (!query.sort && !query.filters.length) {
      const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM store_records WHERE ${where.sql}`, ...where.values)!.n;
      const items = db.all<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE ${where.sql} ORDER BY seq LIMIT ? OFFSET ?`, ...where.values, query.limit, query.offset).map(row => this.parse(row));
      const end = query.offset + items.length;
      return { items, total, ...(end < total ? { next: end } : {}) };
    }
    // In SQL through the declared indexes (#951), unless a row or value is one its key cannot order exactly.
    const listed = this.listing && listInSql(db, this.listing, query, scope, COLUMNS, row => this.parse(row));
    if (listed) return listed;
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
  /** `get` for an HTTP viewer: the record and the transitions `principal` may run on it, read in one transaction. */
  show(id: string, owner: string | undefined, principal: string | undefined): Shown {
    const scope = this.scope(owner);
    return this.read(db => this.shown(db, this.current(db, id, scope), principal));
  }
  getByKey(key: string): StoredRecord {
    return this.read(db => {
      const row = db.get<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? AND key = ?`, this.name, key);
      const record = row && this.parse(row);
      if (!record || this.spec.key === undefined || record[this.spec.key] !== key) throw new StoreError(404, 'not_found', 'No such record');
      return record;
    });
  }

  /**
   * Every write takes `actor`: the request principal's id, or `anonymous`. On an audited collection it is the event's
   * actor. `principal` is the caller: on an owned collection the new record's owner, and with `create.members` the
   * principal the membership gate checks (401 without one, before anything is read; 403 inside the write transaction
   * before the retained `Idempotency-Key`, so a removed member's retry is refused rather than replayed).
   */
  create(input: unknown, retry?: Retry, principal?: string, actor?: string, viewer?: Viewer): Written {
    const scope = this.scope(principal), creator = this.creator(principal);
    this.writable();
    return this.write(db => {
      this.admit(db, this.spec.create?.members, creator);
      return this.idempotent(db, retry, 201, id => this.current(db, id, scope), () => this.createIn(db, input, principal, actor));
    }, viewer);
  }
  /** Who creates: the principal a `create.members` gate checks (401 without one), or undefined when create is ungated. */
  private creator(principal: string | undefined): string | undefined {
    return this.spec.create === undefined ? undefined : this.principal(principal);
  }
  /** `replace` (PUT) rebuilds every property from the body and the defaults; otherwise (PATCH) only the named properties
   * change, and a `null` removes one. Either way the resulting record must satisfy the collection schema (a cleared
   * required property is its `required` issue), and an increment property cannot be cleared.
   * `expectedEtag`, when given, must match the record's current ETag, read inside the same transaction as the write,
   * or the update is refused with 412 instead of silently overwriting a change the caller never saw. */
  update(id: string, input: unknown, replace: boolean, retry?: Retry, expectedEtag?: string, owner?: string, actor?: string, viewer?: Viewer): Written {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => this.idempotent(db, retry, 200, found => this.current(db, found, scope), () => this.updateIn(db, id, input, replace, expectedEtag, scope, actor)), viewer);
  }
  remove(id: string, retry?: Retry, expectedEtag?: string, owner?: string, actor?: string): Written {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => this.idempotent(db, retry, 204, found => this.current(db, found, scope), () => this.removeIn(db, id, expectedEtag, scope, actor)));
  }
  /** Public increment API (`POST .../increment/<field>`): refused on a `readOnly` collection like every other write. */
  increment(id: string, field: string, retry?: Retry, owner?: string, actor?: string, viewer?: Viewer): Written {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => this.idempotent(db, retry, 200, found => this.current(db, found, scope), () => {
      const record = this.incremented(db, id, field, scope, true);
      return { record, audited: this.audited(db, 'incremented', id, [field], actor) };
    }), viewer);
  }
  /**
   * Runs the declared transition `name` on record `id` for `principal` (#835). An unknown name is a 404. Checked in
   * this order, all inside the one write transaction: with `members`, the membership gate (403); the retained
   * `Idempotency-Key`; the record in the transition's
   * scope (404); for `by: others`, that the caller is not its owner (403); `If-Match` (412); every `from` value (409
   * `transition_conflict`). Only then are the `set` values, the `stamp` values and `updatedAt` written with the claim
   * and the audit event. Any refusal writes nothing.
   */
  transition(id: string, name: string, retry?: Retry, expectedEtag?: string, principal?: string, actor?: string, viewer?: Viewer): Written {
    const transition = hasOwn(this.spec.transitions, name) ? this.spec.transitions[name]! : undefined;
    if (!transition) throw new StoreError(404, 'not_found', 'No such transition');
    // `principal` is checked before anything is read: owner scoping, the caller an others transition compares, or a member.
    const caller = this.caller(transition, principal);
    this.writable();
    // The membership gate comes before the retained key, so a removed member's retry is refused rather than replayed.
    return this.write(db => {
      if (caller !== undefined) this.admit(db, transition.members, caller);
      return this.idempotent(db, retry, 200, found => this.transitionTarget(db, found, transition, caller), () => this.transitionIn(db, id, name, expectedEtag, caller, actor));
    }, viewer);
  }
  /** Who runs a transition: any caller on an ungated shared one, otherwise a principal (401 without one). */
  private caller(transition: NormalizedTransition, principal: string | undefined): string | undefined {
    return transition.by === 'any' && transition.members === undefined ? this.optionalPrincipal(principal) : this.principal(principal);
  }
  /**
   * Runs the declared transfer `name` for `principal` (#902): `input` is the request body `{from, to, amount}`. An
   * unknown name is a 404; the principal (401), `readOnly` (405) and the body (422 `invalid_transfer`) are checked
   * before the database. Inside the one write transaction, in order: with `members`, the membership gate (403); the
   * retained `Idempotency-Key` (a replay answers both records as they are now, the credited one only when the caller
   * may read it); then `transferIn`. Any refusal writes nothing.
   */
  transfer(name: string, input: unknown, retry?: Retry, expectedEtag?: string, principal?: string, actor?: string): Transferred {
    const transfer = this.transferNamed(name), caller = this.transferCaller(transfer, principal);
    this.writable();
    const body = transferBody(input), db = this.database();
    let outcome: { result: Transferred; audited: boolean };
    try {
      outcome = db.transaction(() => {
        this.fenced(db);
        if (caller !== undefined) this.admit(db, transfer.members, caller);
        const done = this.idempotent(db, retry, 200, id => this.current(db, id, this.transferScope(caller)), () => this.transferIn(db, name, body, expectedEtag, principal, actor));
        return { result: { status: done.result.status, from: done.result.record, to: this.readable(db, body.to, caller), replayed: done.result.replayed }, audited: done.audited };
      });
    } catch (error) { return storageFailure(error, false); }
    if (outcome.audited) this.notifyAudit();
    return outcome.result;
  }
  private transferNamed(name: string): NormalizedTransfer {
    const transfer = hasOwn(this.spec.transfers, name) ? this.spec.transfers[name]! : undefined;
    if (!transfer) throw new StoreError(404, 'not_found', 'No such transfer');
    return transfer;
  }
  /** Who runs a transfer: any caller on an ungated shared collection, otherwise a principal (401 without one). */
  private transferCaller(transfer: NormalizedTransfer, principal: string | undefined): string | undefined {
    return !this.owned && transfer.members === undefined ? this.optionalPrincipal(principal) : this.principal(principal);
  }
  /** The scope the debited record is read in: the caller's own records on an owned collection, every record otherwise. */
  private transferScope(caller: string | undefined): string | undefined { return this.owned ? caller : undefined; }
  /** Whether `reader` may read `record`: any record of a shared collection, only its own on an owned one. */
  visible(record: StoredRecord, reader: string | undefined): boolean { return !this.owned || (reader !== undefined && record[OWNER_FIELD] === reader); }
  /** Record `id` as it is now when `reader` may read it, else undefined. */
  private readable(db: StoreDatabase, id: string, reader: string | undefined): StoredRecord | undefined {
    const row = db.get<RecordRow>(`SELECT ${COLUMNS} FROM store_records WHERE collection = ? AND id = ?`, this.name, id);
    const record = row && this.parse(row);
    return record && this.visible(record, reader) ? record : undefined;
  }
  recordClick(id: string, field: string): StoredRecord {
    // Store-owned click-counter bookkeeping for a short-link redirect (dispatchShortLink in store.ts), never reachable
    // from the public record API. Per the #552 triage decision, this is the one write a `readOnly` collection still
    // accepts: `readOnly` closes the public create/update/delete/increment surface, not the redirect's own click
    // count. It skips `writable()` and takes no Idempotency-Key. It is never audited: anyone can drive it without
    // credentials or a budget, and audit's retention is shared with every producer's events, which a flood of clicks
    // would prune. Short links need a key, which an owned collection refuses; this stays unreachable for owned records.
    if (this.owned) throw new StoreError(404, 'not_found', 'No such record');
    return this.write(db => ({ result: { status: 200, record: this.incremented(db, id, field, undefined, false), replayed: false }, audited: false })).record!;
  }

  // The write steps. Each runs inside a transaction its caller opened (`write` above, or a host transaction in
  // records.ts) and returns the record it left and whether it inserted an audit event. They are the only code that
  // changes a record, so the HTTP API, the records export and host transactions apply one set of rules.

  /** The record `id` in the owner's scope, inside an open transaction (a host transaction's `get`). */
  getIn(db: StoreDatabase, id: string, owner: string | undefined): StoredRecord { return this.current(db, id, this.scope(owner)); }
  /** One page inside an open transaction (a host transaction's `list`). */
  listPageIn(db: StoreDatabase, params: URLSearchParams, owner: string | undefined): Page {
    const scope = this.scope(owner);
    return this.listIn(db, parseListQuery(this.spec, params), scope);
  }
  /**
   * The create step for `principal`: the owner on an owned collection, and the caller a `create.members` gate checks
   * (401 without one, 403 for a non-member) before the body or any record is read.
   */
  createIn(db: StoreDatabase, input: unknown, principal: string | undefined, actor: string | undefined): Step {
    this.writable();
    const scope = this.scope(principal);
    this.admit(db, this.spec.create?.members, this.creator(principal));
    const clean = this.validated({ ...this.spec.records.defaults, ...this.bodyOf(input) });
    if (this.spec.key && this.keyTaken(db, clean[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
    // Checked before the collection-wide ceiling, and the message is fixed: it states neither the caller's count, any
    // other owner's count nor the collection total (urlcode#731).
    if (scope !== undefined && this.spec.maxRecordsPerOwner !== undefined && db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ? AND owner = ?', this.name, scope)!.n >= this.spec.maxRecordsPerOwner) throw new StoreError(409, 'owner_quota_exceeded', 'You hold the most records this collection allows each user');
    if (db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ?', this.name)!.n >= this.spec.maxRecords) throw new StoreError(409, 'collection_full', `Collection holds its maximum of ${this.spec.maxRecords} records`);
    const now = stamp(), record: StoredRecord = { id: randomUUID(), createdAt: now, updatedAt: now, ...(scope === undefined ? {} : { [OWNER_FIELD]: scope }), ...clean };
    this.sized(record);
    this.uniqueIn(db, record);
    this.fits(db, record, scope);
    this.insert(db, record);
    return { record, audited: this.audited(db, 'created', record.id as string, this.changed(undefined, record), actor, {}, record) };
  }
  /** Creates for `principal` inside an open transaction (a host transaction's `create`). */
  createFor(db: StoreDatabase, input: unknown, principal: string | undefined, actor: string | undefined): Step { return this.createIn(db, input, principal, actor); }
  updateIn(db: StoreDatabase, id: string, input: unknown, replace: boolean, expectedEtag: string | undefined, scope: string | undefined, actor: string | undefined): Step {
    this.writable();
    // Scoped before the ETag and body checks, so another owner's record answers exactly like a missing one.
    const current = this.current(db, id, scope);
    if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
    refuseLocked(this.spec, 'editable', current);
    const body = this.bodyOf(input), stored = fieldsOf(current);
    let values: Record<string, unknown>;
    if (replace) {
      // PUT rebuilds the properties from the body and the defaults, except readOnly ones, which keep their stored value.
      const readOnly = this.spec.records.readOnly;
      values = { ...Object.fromEntries(Object.entries(this.spec.records.defaults).filter(([field]) => !readOnly.includes(field))), ...body, ...Object.fromEntries(readOnly.filter(field => hasOwn(stored, field)).map(field => [field, stored[field]])) };
    } else {
      // PATCH changes the named properties; `null` removes one, which the schema then judges (a required one is missing).
      if (Object.keys(body).length === 0) throw invalidRecord([{ pointer: '', keyword: 'minProperties', message: 'must set or clear at least one property' }]);
      const cleared = Object.keys(body).filter(field => body[field] === null);
      const counters = cleared.filter(field => this.spec.increments.includes(field));
      if (counters.length) throw invalidRecord(counters.map(field => ({ pointer: `/${field}`, keyword: 'increments', message: 'is an increment property and cannot be cleared' })));
      values = { ...stored, ...body };
      // A null for an undeclared name stays, so the schema refuses the name.
      for (const field of cleared) if (hasOwn(this.spec.records.properties, field)) delete values[field];
    }
    const clean = this.validated(values);
    // The owner is carried over from the stored record, never from the body (the schema refuses an `_owner` key).
    const record: StoredRecord = { id: current.id!, createdAt: current.createdAt!, updatedAt: stamp(current.updatedAt as string), ...(current[OWNER_FIELD] === undefined ? {} : { [OWNER_FIELD]: current[OWNER_FIELD] }), ...clean };
    if (this.spec.key && record[this.spec.key] !== current[this.spec.key]) {
      // A member is added and removed, never renamed, so every grant and revocation is its own event.
      if (this.spec.membership) throw invalidRecord([{ pointer: `/${this.spec.key}`, keyword: 'membership', message: 'cannot be changed; remove the member and add the new one' }]);
      if (this.keyTaken(db, record[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
    }
    this.sized(record);
    this.uniqueIn(db, record, current);
    this.fits(db, record, scope);
    this.replaceRow(db, record);
    return { record, audited: this.audited(db, replace ? 'replaced' : 'updated', id, this.changed(current, record), actor) };
  }
  /** A partial update in the owner's scope inside an open transaction (a host transaction's `update`). */
  updateFor(db: StoreDatabase, id: string, patch: unknown, expectedEtag: string | undefined, owner: string | undefined, actor: string | undefined): Step { return this.updateIn(db, id, patch, false, expectedEtag, this.scope(owner), actor); }
  removeIn(db: StoreDatabase, id: string, expectedEtag: string | undefined, scope: string | undefined, actor: string | undefined): Step {
    this.writable();
    const current = this.current(db, id, scope);
    if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
    refuseLocked(this.spec, 'deletable', current);
    refuseBalance(this.spec, current);
    db.run('DELETE FROM store_records WHERE collection = ? AND id = ?', this.name, id);
    return { record: undefined, audited: this.audited(db, 'deleted', id, this.changed(current, undefined), actor, {}, current) };
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
    const stamped = Object.fromEntries(Object.entries(transition.stamp).map(([field, source]) => [field, source === 'now' ? updatedAt : this.actorOf(actor)]));
    // Activation keeps a stamp property able to hold any principal id or instant; judged again, since the row is stored.
    const refused = Object.entries(stamped).map(([field, value]) => propertyIssue(this.spec.records, field, value)).filter(issue => issue !== undefined);
    if (refused.length) throw invalidRecord(refused);
    const record: StoredRecord = { ...current, updatedAt, ...transition.set, ...stamped };
    this.sized(record);
    // A transition can bring a record under the constraint (a `reopen` back to `when`), so it is checked like any write.
    if (this.spec.intervals) {
      const issues = intervalIssues(this.spec.intervals, record);
      if (issues.length) throw invalidRecord(issues);
      this.fits(db, record, caller);
    }
    this.replaceRow(db, record);
    return { record, audited: this.audited(db, 'transitioned', id, this.changed(current, record), actor, { transition: name }) };
  }
  /**
   * The transfer step (#902), inside an open transaction (the HTTP API's, or a host transaction's). In order: with
   * `members`, the membership gate (403); the debited record in the caller's scope (404, so another owner's record
   * is a missing one); `If-Match` on it (412); the floor, `min` (409 `insufficient_balance`); the credited record,
   * any owned record on an owned collection (404); the debited value within the amount property's schema (409
   * `transfer_limit`) and the debited record's size (413); then one fixed 409 `transfer_conflict` for anything about
   * the credited record. Activation bounds the amount property from below only and the supply within the safe
   * integers, and every write reserves the room a balance can take, so under the declaration that last answer never
   * depends on the credited record's balance (#973); it is left for a row stored outside it. The floor is checked
   * before the credited record is read, so a caller cannot learn whether an id exists without funds to move. Then
   * both rows, each with a new `updatedAt`, and one `store.record.transferred` event per record, all in the one
   * transaction: the sum never changes.
   */
  transferIn(db: StoreDatabase, name: string, input: unknown, expectedEtag: string | undefined, principal: string | undefined, actor: string | undefined): TransferStep {
    this.writable();
    const transfer = this.transferNamed(name), caller = this.transferCaller(transfer, principal), body = transferBody(input), field = transfer.amount;
    if (caller !== undefined) this.admit(db, transfer.members, caller);
    const from = this.current(db, body.from, this.transferScope(caller));
    if (expectedEtag !== undefined && expectedEtag !== etagOf(from)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
    const held = from[field];
    // Activation refuses a stored row without a whole balance; one edited into the database since is not assumed to hold one.
    if (!Number.isSafeInteger(held)) throw new StoreError(409, 'transfer_conflict', 'A record does not hold a whole balance to transfer');
    const debited = (held as number) - body.amount;
    if (debited < transfer.min) throw new StoreError(409, 'insufficient_balance', 'The balance is too low for this transfer');
    const to = this.owned ? this.anyOwned(db, body.to) : this.current(db, body.to, undefined);
    if (propertyIssue(this.spec.records, field, debited)) throw new StoreError(409, 'transfer_limit', 'The transfer would leave a balance its property does not allow');
    const debit: StoredRecord = { ...from, updatedAt: stamp(from.updatedAt as string), [field]: debited };
    this.sized(debit);
    // One answer with no detail for every credit-side refusal: on an owned collection the credited record is another
    // owner's, and a distinct code per limit would read its balance (#973).
    const credited = Number.isSafeInteger(to[field]) ? (to[field] as number) + body.amount : Number.NaN;
    const credit: StoredRecord = { ...to, updatedAt: stamp(to.updatedAt as string), [field]: credited };
    if (!Number.isSafeInteger(credited) || propertyIssue(this.spec.records, field, credited) || this.oversized(credit)) throw new StoreError(409, 'transfer_conflict', 'The credited record cannot take this transfer');
    this.replaceRow(db, debit); this.replaceRow(db, credit);
    const audited = this.audited(db, 'transferred', debit.id as string, [field], actor, { transfer: name, side: 'from', counterpart: credit.id as string });
    this.audited(db, 'transferred', credit.id as string, [field], actor, { transfer: name, side: 'to', counterpart: debit.id as string });
    return { record: debit, to: credit, audited };
  }
  /**
   * Raises `field` by one. `locked`: the public increment, which `editable` gates like a PATCH (#989), so a record
   * outside its editable states keeps every value its reviewer saw; a short link's click count is not gated.
   */
  private incremented(db: StoreDatabase, id: string, field: string, owner: string | undefined, locked: boolean): StoredRecord {
    if (!this.spec.increments.includes(field)) throw new StoreError(404, 'not_found', 'No such increment');
    const current = this.current(db, id, owner);
    if (locked) refuseLocked(this.spec, 'editable', current);
    const value = (current[field] as number) + 1, issue = propertyIssue(this.spec.records, field, value);
    if (issue) throw new StoreError(409, 'increment_limit', 'The increment would violate the property\'s schema', { issues: [issue] });
    const record: StoredRecord = { ...current, updatedAt: stamp(current.updatedAt as string), [field]: value };
    this.sized(record);
    this.replaceRow(db, record);
    return record;
  }
}
