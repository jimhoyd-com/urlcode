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
export function apiKeyOperation(operation: string, args: Record<string, unknown>, db: DatabaseSync, fail: (status: number, code: string) => never): { value: unknown } | undefined {
    if (!operation.startsWith('apiKey'))
        return;
    const now = Number(args.now);
    if (operation === 'apiKeyIssue') {
        db.prepare('DELETE FROM auth_api_keys WHERE revoked=1 AND expires IS NOT NULL AND expires<=?').run(now - 2592000000);
        if (Number(db.prepare('SELECT count(*) AS n FROM auth_api_keys').get()?.n) >= 10000)
            fail(503, 'auth_capacity_reached');
        db.prepare('INSERT INTO auth_api_keys(id,name,scopes,secret_hash,created,expires,revoked,last_used) VALUES(?,?,?,?,?,?,0,NULL)').run(String(args.id), String(args.name), JSON.stringify(args.scopes), String(args.secretHash), now, args.expires === null ? null : Number(args.expires));
        return { value: undefined };
    }
    if (operation === 'apiKeyLookup') {
        const row = db.prepare('SELECT id,name,scopes,secret_hash AS secretHash,expires,revoked FROM auth_api_keys WHERE id=? AND revoked=0 AND (expires IS NULL OR expires>?)').get(String(args.id), now);
        return { value: row ? { id: String(row.id), name: String(row.name), scopes: JSON.parse(String(row.scopes)) as string[], secretHash: String(row.secretHash), expires: row.expires === null ? null : Number(row.expires) } : null };
    }
    if (operation === 'apiKeyTouch') {
        db.prepare('UPDATE auth_api_keys SET last_used=? WHERE id=? AND revoked=0').run(now, String(args.id));
        return { value: undefined };
    }
    if (operation === 'apiKeyRevoke') {
        db.prepare('UPDATE auth_api_keys SET revoked=1 WHERE id=?').run(String(args.id));
        return { value: undefined };
    }
    if (operation === 'apiKeyList') {
        const rows = db.prepare('SELECT id,name,scopes,created,expires,revoked,last_used AS lastUsed FROM auth_api_keys ORDER BY created DESC LIMIT 1000').all();
        return { value: rows.map(row => ({ id: String(row.id), name: String(row.name), scopes: JSON.parse(String(row.scopes)) as string[], created: Number(row.created), expires: row.expires === null ? null : Number(row.expires), revoked: Boolean(row.revoked), lastUsed: row.lastUsed === null ? null : Number(row.lastUsed) })) };
    }
    return;
}
