import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { queryUsers, validateUserQuery } from '../src/user-query.ts';
function fixture() {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE auth_accounts(id TEXT,email TEXT,status TEXT,data TEXT);CREATE TABLE auth_devices(account_id TEXT,last_seen INTEGER);CREATE TABLE auth_sessions(account_id TEXT,last_seen INTEGER);CREATE TABLE auth_passkeys(account_id TEXT);CREATE TABLE auth_external(account_id TEXT);');
    for (let i = 1; i <= 5; i++) {
        const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
        db.prepare('INSERT INTO auth_accounts VALUES(?,?,?,?)').run(id, `user${i}@example.test`, i === 5 ? 'locked' : 'active', JSON.stringify({ id, email: `user${i}@example.test`, status: i === 5 ? 'locked' : 'active', created: 100 + i, emailVerified: i % 2 === 0, passwordHash: i < 4 ? 'hash' : '', roles: i === 1 ? ['support'] : ['member'], profile: { displayName: i < 3 ? 'Same' : 'Name ' + i, locale: i % 2 === 0 ? 'fr' : 'en' } }));
        db.prepare('INSERT INTO auth_devices VALUES(?,?)').run(id, 200 + i);
        if (i === 4)
            db.prepare('INSERT INTO auth_passkeys VALUES(?)').run(id);
        if (i === 5)
            db.prepare('INSERT INTO auth_external VALUES(?)').run(id);
    }
    return db;
}
test('user search covers masked identifiers, display names and IDs with stable bidirectional sort pagination', t => {
    const db = fixture();
    t.after(() => db.close());
    assert.equal(queryUsers(db, { query: 'u***@example.test' }).users.length, 5);
    assert.equal(queryUsers(db, { query: 'Same' }).users.length, 2);
    assert.equal(queryUsers(db, { query: '000000000001' }).users.length, 1);
    for (const direction of ['asc', 'desc'] as const) {
        const ids: string[] = [];
        let after: string | undefined;
        do {
            const page = queryUsers(db, { sort: 'displayName', direction, limit: 2, ...(after ? { after } : {}) });
            ids.push(...page.users.map(user => (user as {
                id: string;
            }).id));
            after = page.next;
        } while (after);
        assert.equal(ids.length, 5);
        assert.equal(new Set(ids).size, 5);
    }
    const first = queryUsers(db, { sort: 'created', limit: 2 });
    assert.ok(first.next);
    assert.throws(() => queryUsers(db, { sort: 'email', after: first.next! }), /cursor/);
});
test('user filters combine method, verification, locale and time ranges with literal SQL search', t => {
    const db = fixture();
    t.after(() => db.close());
    assert.equal(queryUsers(db, { verified: true, locale: 'FR', createdFrom: 102, createdTo: 104, lastSeenFrom: 203 }).users.length, 1);
    assert.equal(queryUsers(db, { method: 'passkey' }).users.length, 1);
    assert.equal(queryUsers(db, { method: 'oidc', status: 'locked' }).users.length, 1);
    assert.equal(queryUsers(db, { method: 'password' }).users.length, 3);
    assert.throws(() => validateUserQuery({ method: 'email-code' } as unknown as Parameters<typeof validateUserQuery>[0]));
    assert.equal(queryUsers(db, { role: 'support' }).users.length, 1);
    assert.equal(queryUsers(db, { query: "' OR 1=1 --" }).users.length, 0);
    assert.equal(queryUsers(db, { query: '%' }).users.length, 0);
    assert.throws(() => validateUserQuery({ createdFrom: 200, createdTo: 100 }));
    assert.throws(() => validateUserQuery({ limit: 101 }));
});
test('pagination cursors do not disclose private sort values and changed boundaries require restart', t => {
    const db = fixture();
    t.after(() => db.close());
    for (const sort of ['email', 'displayName'] as const) {
        const first = queryUsers(db, { sort, limit: 1 });
        const decoded = Buffer.from(first.next!, 'base64url').toString('utf8');
        const cursor = JSON.parse(decoded);
        const user = first.users[0] as { id: string; email: string; profile: { displayName: string } };
        const guess = createHash('sha256').update(JSON.stringify([user.id, sort === 'email' ? user.email : user.profile.displayName])).digest('hex');
        assert.notEqual(cursor[2], guess);
        assert.equal(decoded.includes('example.test'), false);
        assert.equal(decoded.includes('Name'), false);
        assert.equal(decoded.includes('Same'), false);
        assert.equal(queryUsers(db, { sort, limit: 1, after: first.next! }).users.length, 1);
    }
    const page = queryUsers(db, { sort: 'email', limit: 1 });
    const id = (page.users[0] as {
        id: string;
    }).id;
    db.prepare('UPDATE auth_accounts SET email=? WHERE id=?').run('changed@example.test', id);
    assert.throws(() => queryUsers(db, { sort: 'email', after: page.next! }), /restart/);
    const another = queryUsers(db, { sort: 'created', limit: 1 });
    db.prepare('DELETE FROM auth_accounts WHERE id=?').run((another.users[0] as {
        id: string;
    }).id);
    assert.throws(() => queryUsers(db, { sort: 'created', after: another.next! }), /restart/);
});
