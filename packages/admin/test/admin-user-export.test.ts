import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthService, AuthUser } from '@jimhoyd/urlcode-auth';
import { exportUserRange } from '../src/admin-user-export.ts';
const user = (id: string): AuthUser => ({ id, email: 'private@example.test', roles: ['member'], status: 'active', created: 1, emailVerified: true, totpEnabled: false });
function fixture() {
    const calls: unknown[] = [];
    const service = {
        async authenticate() { return { id: 'actor', authenticatedAt: Date.now(), roles: ['admin'], permissions: ['auth.users.read', 'auth.users.export'] }; },
        async listUsers(query: unknown) { calls.push(query); return { users: [user('a')], next: undefined as string | undefined }; },
        async adminExport(input: { accountId: string }) { calls.push(input); return { user: user(input.accountId) }; },
    };
    return { service, calls, run: (query = new URLSearchParams('role=member&verified=true')) => exportUserRange(service as unknown as AuthService, 'opaque', query, 'review selection') };
}
test('complete user export preserves filters, audits every subject and masks every page', async () => {
    const f = fixture(); let page = 0;
    f.service.listUsers = async query => { f.calls.push(query); return { users: [user(++page === 1 ? 'a' : 'b')], next: page === 1 ? 'cursor' : undefined }; };
    const text = Buffer.from(await f.run()).toString();
    assert.equal(text.split('\r\n').length, 4);
    assert.ok(text.includes('p***@example.test'));
    assert.ok(!text.includes('private@example.test'));
    const queries = f.calls.filter(call => 'limit' in (call as object)) as Record<string, unknown>[];
    assert.equal(queries.length, 2);
    assert.ok(queries.every(query => query.role === 'member' && query.verified === true));
    assert.equal(queries[1]!.after, 'cursor');
    assert.equal(f.calls.filter(call => 'accountId' in (call as object)).length, 2);
});
test('export returns nothing if a later subject or final authorization fails', async () => {
    const f = fixture();
    f.service.listUsers = async () => ({ users: [user('a'), user('b')], next: undefined });
    f.service.adminExport = async input => { if (input.accountId === 'b') throw new Error('refused'); return { user: user('a') }; };
    await assert.rejects(f.run(), /refused/);
    const g = fixture(); let checks = 0;
    g.service.authenticate = async () => ({ id: 'actor', authenticatedAt: Date.now(), roles: ['admin'], permissions: ++checks === 1 ? ['auth.users.read', 'auth.users.export'] : [] });
    await assert.rejects(g.run(), /authority/);
});
test('range export rejects cursors, cycles, oversized selections and oversized output', async () => {
    await assert.rejects(fixture().run(new URLSearchParams('after=cursor')), /beginning/);
    const f = fixture(); f.service.listUsers = async () => ({ users: Array.from({ length: 5001 }, (_, index) => user(String(index))), next: undefined });
    await assert.rejects(f.run(), /Narrow/);
    assert.equal(f.calls.length, 0);
    const g = fixture(); let i = 0;
    g.service.listUsers = async () => ({ users: [user(String(i++))], next: 'same' });
    await assert.rejects(g.run(), /changed/);
    const h = fixture(); h.service.adminExport = async () => ({ user: { ...user('a'), profile: { metadata: {}, displayName: 'x'.repeat(4 * 1024 * 1024) } } });
    await assert.rejects(h.run(), /Narrow/);
});
test('stalled operator call is bounded by the total export deadline', async () => {
    const f = fixture(); f.service.listUsers = () => new Promise(() => {});
    const started = performance.now();
    await assert.rejects(f.run(), /Narrow/);
    assert.ok(performance.now() - started < 6000);
});
