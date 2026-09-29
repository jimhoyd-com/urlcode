// Sorted and filtered list pages in SQL (#951): an expression index per sortable or filterable property, keyed so
// that SQLite's byte order is the documented order (query.ts `compareKeys`), and a keyset page read through it. The
// in-memory path (query.ts `runList`) stays the reference and the fallback for rows the key cannot represent exactly.
import { createHash } from 'node:crypto';
import type { NormalizedSpec, Scalar, StoredRecord } from './collection.ts';
import type { StoreDatabase } from './database.ts';
import { encodeCursor } from './query.ts';
import type { ListQuery } from './query.ts';

/** Names embedded in the SQL: the configuration schema admits only these. Anything else is served in memory. */
const COLLECTION_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9_]{0,63}$/;
/** A string holding a lone surrogate, which UTF-8 (and so the SQL key) cannot carry. */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * UTF-8 text as a key whose byte order is UTF-16 code unit order. The two orders differ only between the code points
 * U+E000 to U+FFFF (UTF-8 lead bytes EE and EF) and those above U+FFFF (lead bytes F0 to F4), which UTF-16 writes as
 * surrogates (D800 to DFFF) and so orders first. Lead bytes EE and EF become F5 and F6, bytes well-formed UTF-8 never
 * holds, so they sort after every four-byte sequence; a continuation byte (80 to BF) is never touched.
 */
const utf16 = (text: string): string => `replace(replace(CAST(${text} AS BLOB), x'EE', x'F5'), x'EF', x'F6')`;

/** What a list reads through: the indexes the declaration asks for, and how to key a property and a bound value. */
export interface ListPlan {
  readonly collection: string;
  /** Each `CREATE INDEX IF NOT EXISTS`, by its derived name (`store_list_<hash>`). */
  readonly indexes: ReadonlyMap<string, string>;
  /** A WHERE term true for a row the SQL key would misorder (see `anomaly`). */
  readonly anomaly: string;
  readonly spec: NormalizedSpec;
}

/**
 * The property's sort key: the declared order as SQLite compares values. A string is `utf16` text, a number, an integer
 * or a boolean (1 or 0 from `->>`) is a REAL, compared exactly as JavaScript compares doubles, and an absent value (or
 * JSON null) is the empty BLOB, which SQLite orders after every number and text: present values first, absent last.
 */
function key(spec: NormalizedSpec, field: string): string {
  const value = `data ->> '$.${field}'`;
  return `coalesce(${spec.records.properties[field]!.type === 'string' ? utf16(value) : `CAST(${value} AS REAL)`}, x'')`;
}
/** The same key of one bound parameter (a filter value, a cursor position); `bind` gives what to bind for it. */
function boundKey(spec: NormalizedSpec, field: string): string {
  return `coalesce(${spec.records.properties[field]!.type === 'string' ? utf16('?') : 'CAST(? AS REAL)'}, x'')`;
}
const bind = (value: Scalar | null): string | number | null => typeof value === 'boolean' ? Number(value) : value;

/**
 * A row whose stored value is not what the key represents exactly: a type other than the declared one (a row written
 * under another declaration, #927), or a string holding a lone surrogate (JSON `\uD800` escape, which `->>` decodes to
 * bytes that do not order as UTF-16). A string's JSON text escapes nothing else as `\uD`, and a false positive (an
 * escaped backslash before `ud`) only costs the in-memory path.
 */
function anomaly(spec: NormalizedSpec, field: string): string {
  const type = `json_type(data, '$.${field}')`, declared = spec.records.properties[field]!.type;
  if (declared === 'string') return `${type} NOT IN ('text', 'null') OR instr(data -> '$.${field}', '\\ud') > 0 OR instr(data -> '$.${field}', '\\uD') > 0`;
  return `${type} NOT IN (${declared === 'boolean' ? "'true', 'false'" : "'integer', 'real'"}, 'null')`;
}

/**
 * The list plan of a declaration, or `undefined` when it declares nothing to sort or filter by. Per property: an index on
 * the owner (on an owned collection), the key and the id, which serves the caller's own scope; beside it, on an owned
 * collection with readers mounts, one on the key and the id for the readers scope (every owned record). Each is partial
 * on the collection's name, a literal, so it indexes only this collection's rows. One more partial index holds only the
 * anomalous rows, so a list checks for them with one lookup of a normally empty index.
 */
export function listPlan(name: string, spec: NormalizedSpec): ListPlan | undefined {
  const fields = [...new Set([...spec.sortable, ...spec.filterable])].sort();
  if (!fields.length || !COLLECTION_NAME.test(name) || !fields.every(field => FIELD_NAME.test(field) && Object.hasOwn(spec.records.properties, field))) return undefined;
  const collection = `collection = '${name}'`, indexes = new Map<string, string>();
  const add = (columns: string, where: string): void => {
    const index = `store_list_${createHash('sha256').update(`${columns} WHERE ${where}`).digest('hex').slice(0, 24)}`;
    indexes.set(index, `CREATE INDEX IF NOT EXISTS "${index}" ON store_records(${columns}) WHERE ${where}`);
  };
  for (const field of fields) {
    if (spec.ownership === 'owner') add(`collection, owner, ${key(spec, field)}, id`, collection);
    if (spec.ownership !== 'owner' || Object.keys(spec.readers).length) add(`collection, ${key(spec, field)}, id`, collection);
  }
  const anomalous = `(${fields.map(field => anomaly(spec, field)).join(' OR ')})`;
  add('collection', `${collection} AND ${anomalous}`);
  return { collection: name, indexes, anomaly: anomalous, spec };
}

/** A row as `listIn` reads it; `parse` turns it into the record answered. */
export interface ListedRow { id: string; owner: string | null; key: string | null; created_at: string; updated_at: string; data: string }

/**
 * One sorted or filtered page in SQL, or `undefined` when the in-memory path must answer it: a cursor or filter string
 * holding a lone surrogate, or an anomalous row anywhere in the collection. `scope` is `listIn`'s: a principal (the
 * caller's own records), `undefined` (the whole shared collection) or `null` (every owned record, a readers mount).
 * The page is what `runList` answers for the same rows: the same order, `total`, cursors and `next`.
 */
export function listInSql(db: StoreDatabase, plan: ListPlan, query: ListQuery, scope: string | undefined | null, columns: string, parse: (row: ListedRow) => StoredRecord): { items: StoredRecord[]; total: number; next?: string | number } | undefined {
  const strings = [...query.filters.map(([, value]) => value), query.after?.value];
  if (strings.some(value => typeof value === 'string' && LONE_SURROGATE.test(value))) return undefined;
  if (db.get(`SELECT 1 AS found FROM store_records WHERE collection = '${plan.collection}' AND ${plan.anomaly} LIMIT 1`) !== undefined) return undefined;
  const { spec } = plan, terms = [`collection = '${plan.collection}'`], values: (string | number | null)[] = [];
  if (scope === null) terms.push('owner IS NOT NULL');
  else if (scope !== undefined) { terms.push('owner = ?'); values.push(scope); }
  for (const [field, value] of query.filters) { terms.push(`${key(spec, field)} = ${boundKey(spec, field)}`); values.push(bind(value)); }
  const where = terms.join(' AND ');
  const total = db.get<{ n: number }>(`SELECT count(*) AS n FROM store_records WHERE ${where}`, ...values)!.n;
  if (!query.sort) {
    const items = db.all<ListedRow>(`SELECT ${columns} FROM store_records WHERE ${where} ORDER BY seq LIMIT ? OFFSET ?`, ...values, query.limit, query.offset).map(parse);
    const end = query.offset + items.length;
    return { items, total, ...(end < total ? { next: end } : {}) };
  }
  const sort = query.sort, sorted = key(spec, sort.field), bound = boundKey(spec, sort.field);
  const [after, before, direction] = sort.descending ? ['<', '<=', ' DESC'] : ['>', '>=', ''];
  let range = '';
  if (query.after) {
    // Strictly after the cursor's (key, id): the first comparison bounds the index range, the second breaks the tie.
    range = ` AND ${sorted} ${before} ${bound} AND (${sorted} ${after} ${bound} OR id ${after} ?)`;
    const position = bind(query.after.value);
    values.push(position, position, query.after.id);
  }
  const rows = db.all<ListedRow>(`SELECT ${columns} FROM store_records WHERE ${where}${range} ORDER BY ${sorted}${direction}, id${direction} LIMIT ?`, ...values, query.limit + 1);
  const items = rows.slice(0, query.limit).map(parse);
  return { items, total, ...(rows.length > query.limit ? { next: encodeCursor(sort, items[items.length - 1]!) } : {}) };
}
