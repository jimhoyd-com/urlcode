import { createHash, randomUUID } from 'node:crypto';
import { principalIdPattern } from '@jimhoyd/urlcode/extensions';
import { bodyIssues, bodySchemaDialect, compileBodySchema } from '@jimhoyd/urlcode/body-schema';
import type { BodySchema, BodySchemaIssue, CompiledBodySchema } from '@jimhoyd/urlcode/body-schema';
import type { AuditEvent } from '@jimhoyd/urlcode-audit';
import { QUERY_LIMITS, parseListQuery, queryableString, runList } from './query.ts';
import type { StoreDatabase } from './database.ts';

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
const MOUNT = { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256 } as const;
const FIELD_NAME = '^[a-z][A-Za-z0-9_]{0,63}$';
const SCALAR = { oneOf: [{ type: 'string', maxLength: 256 }, { type: 'number' }, { type: 'boolean' }] } as const;
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
 * Cross-owner reads on an owned collection: members of the named membership collection list and read every owner's
 * records, read-only, on a separate mount guarded by a principal-providing policy.
 */
export interface ReadersSpec {
  mount: string; members: string;
  /** Include each record's owner (its opaque principal id) as `_owner` in this mount's answers, and nowhere else. */
  showOwner?: boolean;
}
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
   * Properties only a declared transition changes (its `set` or `stamp`): a create stores the default (or leaves them
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
  /** On an owned collection: who may list and read every owner's records, and where. */
  readers?: ReadersSpec;
}
export type StoredRecord = Record<string, Scalar>;
type FieldErrors = Record<string, string>;
/** What a refusal carries besides its code: query parameter names with fixed messages, or record schema issues. */
export interface StoreErrorDetails { fields?: FieldErrors; issues?: readonly BodySchemaIssue[] }

/**
 * Thrown for caller mistakes; carries names and fixed messages only, never a submitted value. A record that breaks
 * the collection schema is 422 `invalid_record` with `issues` in core's body-validation issue shape; a list query is
 * 400 `invalid_query` with `fields` naming the offending parameters.
 */
export class StoreError extends Error {
  readonly status: number; readonly code: string; readonly fields: FieldErrors | undefined; readonly issues: readonly BodySchemaIssue[] | undefined;
  constructor(status: number, code: string, message: string, details: StoreErrorDetails = {}) { super(message); this.status = status; this.code = code; this.fields = details.fields; this.issues = details.issues; }
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
    readOnlyProperties: { type: 'array', maxItems: LIMITS.properties, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'Declared properties only a declared transition (its set or stamp) changes. A create stores the default (or leaves them unset), PUT keeps the stored value, and a POST, PUT or PATCH body naming one answers 422. A required one needs a default, and some transition must set or stamp it. Not the key or an increment. The OpenAPI record marks them readOnly.' },
    maxRecords: { type: 'integer', minimum: 1, maximum: LIMITS.records, description: 'Records the collection may hold (default 1000); a create beyond it answers 409 collection_full.' },
    maxRecordBytes: { type: 'integer', minimum: 256, maximum: LIMITS.recordBytes, description: 'Largest serialized record in bytes (default 4096); larger answers 413.' },
    pageSize: { type: 'integer', minimum: 1, maximum: LIMITS.pageSize, description: 'Records per list page, and the cap on a list request\'s limit (default 50).' },
    readOnly: { type: 'boolean', description: 'true: the API serves only GET and HEAD (other methods answer 405); short-link click counting still works.' },
    key: { type: 'string', pattern: FIELD_NAME, description: 'A required string property (maxLength at most 128, no default) whose caller-chosen value the collection keeps unique; a duplicate create answers 409 key_exists. Not allowed with ownership: owner.' },
    increments: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: FIELD_NAME }, description: 'Numeric properties with a numeric default that POST <mount>/<id>/increment/<property> raises by exactly one in one database transaction, within the property\'s schema (409 increment_limit otherwise).' },
    idempotency: { description: 'Enables the Idempotency-Key header on POST, PUT, PATCH, DELETE, increment and transitions. A retry with a retained key and the same request (method, path, body) replays the first answer\'s status with the record as it is now; the same key on a different request answers 422 idempotency_key_reused. Without it the header answers 400 idempotency_not_enabled. A key is scoped to the request principal, or to the network client when there is none.', type: 'object', additionalProperties: false, required: ['maxKeys'], properties: { maxKeys: { type: 'integer', minimum: 1, maximum: IDEMPOTENCY_LIMITS.keys, description: 'Newest distinct keys the collection retains, across all callers; an evicted key is no longer protected and a retry with it runs again.' } } },
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
    membership: { type: 'boolean', description: 'true: a membership list. Its key property holds principal ids (one record per member); transitions and readers name it in members. It has no mount and no HTTP API: the operator maintains it with urlcode-store members or trusted extension code (StoreExports); a member\'s key cannot be changed, only removed and added. Needs key; takes no mount, ownership, transitions, readers, increments, idempotency, sortable, filterable or readOnly. With audit: true every added and removed member is recorded.' },
    readers: { description: 'With ownership: owner only: members of a membership collection list and read every owner\'s records, read-only, as GET <mount> (with the collection\'s limit, cursor, sort and filters) and GET <mount>/<id>. Owners keep their own view on the collection mount. The stored owner is shown only with showOwner.', type: 'object', additionalProperties: false, required: ['mount', 'members'], properties: {
      mount: { ...MOUNT, description: 'A separate mount: a route <mount>/* with extension: store (GET, HEAD) and a principal-providing policy.' },
      members: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$', description: 'A membership collection: anyone it does not list gets 403 membership_required before any record is read.' },
      showOwner: { type: 'boolean', description: 'true: every record this mount answers carries _owner, the opaque principal id of the owner (for auth, the user id; never an email or name), so a member can tell requesters apart. Only this mount shows it: the owner\'s mount, transitions and StoreExports never do.' },
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
    const issue = bodyIssues(partial, { [property]: value }, 1)[0];
    if (issue) throw new Error(`${at} ${issue.message}`);
    defaults[property] = value as Scalar;
  }
  const readOnly = [...layer.readOnlyProperties ?? []];
  for (const property of readOnly) if (!hasOwn(properties, property)) throw new Error(`Collection ${name}: readOnlyProperties names ${property.slice(0, 64)}, which is not a declared property`);
  return { schema: deepFreeze(structuredClone(schema) as unknown as RecordSchema), ...(schemaName === undefined ? {} : { schemaName }), properties: deepFreeze(structuredClone(properties) as Record<string, PropertySchema>), required: Object.freeze([...required as string[]]), defaults: Object.freeze(defaults), readOnly: Object.freeze(readOnly), record, partial };
}
/** The first issue of one property value against its schema (a filter, a transition value, an increment), or undefined. */
export function propertyIssue(compiled: CompiledRecordSchema, property: string, value: unknown): BodySchemaIssue | undefined {
  return bodyIssues(compiled.partial, { [property]: value }, 1)[0];
}

export interface NormalizedSpec {
  mount?: string; records: CompiledRecordSchema; maxRecords: number; maxRecordBytes: number; pageSize: number; readOnly: boolean;
  key?: string; increments: string[]; idempotency?: IdempotencySpec; sortable: string[]; filterable: string[]; ownership: Ownership;
  maxRecordsPerOwner?: number; audit: boolean; transitions: Record<string, NormalizedTransition>;
  membership: boolean; readers?: Required<ReadersSpec>;
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
    const refused = (['mount', 'ownership', 'transitions', 'readers', 'increments', 'idempotency', 'sortable', 'filterable', 'readOnly'] as const).filter(option => spec[option] !== undefined);
    if (refused.length) throw new Error(`Collection ${name}: a membership collection takes no ${refused.join(', ')}`);
    if (key === undefined) throw new Error(`Collection ${name}: a membership collection needs a key, the property holding each member's principal id`);
  } else if (spec.mount === undefined) throw new Error(`Collection ${name}: mount is required`);
  if (key !== undefined) {
    const declared = property(key);
    if (!declared) throw new Error(`Collection ${name}: key ${key} is not a declared property`);
    if (declared.type !== 'string' || !records.required.includes(key) || hasOwn(records.defaults, key) || records.readOnly.includes(key) || typeof declared.maxLength !== 'number' || declared.maxLength > IDEMPOTENCY_LIMITS.keyLength) throw new Error(`Collection ${name}: key ${key} must be a required string property with maxLength at most ${IDEMPOTENCY_LIMITS.keyLength}, no default and not readOnly`);
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
  for (const field of increments) {
    const declared = property(field);
    if (!declared) throw new Error(`Collection ${name}: increment property ${field} is not declared`);
    if (!['integer', 'number'].includes(declared.type) || typeof records.defaults[field] !== 'number' || records.readOnly.includes(field)) throw new Error(`Collection ${name}: increment property ${field} must be numeric with a numeric default and not readOnly`);
  }
  const transitions = transitionsOf(name, spec, records, ownership, key);
  const readers = spec.readers;
  if (readers !== undefined) {
    // Readers widen an owned collection's view to members; a shared collection's mount already shows every record.
    if (ownership !== 'owner') throw new Error(`Collection ${name}: readers needs ownership: owner`);
    if (readers.mount === spec.mount) throw new Error(`Collection ${name}: the readers mount must differ from the collection mount`);
    if (Object.values(transitions).some(transition => transition.mount === readers.mount)) throw new Error(`Collection ${name}: the readers mount must differ from every transition mount`);
  }
  for (const field of records.readOnly) {
    // A create never carries a readOnly property, so a required one is satisfiable only through its default.
    if (records.required.includes(field) && !hasOwn(records.defaults, field)) throw new Error(`Collection ${name}: property ${field} is required and readOnly, so it needs a default`);
    if (!Object.values(transitions).some(transition => hasOwn(transition.set, field) || hasOwn(transition.stamp, field))) throw new Error(`Collection ${name}: property ${field} is readOnly but no transition sets or stamps it`);
  }
  return { ...(spec.mount === undefined ? {} : { mount: spec.mount }), records, ...(key === undefined ? {} : { key }), increments, ...(spec.idempotency === undefined ? {} : { idempotency: spec.idempotency }), sortable: queryable('sortable'), filterable: queryable('filterable'), ownership, ...(perOwner === undefined ? {} : { maxRecordsPerOwner: perOwner }), maxRecords, maxRecordBytes: spec.maxRecordBytes ?? 4096, pageSize: spec.pageSize ?? 50, readOnly: spec.readOnly ?? false, audit: spec.audit ?? false, transitions, membership, ...(readers === undefined ? {} : { readers: { mount: readers.mount, members: readers.members, showOwner: readers.showOwner === true } }) };
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
export interface Written { status: number; record: StoredRecord | undefined; replayed: boolean; may?: string[] }
/**
 * Who a response is computed for (#873): with a viewer, a list page, a read and a write's answer carry `may`, the
 * transitions that viewer may run on each record right now. Trusted callers (StoreExports, the operator CLI) pass none.
 */
export interface Viewer { principal: string | undefined }
/** One list page; `may` is present when the page was read for a `Viewer`. */
export interface Page { items: StoredRecord[]; total: number; next?: string | number; may?: Record<string, string[]> }
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
 * what it checks (the ETag, the key, the quotas, the retained Idempotency-Keys, the audit backlog) and writes the
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
  constructor(name: string, spec: CollectionSpec, auditor?: CollectionAuditor, destinations: readonly string[] = [], schemas: Readonly<Record<string, unknown>> = {}) { this.name = name; this.spec = normalize(name, spec, schemas); this.auditor = auditor; this.destinations = destinations; }

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
    // Judged without `required`: a record stored before a property became required is still served, and its next
    // write must supply it.
    if (bodyIssues(this.spec.records.partial, fields, 1).length) throw new RowError(`Collection ${this.name}: a stored record no longer matches the collection schema`);
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
  private write(work: (db: StoreDatabase) => { result: Written; audited: boolean }, viewer?: Viewer): Written {
    const db = this.database();
    let outcome: { result: Written; audited: boolean };
    try {
      outcome = db.transaction(() => {
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
    const issues = bodyIssues(this.spec.records.record, values);
    if (issues.length) throw invalidRecord(issues);
    const key = this.spec.key;
    if (this.spec.membership && key !== undefined && !principalIdPattern.test(values[key] as string)) throw invalidRecord([{ pointer: `/${key}`, keyword: 'membership', message: 'must be a principal id' }]);
    for (const field of this.destinations) if (hasOwn(values, field) && !redirectable(values[field])) throw invalidRecord([{ pointer: `/${field}`, keyword: 'format', message: 'must be an absolute HTTP(S) URL without credentials or ASCII whitespace' }]);
    return Object.fromEntries(Object.keys(this.spec.records.properties).filter(field => hasOwn(values, field)).map(field => [field, values[field] as Scalar]));
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
  private audited(db: StoreDatabase, action: AuditAction, id: string, fields: readonly string[], actor: string | undefined, transition?: string, record?: StoredRecord): boolean {
    if (!this.spec.audit) return false;
    // Activation refuses an audited collection without an active audit, so this is a wiring error, never a request's.
    if (!this.auditor) throw new StoreError(503, 'audit_unavailable', 'The audit log is unavailable');
    // A membership collection records who gained or lost the right; any other write to it is an ordinary record event.
    if (this.spec.membership && record !== undefined && (action === 'created' || action === 'deleted')) {
      writeAuditEvent(db, this.name, this.auditor.validate, membershipEvent(this.name, action === 'created' ? 'added' : 'removed', record[this.spec.key!] as string, actor ?? 'anonymous'));
      return true;
    }
    const names = [...fields]; let truncated = false;
    while (Buffer.byteLength(JSON.stringify(names)) > AUDIT_FIELDS_BYTES) { names.pop(); truncated = true; }
    writeAuditEvent(db, this.name, this.auditor.validate, { action: `store.record.${action}`, actor: actor ?? 'anonymous', subject: `${this.name}/${id}`, metadata: { collection: this.name, ...(transition === undefined ? {} : { transition }), fields: names, ...(truncated ? { truncated: true } : {}) } });
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
    if (members !== undefined && !isMember(db, members, principal)) throw new StoreError(403, 'membership_required', 'You are not allowed to do this');
  }
  /**
   * `may` (#873): for each record, the names of the transitions `principal` may run on it right now, by the rules
   * `transition` applies, read in the caller's transaction: the record holds every `from` value; `by: owner` needs the
   * caller to own it and `by: others` needs it to be someone else's; a `members` gate needs the caller listed. Only
   * the caller's own membership is looked up, once per distinct gate and never per record, so the answer is bounded
   * by the page and says nothing about anyone else's. Without a principal only an ungated transition on a shared
   * collection can be offered, which the declaration already says. A read-only collection runs none.
   */
  private mayIn(db: StoreDatabase, records: readonly StoredRecord[], principal: string | undefined): Record<string, string[]> {
    const caller = typeof principal === 'string' && principalIdPattern.test(principal) ? principal : undefined, gates = new Map<string, boolean>();
    const admitted = (members: string): boolean => {
      if (!gates.has(members)) gates.set(members, isMember(db, members, caller!));
      return gates.get(members)!;
    };
    const declared = this.spec.readOnly ? [] : Object.entries(this.spec.transitions);
    // The gate is asked last and remembered, so a page no gated transition applies to looks nothing up.
    return Object.fromEntries(records.map(record => [record.id as string, declared.filter(([, transition]) =>
      // Who: anyone for an ungated shared transition; otherwise a principal, which `by` then compares with the owner.
      (transition.by === 'any' && transition.members === undefined || caller !== undefined && (transition.by === 'any' || (transition.by === 'owner' ? record[OWNER_FIELD] === caller : record[OWNER_FIELD] !== undefined && record[OWNER_FIELD] !== caller)))
      && Object.entries(transition.from).every(([field, value]) => record[field] === value)
      && (transition.members === undefined || admitted(transition.members))).map(([name]) => name)]));
  }
  /**
   * The readers mount (#863), for a member of `readers.members`: one page of every owner's records (`total`, sort,
   * filters and cursor over all of them; a record with no owner is nobody's and is left out). The principal (401)
   * and the membership gate (403) come first, in the same read transaction, before the query is parsed or any
   * record is read. Read-only.
   */
  listAcross(params: URLSearchParams, principal: string | undefined): Page {
    return this.across(principal, db => this.viewed(db, this.listIn(db, parseListQuery(this.spec, params), null), { principal }));
  }
  /** One owned record and its `may` for a member of `readers.members` (the gate as `listAcross`); a missing or malformed id is 404. */
  getAcross(id: string, principal: string | undefined): Shown {
    return this.across(principal, db => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new StoreError(404, 'not_found', 'No such record');
      return this.shown(db, this.anyOwned(db, id), principal);
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
   * order. A sorted or filtered one reads only the id and the named fields of every record in scope (each field as its
   * exact JSON text, so numbers and strings compare exactly as the declared-type rules in query.ts say), orders and
   * filters those in memory, and then reads the page's records by id: bounded by `maxRecords`, never a scan of the
   * full record bodies.
   */
  private listIn(db: StoreDatabase, query: ReturnType<typeof parseListQuery>, scope: string | undefined | null): Page {
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

  /** Every write takes `actor`: the request principal's id, or `anonymous`. On an audited collection it is the event's actor. */
  create(input: unknown, retry?: Retry, owner?: string, actor?: string, viewer?: Viewer): Written {
    const scope = this.scope(owner);
    this.writable();
    return this.write(db => this.idempotent(db, retry, 201, id => this.current(db, id, scope), () => this.createIn(db, input, scope, actor)), viewer);
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
      const record = this.incremented(db, id, field, scope);
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
  listPageIn(db: StoreDatabase, params: URLSearchParams, owner: string | undefined): Page {
    const scope = this.scope(owner);
    return this.listIn(db, parseListQuery(this.spec, params), scope);
  }
  createIn(db: StoreDatabase, input: unknown, scope: string | undefined, actor: string | undefined): Step {
    this.writable();
    const clean = this.validated({ ...this.spec.records.defaults, ...this.bodyOf(input) });
    if (this.spec.key && this.keyTaken(db, clean[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
    // Checked before the collection-wide ceiling, and the message is fixed: it states neither the caller's count, any
    // other owner's count nor the collection total (urlcode#731).
    if (scope !== undefined && this.spec.maxRecordsPerOwner !== undefined && db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ? AND owner = ?', this.name, scope)!.n >= this.spec.maxRecordsPerOwner) throw new StoreError(409, 'owner_quota_exceeded', 'You hold the most records this collection allows each user');
    if (db.get<{ n: number }>('SELECT count(*) AS n FROM store_records WHERE collection = ?', this.name)!.n >= this.spec.maxRecords) throw new StoreError(409, 'collection_full', `Collection holds its maximum of ${this.spec.maxRecords} records`);
    const now = stamp(), record: StoredRecord = { id: randomUUID(), createdAt: now, updatedAt: now, ...(scope === undefined ? {} : { [OWNER_FIELD]: scope }), ...clean };
    this.sized(record);
    this.insert(db, record);
    return { record, audited: this.audited(db, 'created', record.id as string, this.changed(undefined, record), actor, undefined, record) };
  }
  /** Creates in the owner's scope inside an open transaction (a host transaction's `create`). */
  createFor(db: StoreDatabase, input: unknown, owner: string | undefined, actor: string | undefined): Step { return this.createIn(db, input, this.scope(owner), actor); }
  updateIn(db: StoreDatabase, id: string, input: unknown, replace: boolean, expectedEtag: string | undefined, scope: string | undefined, actor: string | undefined): Step {
    this.writable();
    // Scoped before the ETag and body checks, so another owner's record answers exactly like a missing one.
    const current = this.current(db, id, scope);
    if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
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
    return { record: undefined, audited: this.audited(db, 'deleted', id, this.changed(current, undefined), actor, undefined, current) };
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
    const current = this.current(db, id, owner), value = (current[field] as number) + 1, issue = propertyIssue(this.spec.records, field, value);
    if (issue) throw new StoreError(409, 'increment_limit', 'The increment would violate the property\'s schema', { issues: [issue] });
    const record: StoredRecord = { ...current, updatedAt: stamp(current.updatedAt as string), [field]: value };
    this.sized(record);
    this.replaceRow(db, record);
    return record;
  }
}
