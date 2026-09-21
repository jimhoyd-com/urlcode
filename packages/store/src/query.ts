import { StoreError } from './collection.ts';
import type { FieldSpec, NormalizedSpec, Scalar, StoredRecord } from './collection.ts';

/** Bounds on what a list request may ask for. A value the caller can make larger than this never reaches a comparison. */
export const QUERY_LIMITS = { declared: 8, filters: 3, parameters: 16, valueLength: 256, cursorLength: 4096, numberLength: 32 } as const;

export interface SortKey { field: string; descending: boolean }
export interface ListQuery {
  limit: number;
  /** Numeric offset for the unsorted order. */
  offset: number;
  /** Keyset position for a sorted order: the last record of the previous page. */
  after: { value: Scalar | null; id: string } | undefined;
  sort: SortKey | undefined;
  filters: [string, Scalar][];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DIGITS = /^\d{1,9}$/;
const INTEGER = /^-?\d{1,16}$/;
const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const own = (object: object, key: string): boolean => Object.hasOwn(object, key);

/** Names a caller-supplied key only when it is a plain identifier; anything else is described, never echoed. */
const named = (key: string): string => (SAFE_NAME.test(key) ? key : '(unsupported name)');
const bad = (fields: Record<string, string>): StoreError => new StoreError(400, 'invalid_query', 'The query is not valid', fields);

/** True when a string field is short enough (or enumerated) to be compared, filtered and carried in a cursor. */
export function queryableString(spec: FieldSpec): boolean {
  if (spec.type !== 'string') return true;
  return spec.enum !== undefined ? spec.enum.every(option => String(option).length <= QUERY_LIMITS.valueLength) : (spec.maxLength ?? Infinity) <= QUERY_LIMITS.valueLength;
}

function filterValue(spec: FieldSpec, raw: string): Scalar | undefined {
  if (spec.type === 'string') return raw.length <= QUERY_LIMITS.valueLength ? raw : undefined;
  if (spec.type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : undefined;
  if (spec.type === 'integer') { if (!INTEGER.test(raw)) return undefined; const n = Number(raw); return Number.isSafeInteger(n) ? n : undefined; }
  if (raw.length > QUERY_LIMITS.numberLength || !NUMBER.test(raw)) return undefined;
  const n = Number(raw); return Number.isFinite(n) ? n : undefined;
}
const sameType = (spec: FieldSpec, value: unknown): value is Scalar =>
  spec.type === 'string' ? typeof value === 'string' && value.length <= QUERY_LIMITS.valueLength : spec.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'number' && Number.isFinite(value) && (spec.type !== 'integer' || Number.isSafeInteger(value));

export function encodeCursor(sort: SortKey, record: StoredRecord): string {
  const value = record[sort.field];
  return Buffer.from(JSON.stringify([sort.field, sort.descending, value === undefined ? null : value, record.id])).toString('base64url');
}
function decodeCursor(spec: NormalizedSpec, sort: SortKey, text: string): { value: Scalar | null; id: string } {
  const invalid = bad({ cursor: 'is not valid for this sort' });
  if (text.length > QUERY_LIMITS.cursorLength) throw invalid;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw invalid;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw invalid; }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw invalid;
  const [field, descending, value, id] = parsed as unknown[];
  if (field !== sort.field || descending !== sort.descending || typeof id !== 'string' || !UUID.test(id)) throw invalid;
  if (value !== null && !sameType(spec.fields[sort.field]!, value)) throw invalid;
  return { value: value as Scalar | null, id };
}

/** Parses `limit`, `cursor`, `sort` and equality filters. Anything not declared is a 400 naming only the key. */
export function parseListQuery(spec: NormalizedSpec, params: URLSearchParams): ListQuery {
  // No prototype, so a hostile key such as __proto__ is recorded like any other instead of being silently dropped.
  const errors: Record<string, string> = Object.create(null) as Record<string, string>, keys = new Set<string>();
  let count = 0;
  for (const key of params.keys()) {
    if (++count > QUERY_LIMITS.parameters) throw bad({ query: 'has too many parameters' });
    if (keys.has(key)) errors[named(key)] = 'may be given only once'; else keys.add(key);
  }
  const filters: [string, Scalar][] = [];
  for (const key of keys) {
    if (key === 'limit' || key === 'cursor' || key === 'sort') continue;
    const field = own(spec.fields, key) && spec.filterable.includes(key) ? spec.fields[key] : undefined;
    if (!field) { errors[named(key)] = 'is not a filterable field'; continue; }
    const value = filterValue(field, params.get(key)!);
    if (value === undefined) errors[key] = `must be a valid ${field.type}`; else filters.push([key, value]);
  }
  if (filters.length > QUERY_LIMITS.filters) errors.filter = `at most ${QUERY_LIMITS.filters} filters per request`;
  let sort: SortKey | undefined;
  const rawSort = params.get('sort');
  if (rawSort !== null) {
    const descending = rawSort.startsWith('-'), field = descending ? rawSort.slice(1) : rawSort;
    if (!own(spec.fields, field) || !spec.sortable.includes(field)) errors[named(field)] = 'is not a sortable field'; else sort = { field, descending };
  }
  const number = (name: string, fallback: number, max: number): number => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    if (!DIGITS.test(raw)) { errors[name] = 'must be a non-negative integer'; return fallback; }
    return Math.min(Number(raw), max);
  };
  const limit = Math.max(number('limit', spec.pageSize, spec.pageSize), 1);
  const cursor = params.get('cursor');
  let offset = 0, after: ListQuery['after'];
  if (cursor !== null) {
    if (sort) {
      try { after = decodeCursor(spec, sort, cursor); }
      catch (error) { if (error instanceof StoreError) Object.assign(errors, error.fields); else throw error; }
    } else offset = number('cursor', 0, 1_000_000_000);
  }
  if (Object.keys(errors).length) throw bad(errors);
  return { limit, offset, after, sort, filters };
}

// Present values first (ascending), absent last, then id; a descending sort reverses all of it, ties included.
function compareKeys(x: Scalar | null, xid: string, y: Scalar | null, yid: string): number {
  if (x === null || y === null) { if (x !== y) return x === null ? 1 : -1; }
  else if (x !== y) return x < y ? -1 : 1; // one declared type per field, so `<` is numeric, boolean (false first) or UTF-16 code unit order
  return xid < yid ? -1 : xid > yid ? 1 : 0;
}

export function runList(records: readonly StoredRecord[], query: ListQuery): { items: StoredRecord[]; total: number; next?: string | number } {
  const matched = query.filters.length ? records.filter(record => query.filters.every(([field, value]) => record[field] === value)) : records;
  if (!query.sort) {
    const items = matched.slice(query.offset, query.offset + query.limit), end = query.offset + items.length;
    return { items, total: matched.length, ...(end < matched.length ? { next: end } : {}) };
  }
  const sort = query.sort, sign = sort.descending ? -1 : 1;
  const valueOf = (record: StoredRecord): Scalar | null => record[sort.field] ?? null;
  const order = (a: StoredRecord, b: StoredRecord): number => sign * compareKeys(valueOf(a), a.id as string, valueOf(b), b.id as string);
  const ordered = [...matched].sort(order);
  let low = 0;
  if (query.after) {
    // First record strictly after the cursor position; a record deleted since the last page changes nothing.
    const { value, id } = query.after;
    let high = ordered.length;
    while (low < high) {
      const mid = (low + high) >> 1, record = ordered[mid]!;
      if (sign * compareKeys(valueOf(record), record.id as string, value, id) > 0) high = mid; else low = mid + 1;
    }
  }
  const items = ordered.slice(low, low + query.limit);
  return { items, total: matched.length, ...(low + items.length < ordered.length ? { next: encodeCursor(sort, items[items.length - 1]!) } : {}) };
}
