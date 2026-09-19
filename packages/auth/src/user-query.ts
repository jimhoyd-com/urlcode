import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
export interface UserQuery {
    limit?: number;
    after?: string;
    query?: string;
    status?: 'active' | 'locked' | 'pending-delete';
    role?: string;
    method?: 'password' | 'passkey' | 'oidc';
    verified?: boolean;
    locale?: string;
    createdFrom?: number;
    createdTo?: number;
    lastSeenFrom?: number;
    lastSeenTo?: number;
    sort?: 'id' | 'email' | 'displayName' | 'created' | 'lastSeen';
    direction?: 'asc' | 'desc';
}
export interface ValidatedUserQuery extends UserQuery {
    limit: number;
    sort: NonNullable<UserQuery['sort']>;
    direction: 'asc' | 'desc';
}
export function validateUserQuery(input: UserQuery = {}): ValidatedUserQuery {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['limit', 'after', 'query', 'status', 'role', 'method', 'verified', 'locale', 'createdFrom', 'createdTo', 'lastSeenFrom', 'lastSeenTo', 'sort', 'direction'].includes(key)))
        throw new Error('Invalid user filter');
    const result: ValidatedUserQuery = { ...input, limit: input.limit ?? 50, sort: input.sort ?? 'id', direction: input.direction ?? 'asc' };
    if (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 100 || !['id', 'email', 'displayName', 'created', 'lastSeen'].includes(result.sort) || !['asc', 'desc'].includes(result.direction))
        throw new Error('Invalid user page');
    if (result.query !== undefined && (typeof result.query !== 'string' || result.query.length > 254 || /[\x00-\x1f\x7f]/.test(result.query)) || result.role !== undefined && (typeof result.role !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(result.role)) || result.status !== undefined && !['active', 'locked', 'pending-delete'].includes(result.status) || result.method !== undefined && !['password', 'passkey', 'oidc'].includes(result.method) || result.verified !== undefined && typeof result.verified !== 'boolean')
        throw new Error('Invalid user filter');
    if (result.locale !== undefined && (typeof result.locale !== 'string' || result.locale.length > 64 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(result.locale)))
        throw new Error('Invalid locale filter');
    for (const key of ['createdFrom', 'createdTo', 'lastSeenFrom', 'lastSeenTo'] as const)
        if (result[key] !== undefined && (!Number.isSafeInteger(result[key]) || result[key]! < 0))
            throw new Error('Invalid user date');
    if (result.createdFrom !== undefined && result.createdTo !== undefined && result.createdFrom > result.createdTo || result.lastSeenFrom !== undefined && result.lastSeenTo !== undefined && result.lastSeenFrom > result.lastSeenTo)
        throw new Error('Invalid user date range');
    if (result.after !== undefined && (typeof result.after !== 'string' || result.after.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(result.after)))
        throw new Error('Invalid user cursor');
    return result;
}
function filterHash(input: ValidatedUserQuery): string {
    const { after: _after, limit: _limit, ...filters } = input;
    return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}
// Process-local keys keep identifiers confidential; restarting the worker invalidates live cursors.
const cursorKeys = new WeakMap<DatabaseSync, Buffer>();
function sortHash(db: DatabaseSync, id: string, value: unknown): string {
    let key = cursorKeys.get(db);
    if (!key) { key = randomBytes(32); cursorKeys.set(db, key); }
    return createHmac('sha256', key).update(JSON.stringify([id, value])).digest('hex');
}
/** Reads only stored auth metadata. Sort expressions are fixed; all user values are bound parameters. */
export function queryUsers(db: DatabaseSync, raw: UserQuery): {
    users: unknown[];
    next?: string;
} {
    const input = validateUserQuery(raw), fingerprint = filterHash(input), where: string[] = [], values: SQLInputValue[] = [];
    const add = (sql: string, ...params: SQLInputValue[]) => { where.push(sql); values.push(...params); };
    if (input.query)
        add("(instr(lower(email),lower(?))>0 OR instr(lower(display_name),lower(?))>0 OR instr(id,?)>0 OR instr(lower(masked_email),lower(?))>0)", input.query, input.query, input.query, input.query);
    if (input.status)
        add('status=?', input.status);
    if (input.role)
        add("EXISTS(SELECT 1 FROM json_each(json_extract(data,'$.roles')) WHERE value=?)", input.role);
    if (input.verified !== undefined)
        add("COALESCE(json_extract(data,'$.emailVerified'),0)=?", input.verified ? 1 : 0);
    if (input.locale)
        add("lower(COALESCE(json_extract(data,'$.profile.locale'),''))=lower(?)", input.locale);
    if (input.method === 'password')
        add("length(COALESCE(json_extract(data,'$.passwordHash'),''))>0");
    if (input.method === 'passkey')
        add('EXISTS(SELECT 1 FROM auth_passkeys p WHERE p.account_id=observed.id)');
    if (input.method === 'oidc')
        add('EXISTS(SELECT 1 FROM auth_external e WHERE e.account_id=observed.id)');
    for (const [key, column, comparison] of [['createdFrom', 'created', '>='], ['createdTo', 'created', '<='], ['lastSeenFrom', 'last_seen', '>='], ['lastSeenTo', 'last_seen', '<=']] as const)
        if (input[key] !== undefined)
            add(`${column}${comparison}?`, input[key]!);
    const column = { id: 'id', email: 'email', displayName: 'display_name', created: 'created', lastSeen: 'last_seen' }[input.sort];
    const observed = `WITH observed AS (SELECT a.id,a.email,a.status,a.data,COALESCE(json_extract(a.data,'$.profile.displayName'),'') AS display_name,COALESCE(json_extract(a.data,'$.created'),0) AS created,MAX(COALESCE(json_extract(a.data,'$.lastSeen'),0),COALESCE((SELECT MAX(d.last_seen) FROM auth_devices d WHERE d.account_id=a.id),0),COALESCE((SELECT MAX(s.last_seen) FROM auth_sessions s WHERE s.account_id=a.id),0)) AS last_seen,substr(a.email,1,1)||'***'||substr(a.email,instr(a.email,'@')) AS masked_email FROM auth_accounts a)`;
    if (input.after) {
        let cursor: unknown;
        try {
            cursor = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8'));
        }
        catch {
            throw new Error('Invalid user cursor');
        }
        if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== fingerprint || typeof cursor[1] !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(cursor[1]) || typeof cursor[2] !== 'string' || !/^[a-f0-9]{64}$/.test(cursor[2]))
            throw new Error('Invalid user cursor');
        // Keep private sort values on the server. Live pages restart if their boundary changed.
        const boundary = db.prepare(`${observed} SELECT ${column} AS sort_value FROM observed WHERE id=?`).get(cursor[1]);
        if (!boundary || sortHash(db, cursor[1], boundary.sort_value) !== cursor[2])
            throw new Error('Invalid user cursor; restart the user search');
        const cmp = input.direction === 'asc' ? '>' : '<';
        add(`(${column}${cmp}? OR (${column}=? AND id${cmp}?))`, boundary.sort_value as SQLInputValue, boundary.sort_value as SQLInputValue, cursor[1]);
    }
    const direction = input.direction === 'asc' ? 'ASC' : 'DESC';
    const rows = db.prepare(`${observed} SELECT id,data,last_seen AS observed_last_seen,${column} AS sort_value FROM observed ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${column} ${direction},id ${direction} LIMIT ?`).all(...values, input.limit + 1);
    const more = rows.length > input.limit, selected = rows.slice(0, input.limit), last = selected.at(-1);
    return { users: selected.map(row => ({ ...JSON.parse(String(row.data)), observedLastSeen: Number(row.observed_last_seen) })), ...(more && last ? { next: Buffer.from(JSON.stringify([fingerprint, last.id, sortHash(db, String(last.id), last.sort_value)])).toString('base64url') } : {}) };
}
