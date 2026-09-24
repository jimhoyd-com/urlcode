import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { QUERY_LIMITS, parseListQuery, queryableString, runList } from './query.ts';

/** Reserved names the store owns on every record. */
export const RESERVED_FIELDS = ['id', 'createdAt', 'updatedAt'] as const;
export const LIMITS = { fields: 64, records: 10_000, recordBytes: 65_536, pageSize: 200, stringLength: 65_536 } as const;
const IDEMPOTENCY_LIMITS = { keys: 1_000, keyLength: 128 } as const;

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
    mount: { type: 'string', pattern: '^/[A-Za-z0-9._~/-]*[A-Za-z0-9._~-]$', maxLength: 256 },
    fields: { type: 'object', minProperties: 1, maxProperties: LIMITS.fields, propertyNames: { pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, additionalProperties: {
      type: 'object', additionalProperties: false, required: ['type'],
      properties: {
        type: { enum: ['string', 'integer', 'number', 'boolean'] }, required: { type: 'boolean' },
        default: { oneOf: [{ type: 'string', maxLength: LIMITS.stringLength }, { type: 'number' }, { type: 'boolean' }] },
        minLength: { type: 'integer', minimum: 0, maximum: LIMITS.stringLength }, maxLength: { type: 'integer', minimum: 1, maximum: LIMITS.stringLength }, format: { enum: ['http-url'] },
        enum: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: [{ type: 'string', maxLength: 256 }, { type: 'number' }] } },
        minimum: { type: 'number' }, maximum: { type: 'number' },
      },
    } },
    maxRecords: { type: 'integer', minimum: 1, maximum: LIMITS.records },
    maxRecordBytes: { type: 'integer', minimum: 256, maximum: LIMITS.recordBytes },
    pageSize: { type: 'integer', minimum: 1, maximum: LIMITS.pageSize },
    readOnly: { type: 'boolean' },
    key: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' },
    increments: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' } },
    idempotency: { type: 'object', additionalProperties: false, required: ['maxKeys'], properties: { maxKeys: { type: 'integer', minimum: 1, maximum: IDEMPOTENCY_LIMITS.keys } } },
    sortable: { type: 'array', maxItems: QUERY_LIMITS.declared, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' } },
    filterable: { type: 'array', maxItems: QUERY_LIMITS.declared, uniqueItems: true, items: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' } },
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
  key?: string; increments: string[]; idempotency?: IdempotencySpec; sortable: string[]; filterable: string[];
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
  const increments = spec.increments ?? [];
  for (const fieldName of increments) {
    const field = spec.fields[fieldName];
    if (!field) throw new Error(`Collection ${name}: increment field ${fieldName} is not declared`);
    if (!['integer', 'number'].includes(field.type) || typeof field.default !== 'number') throw new Error(`Collection ${name}: increment field ${fieldName} must be numeric with a numeric default`);
  }
  return { mount: spec.mount, fields: spec.fields, ...(key === undefined ? {} : { key }), increments, ...(spec.idempotency === undefined ? {} : { idempotency: spec.idempotency }), sortable: queryable('sortable'), filterable: queryable('filterable'), maxRecords: spec.maxRecords ?? 1000, maxRecordBytes: spec.maxRecordBytes ?? 4096, pageSize: spec.pageSize ?? 50, readOnly: spec.readOnly ?? false };
}

/**
 * One collection: an in-memory array mirrored to one JSON file. Every mutation is applied to a copy, written
 * (temporary file, fsync, rename, directory fsync) and only then swapped in, so a failed write changes nothing.
 * Mutations run one at a time through a promise chain; that ordering is the only concurrency control, which is why
 * the directory is single-writer (see store.ts).
 */
export class Collection {
  readonly name: string; readonly spec: NormalizedSpec;
  private records: StoredRecord[] = []; private byId = new Map<string, StoredRecord>(); private byKey = new Map<string, StoredRecord>(); private idempotency: string[] = [];
  private readonly file: string; private tail: Promise<unknown> = Promise.resolve();
  constructor(name: string, spec: CollectionSpec, directory: string) { this.name = name; this.spec = normalize(name, spec); this.file = join(directory, `${name}.json`); }

  /** Loads and re-validates the file; a file that violates the declaration refuses activation instead of being served. */
  async load(): Promise<void> {
    let text: string | undefined, missing = false;
    try {
      const info = await stat(this.file);
      if (info.size <= this.spec.maxRecords * this.spec.maxRecordBytes + IDEMPOTENCY_LIMITS.keys * (IDEMPOTENCY_LIMITS.keyLength + 4) + 4096) text = await readFile(this.file, 'utf8');
    } catch (error) { missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
    if (missing) return;
    if (text === undefined) throw new Error(`Collection ${this.name}: data file is unreadable or exceeds the declared limits`);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error(`Collection ${this.name}: data file is not valid JSON`); }
    if (!isRecord(parsed) || ![1, 2].includes(parsed.version as number) || !Array.isArray(parsed.records) || parsed.records.length > this.spec.maxRecords) throw new Error(`Collection ${this.name}: data file has an unsupported shape or exceeds maxRecords`);
    const retained = parsed.version === 2 ? parsed.idempotency : [];
    if (!Array.isArray(retained) || retained.length > IDEMPOTENCY_LIMITS.keys || retained.some(key => typeof key !== 'string' || key.length < 1 || key.length > IDEMPOTENCY_LIMITS.keyLength) || new Set(retained).size !== retained.length) throw new Error(`Collection ${this.name}: data file has invalid idempotency keys`);
    for (const item of parsed.records as unknown[]) {
      if (!isRecord(item) || typeof item.id !== 'string' || this.byId.has(item.id) || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') throw new Error(`Collection ${this.name}: data file holds an invalid record`);
      let clean: StoredRecord;
      try { clean = this.check(item, false); } catch { throw new Error(`Collection ${this.name}: a stored record no longer matches the declared fields`); }
      const record: StoredRecord = { id: item.id, createdAt: item.createdAt, updatedAt: item.updatedAt, ...clean };
      if (this.spec.key && (typeof record[this.spec.key] !== 'string' || this.byKey.has(record[this.spec.key] as string))) throw new Error(`Collection ${this.name}: data file holds an invalid record key`);
      this.records.push(record); this.byId.set(item.id, record);
      if (this.spec.key) this.byKey.set(record[this.spec.key] as string, record);
    }
    this.idempotency = retained as string[];
  }

  /** Validates caller input against the field schema. `full` applies defaults and required checks. */
  private check(input: Record<string, unknown>, full: boolean): StoredRecord {
    const errors: FieldErrors = {}, out: StoredRecord = {};
    for (const key of Object.keys(input)) if (!hasOwn(this.spec.fields, key) && !reserved(key)) errors[key.slice(0, 64)] = 'is not a declared field';
    for (const [key, spec] of Object.entries(this.spec.fields)) {
      if (!hasOwn(input, key) || input[key] === undefined) {
        if (!full) continue;
        if (spec.default !== undefined) out[key] = spec.default; else if (spec.required) errors[key] = 'is required';
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
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }
  private async persist(records: StoredRecord[], idempotency: string[]): Promise<void> {
    const directory = dirname(this.file), temporary = `${this.file}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 2, records, idempotency })); await handle.sync(); }
    catch (error) { await handle.close().catch(() => undefined); await rm(temporary, { force: true }); throw error; }
    await handle.close();
    try { await rename(temporary, this.file); } catch (error) { await rm(temporary, { force: true }); throw error; }
    const dir = await open(directory, 'r').catch(() => undefined);
    if (dir) { await dir.sync().catch(() => undefined); await dir.close(); } // best effort: not every platform can fsync a directory
  }
  private async commit(next: StoredRecord[], idempotency = this.idempotency): Promise<void> {
    try { await this.persist(next, idempotency); }
    catch { throw new StoreError(503, 'storage_unavailable', 'The store could not save this change'); } // no path or system detail
    this.records = next; this.byId = new Map(next.map(record => [record.id as string, record])); this.byKey = this.spec.key ? new Map(next.map(record => [record[this.spec.key!] as string, record])) : new Map(); this.idempotency = idempotency;
  }
  private claimed(key: string | undefined): string[] {
    const config = this.validateIdempotency(key);
    return key && config ? [...this.idempotency, key].slice(-config.maxKeys) : this.idempotency;
  }
  private writable(): void { if (this.spec.readOnly) throw new StoreError(405, 'read_only', 'This collection is read-only'); }

  get count(): number { return this.records.length; }
  /** Lists one page. Throws a 400 StoreError for an undeclared sort or filter name, a malformed value or a cursor that does not belong to the sort. */
  list(params: URLSearchParams): { items: StoredRecord[]; total: number; next?: string | number } { return runList(this.records, parseListQuery(this.spec, params)); }
  get(id: string): StoredRecord { const record = this.byId.get(id); if (!record) throw new StoreError(404, 'not_found', 'No such record'); return record; }
  getByKey(key: string): StoredRecord { const record = this.byKey.get(key); if (!record) throw new StoreError(404, 'not_found', 'No such record'); return record; }
  validateIdempotency(key: string | undefined): IdempotencySpec | undefined {
    if (!key) return undefined;
    const config = this.spec.idempotency;
    if (!config) throw new StoreError(400, 'idempotency_not_enabled', 'This collection does not accept Idempotency-Key');
    if (this.idempotency.includes(key)) throw new StoreError(409, 'idempotency_duplicate', 'This mutation has already been processed');
    return config;
  }

  create(input: unknown, idempotencyKey?: string): Promise<StoredRecord> {
    return this.serialize(async () => {
      this.writable();
      const idempotency = this.claimed(idempotencyKey);
      if (!isRecord(input)) throw new StoreError(400, 'invalid_record', 'Body must be a JSON object');
      const clean = this.check(input, true);
      if (this.spec.key && this.byKey.has(clean[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
      if (this.records.length >= this.spec.maxRecords) throw new StoreError(409, 'collection_full', `Collection holds its maximum of ${this.spec.maxRecords} records`);
      const now = new Date().toISOString(), record: StoredRecord = { id: randomUUID(), createdAt: now, updatedAt: now, ...clean };
      this.sized(record);
      await this.commit([...this.records, record], idempotency);
      return record;
    });
  }
  /** `replace` (PUT) rebuilds every declared field with defaults; otherwise (PATCH) only supplied fields change.
   * `expectedEtag`, when given, must match the record's current ETag (checked inside the same
   * serialized step as the read, so it is race-free against a concurrent writer) or the update is
   * refused with 412 instead of silently overwriting a change the caller never saw. */
  update(id: string, input: unknown, replace: boolean, idempotencyKey?: string, expectedEtag?: string): Promise<StoredRecord> {
    return this.serialize(async () => {
      this.writable();
      const idempotency = this.claimed(idempotencyKey);
      const current = this.get(id);
      if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
      if (!isRecord(input)) throw new StoreError(400, 'invalid_record', 'Body must be a JSON object');
      const clean = this.check(input, replace);
      if (!replace && Object.keys(clean).length === 0) throw new StoreError(400, 'invalid_record', 'Body must set at least one declared field');
      const kept = replace ? {} : Object.fromEntries(Object.entries(current).filter(([key]) => !reserved(key)));
      const record: StoredRecord = { id: current.id!, createdAt: current.createdAt!, updatedAt: new Date().toISOString(), ...kept, ...clean };
      if (this.spec.key && record[this.spec.key] !== current[this.spec.key] && this.byKey.has(record[this.spec.key] as string)) throw new StoreError(409, 'key_exists', 'A record already uses this key');
      this.sized(record);
      await this.commit(this.records.map(item => item === current ? record : item), idempotency);
      return record;
    });
  }
  remove(id: string, idempotencyKey?: string, expectedEtag?: string): Promise<void> {
    return this.serialize(async () => {
      this.writable();
      const idempotency = this.claimed(idempotencyKey);
      const current = this.get(id);
      if (expectedEtag !== undefined && expectedEtag !== etagOf(current)) throw new StoreError(412, 'precondition_failed', 'The record changed since it was last read');
      await this.commit(this.records.filter(item => item !== current), idempotency);
    });
  }
  /** Public increment API (`POST .../increment/<field>`): refused on a `readOnly` collection like every other write. */
  increment(id: string, field: string, idempotencyKey?: string): Promise<StoredRecord> {
    return this.serialize(async () => {
      this.writable();
      const idempotency = this.claimed(idempotencyKey);
      return this.doIncrement(id, field, idempotency);
    });
  }
  /**
   * Store-owned click-counter bookkeeping for a short-link redirect (dispatchShortLink in
   * store.ts), never reachable from the public record API. Per the #552 triage decision, this is
   * the one write a `readOnly` collection still accepts: `readOnly` is documented as closing the
   * public create/update/delete/increment surface, not as disabling the redirect's own click
   * count. It intentionally skips `writable()` and takes no Idempotency-Key — the short-link GET
   * that drives it isn't itself idempotency-scoped.
   */
  recordClick(id: string, field: string): Promise<StoredRecord> {
    return this.serialize(async () => this.doIncrement(id, field, this.idempotency));
  }
  private async doIncrement(id: string, field: string, idempotency: string[]): Promise<StoredRecord> {
    if (!this.spec.increments.includes(field)) throw new StoreError(404, 'not_found', 'No such increment');
    const current = this.get(id), spec = this.spec.fields[field]!;
    const value = (current[field] as number) + 1, problem = checkValue(spec, value);
    if (problem) throw new StoreError(409, 'increment_limit', 'The increment would violate the declared field limits', { [field]: problem });
    const record: StoredRecord = { ...current, updatedAt: new Date().toISOString(), [field]: value };
    this.sized(record);
    await this.commit(this.records.map(item => item === current ? record : item), idempotency);
    return record;
  }
}
