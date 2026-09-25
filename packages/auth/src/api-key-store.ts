import type {DatabaseSync} from 'node:sqlite';
/**
 * Storage operations for bearer/API-key credentials (packages/auth/README.md's
 * "Bearer/API-key authentication"). Lookup is by the key's public `id` (embedded in the
 * issued token alongside its secret), never by a hash of the secret itself: the secret is
 * hashed with the same scrypt-based, deliberately slow derivation auth-core.ts already uses
 * for passwords (`hashPassword`/`verifyPassword`), which does not support indexed lookup by
 * hash. Mirrors abuse-store.ts/manual-recovery-store.ts's delegate pattern: returns
 * `{value}` for an operation this module owns, `undefined` for one it does not.
 */
/** A key's own quota (urlcode#703), or `null` for a key issued without one (including every key issued before the column existed). */
function storedQuota(row: Record<string, unknown>): { requests: number; window: number } | null {
    return row.quotaRequests === null || row.quotaWindow === null ? null : { requests: Number(row.quotaRequests), window: Number(row.quotaWindow) };
}
/**
 * A user-linked key (urlcode#732) authenticates only while its user exists and is `active`: a locked account, one
 * pending deletion, or a purged one (whose keys `purgeDeleted` also revokes) disables every key linked to it. A key
 * with no user (`user_id` NULL, a service key) is unaffected. Shared by lookup (the gate) and list (the report).
 */
const USABLE = "(k.user_id IS NULL OR EXISTS(SELECT 1 FROM auth_accounts a WHERE a.id=k.user_id AND a.status='active'))";
export function apiKeyOperation(operation: string, args: Record<string, unknown>, db: DatabaseSync, fail: (status: number, code: string) => never): { value: unknown } | undefined {
    if (!operation.startsWith('apiKey'))
        return;
    const now = Number(args.now);
    if (operation === 'apiKeyIssue') {
        db.prepare('DELETE FROM auth_api_keys WHERE revoked=1 AND expires IS NOT NULL AND expires<=?').run(now - 2592000000);
        if (Number(db.prepare('SELECT count(*) AS n FROM auth_api_keys').get()?.n) >= 10000)
            fail(503, 'auth_capacity_reached');
        const quota = args.quota as { requests: number; window: number } | null, userId = args.userId === null ? null : String(args.userId);
        // Checked in the same transaction as the insert: an unknown, locked, pending-deletion or purged user is refused
        // with one code, so the operator is not told which.
        if (userId !== null && db.prepare("SELECT status FROM auth_accounts WHERE id=?").get(userId)?.status !== 'active')
            fail(400, 'invalid_api_key_user');
        db.prepare('INSERT INTO auth_api_keys(id,name,scopes,secret_hash,created,expires,revoked,last_used,quota_requests,quota_window,user_id) VALUES(?,?,?,?,?,?,0,NULL,?,?,?)').run(String(args.id), String(args.name), JSON.stringify(args.scopes), String(args.secretHash), now, args.expires === null ? null : Number(args.expires), quota ? Number(quota.requests) : null, quota ? Number(quota.window) : null, userId);
        return { value: undefined };
    }
    if (operation === 'apiKeyLookup') {
        const row = db.prepare(`SELECT k.id,k.name,k.scopes,k.secret_hash AS secretHash,k.expires,k.revoked,k.quota_requests AS quotaRequests,k.quota_window AS quotaWindow,k.user_id AS userId FROM auth_api_keys k WHERE k.id=? AND k.revoked=0 AND (k.expires IS NULL OR k.expires>?) AND ${USABLE}`).get(String(args.id), now);
        return { value: row ? { id: String(row.id), name: String(row.name), scopes: JSON.parse(String(row.scopes)) as string[], secretHash: String(row.secretHash), expires: row.expires === null ? null : Number(row.expires), quota: storedQuota(row), userId: row.userId === null ? null : String(row.userId) } : null };
    }
    if (operation === 'apiKeyTouch') {
        db.prepare('UPDATE auth_api_keys SET last_used=? WHERE id=? AND revoked=0').run(now, String(args.id));
        return { value: undefined };
    }
    if (operation === 'apiKeyRevoke') {
        db.prepare('UPDATE auth_api_keys SET revoked=1 WHERE id=?').run(String(args.id));
        return { value: undefined };
    }
    if (operation === 'apiKeyQuota') {
        // Per-credential quota (urlcode#572), kept in the same `auth_attempts` table and
        // fixed-window shape as the sign-in attempt counter (auth-store.ts `attempt`): the
        // window opens at the first counted request, a refused request is not counted, expired
        // rows are swept here and by `cleanup`, and the table's 100,000-row ceiling applies.
        // The store runs every operation inside BEGIN IMMEDIATE, so processes sharing the
        // database file serialize on it and share one count.
        const key = String(args.key), requests = Number(args.requests), windowMs = Number(args.windowMs);
        db.prepare('DELETE FROM auth_attempts WHERE key IN (SELECT key FROM auth_attempts WHERE expires<=? LIMIT 1000)').run(now);
        const prior = db.prepare('SELECT count,expires FROM auth_attempts WHERE key=? AND expires>?').get(key, now);
        const seconds = (expires: number) => Math.max(1, Math.ceil((expires - now) / 1000));
        if (prior && Number(prior.count) >= requests)
            return { value: { allowed: false, remaining: 0, reset: seconds(Number(prior.expires)) } };
        if (!prior && Number(db.prepare('SELECT count(*) AS n FROM auth_attempts').get()?.n) >= 100000)
            fail(503, 'auth_capacity_reached');
        const count = prior ? Number(prior.count) + 1 : 1, expires = prior ? Number(prior.expires) : now + windowMs;
        db.prepare('INSERT INTO auth_attempts VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires').run(key, count, expires);
        return { value: { allowed: true, remaining: requests - count, reset: seconds(expires) } };
    }
    if (operation === 'apiKeyList') {
        const rows = db.prepare(`SELECT k.id,k.name,k.scopes,k.created,k.expires,k.revoked,k.last_used AS lastUsed,k.quota_requests AS quotaRequests,k.quota_window AS quotaWindow,k.user_id AS userId,${USABLE} AS usable FROM auth_api_keys k ORDER BY k.created DESC LIMIT 1000`).all();
        return { value: rows.map(row => ({ id: String(row.id), name: String(row.name), scopes: JSON.parse(String(row.scopes)) as string[], created: Number(row.created), expires: row.expires === null ? null : Number(row.expires), revoked: Boolean(row.revoked), lastUsed: row.lastUsed === null ? null : Number(row.lastUsed), quota: storedQuota(row), userId: row.userId === null ? null : String(row.userId), userDisabled: !row.usable })) };
    }
    return;
}
