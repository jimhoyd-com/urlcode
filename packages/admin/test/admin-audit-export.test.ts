import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthService, AuthPrincipal } from '@jimhoyd/urlcode-auth';
import { exportAuditRange } from '../src/admin-audit-export.ts';
const query = () => new URLSearchParams({ from: '2026-01-01T00:00Z', to: '2026-01-02T00:00Z', action: 'login' });
const principal = { id: 'operator', permissions: ['auth.audit.read', 'auth.audit.export'], roles: ['support'], sessionId: 'session', email: 'operator@example.test', emailVerified: true, authenticatedAt: Date.now() } satisfies AuthPrincipal;
test('range export follows every cursor, retains filters and rechecks authority before release', async () => {
    let checks = 0;
    const calls: unknown[] = [];
    const service = { authenticate: async () => { checks++; return principal; }, listAudit: async (filters: { after?: string }) => { calls.push(filters); return { events: [], ...(filters.after ? {} : { next: 'second' }) }; } } as unknown as AuthService;
    assert.deepEqual(await exportAuditRange(service, 'token', query()), { from: Date.parse('2026-01-01T00:00Z'), to: Date.parse('2026-01-02T00:00Z'), events: [] });
    assert.equal(checks, 3);
    assert.equal(calls.length, 2);
    assert.equal((calls[1] as { action: string }).action, 'login');
    assert.equal((calls[1] as { after: string }).after, 'second');
});
test('range export never returns partial data after permission revocation or an oversized range', async () => {
    let checks = 0;
    const revoked = { authenticate: async () => ++checks === 1 ? principal : null, listAudit: async () => ({ events: [{ action: 'private' }], next: 'second' }) } as unknown as AuthService;
    await assert.rejects(exportAuditRange(revoked, 'token', query()), /permission/);
    const oversized = { authenticate: async () => principal, listAudit: async () => ({ events: [{ metadata: 'x'.repeat(4 * 1024 * 1024) }] }) } as unknown as AuthService;
    await assert.rejects(exportAuditRange(oversized, 'token', query()), /smaller/);
    const repeat = { authenticate: async () => principal, listAudit: async () => ({ events: [], next: 'same' }) } as unknown as AuthService;
    await assert.rejects(exportAuditRange(repeat, 'token', query()), /pagination/);
    await assert.rejects(exportAuditRange(repeat, 'token', new URLSearchParams()), /endpoints/);
    const paged = query(); paged.set('after', 'cursor');
    await assert.rejects(exportAuditRange(repeat, 'token', paged), /beginning/);
});
