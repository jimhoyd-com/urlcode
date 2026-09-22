import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthService, AuthPrincipal } from '@jimhoyd/urlcode-auth';
import { exportAuditRange } from '../src/admin-audit-export.ts';
const query = () => new URLSearchParams({ from: '2026-01-01T00:00Z', to: '2026-01-02T00:00Z', action: 'login' });
const principal = { id: 'operator', permissions: ['auth.audit.read', 'auth.audit.export'], roles: ['support'], sessionId: 'session', email: 'operator@example.test', emailVerified: true, authenticatedAt: Date.now() } satisfies AuthPrincipal;
test('range export follows every cursor, retains filters, is itself audited and requires a reason', async () => {
    let checks = 0;
    const calls: unknown[] = [], audited: unknown[] = [];
    const service = { authenticate: async () => { checks++; return principal; }, listAudit: async (filters: { after?: string }) => { calls.push(filters); return { events: [], ...(filters.after ? {} : { next: 'second' }) }; }, adminAuditExport: async (input: unknown) => { audited.push(input); } } as unknown as AuthService;
    assert.deepEqual(await exportAuditRange(service, 'token', query(), 'quarterly compliance review'), { from: Date.parse('2026-01-01T00:00Z'), to: Date.parse('2026-01-02T00:00Z'), events: [] });
    assert.equal(checks, 2);
    assert.equal(calls.length, 2);
    assert.equal((calls[1] as { action: string }).action, 'login');
    assert.equal((calls[1] as { after: string }).after, 'second');
    // The export itself is audited: actor (via the actorToken), range and count, with the
    // operator's reason, the same way adminReveal/adminExport are (#467).
    assert.equal(audited.length, 1);
    assert.deepEqual(audited[0], { actorToken: 'token', reason: 'quarterly compliance review', from: Date.parse('2026-01-01T00:00Z'), to: Date.parse('2026-01-02T00:00Z'), count: 0 });
});
test('range export never returns partial data after permission revocation or an oversized range', async () => {
    let checks = 0;
    const revoked = { authenticate: async () => ++checks === 1 ? principal : null, listAudit: async () => ({ events: [{ action: 'private' }], next: 'second' }), adminAuditExport: async () => {} } as unknown as AuthService;
    await assert.rejects(exportAuditRange(revoked, 'token', query(), 'review'), /permission/);
    const oversized = { authenticate: async () => principal, listAudit: async () => ({ events: [{ metadata: 'x'.repeat(4 * 1024 * 1024) }] }), adminAuditExport: async () => {} } as unknown as AuthService;
    await assert.rejects(exportAuditRange(oversized, 'token', query(), 'review'), /smaller/);
    const repeat = { authenticate: async () => principal, listAudit: async () => ({ events: [], next: 'same' }), adminAuditExport: async () => {} } as unknown as AuthService;
    await assert.rejects(exportAuditRange(repeat, 'token', query(), 'review'), /pagination/);
    await assert.rejects(exportAuditRange(repeat, 'token', new URLSearchParams(), 'review'), /endpoints/);
    const paged = query(); paged.set('after', 'cursor');
    await assert.rejects(exportAuditRange(repeat, 'token', paged, 'review'), /beginning/);
});
