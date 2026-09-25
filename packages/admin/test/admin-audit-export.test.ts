// exportAuditRange over stand-ins for AuditExports and AuthExports, so each bound and refusal is exercised on its own;
// admin-gates.test.ts runs the same export through a real site.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuthAccount, AuthExports } from '@jimhoyd/urlcode-auth';
import type { AuditEvent, AuditExports, AuditPage, AuditQuery, AuditStoredEvent } from '@jimhoyd/urlcode-audit';
import { exportAuditRange } from '../src/admin-audit-export.ts';
import { AdminHttpError } from '../src/admin-ui.ts';

const query = () => new URLSearchParams({ from: '2026-01-01T00:00Z', to: '2026-01-02T00:00Z', action: 'session.login' });
const account = { id: 'operator', actor: Object.freeze({}) } as unknown as AuthAccount;
const stored = (seq: number): AuditStoredEvent => ({ id: 'e' + seq, source: 'auth', action: 'session.login', actor: 'a', subject: 's', at: 1, reason: '', metadata: null, seq: String(seq), recordedAt: 1 });
interface Fixture { log: string[]; queries: AuditQuery[]; recorded: AuditEvent[]; audit: AuditExports; auth: AuthExports }
function fixture(pages: (call: number) => AuditPage, options: { reauthorize?: (call: number) => Promise<void>; record?: () => Promise<void> } = {}): Fixture {
    const log: string[] = [], queries: AuditQuery[] = [], recorded: AuditEvent[] = [];
    let checks = 0;
    const audit = {
        version: 1, active: true,
        async flush() { log.push('flush'); },
        async query(filter: AuditQuery) { log.push('query'); queries.push(filter); return pages(queries.length); },
        async record(events: readonly AuditEvent[]) { log.push('record'); await options.record?.(); recorded.push(...events); },
    } as unknown as AuditExports;
    const auth = { administration: { async reauthorize(actor: unknown, input: { permissions: string[]; fresh: boolean }) {
        assert.equal(actor, account.actor);
        assert.deepEqual(input, { permissions: ['audit.read', 'audit.export'], fresh: true });
        log.push('reauthorize');
        await options.reauthorize?.(++checks);
        return account;
    } } } as unknown as AuthExports;
    return { log, queries, recorded, audit, auth };
}

test('a range export flushes first, re-authorizes before every page, keeps the filters and records itself before release', async () => {
    const { log, queries, recorded, audit, auth } = fixture(call => call === 1 ? { events: [stored(5), stored(6)], next: '6', oldest: '1' } : { events: [stored(9)], oldest: '1' });
    const result = await exportAuditRange(audit, auth, account, query(), 'quarterly compliance review');
    assert.deepEqual(log, ['flush', 'reauthorize', 'query', 'reauthorize', 'query', 'record']);
    assert.deepEqual(result.events.map(event => event.seq), ['5', '6', '9']);
    assert.deepEqual(queries[1], { action: 'session.login', from: Date.parse('2026-01-01T00:00Z'), to: Date.parse('2026-01-02T00:00Z'), limit: 100, order: 'asc', after: '6' });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]!.source, 'admin');
    assert.equal(recorded[0]!.action, 'admin.audit_exported');
    assert.equal(recorded[0]!.actor, 'operator');
    assert.equal(recorded[0]!.reason, 'quarterly compliance review');
    assert.equal(recorded[0]!.subject, `range:${Date.parse('2026-01-01T00:00Z')}:${Date.parse('2026-01-02T00:00Z')}:3`);
});

test('a session revoked mid-export ends it with auth\'s refusal and no record', async () => {
    const revoked = Object.assign(new Error('invalid_session'), { status: 401, code: 'invalid_session' });
    const { log, recorded, audit, auth } = fixture(() => ({ events: [stored(1)], next: String(Math.random()), oldest: '1' }), { reauthorize: async call => { if (call === 2) throw revoked; } });
    await assert.rejects(exportAuditRange(audit, auth, account, query(), 'review'), error => error === revoked);
    assert.deepEqual(log, ['flush', 'reauthorize', 'query', 'reauthorize']);
    assert.equal(recorded.length, 0);
});

test('pruning that overtakes the export refuses it', async () => {
    const { recorded, audit, auth } = fixture(call => call === 1 ? { events: [stored(5)], next: '5', oldest: '1' } : { events: [stored(8)], oldest: '7' });
    await assert.rejects(exportAuditRange(audit, auth, account, query(), 'review'), (error: unknown) => error instanceof AdminHttpError && error.status === 503 && /pruned/.test(error.message));
    assert.equal(recorded.length, 0);
});

test('an export that cannot be recorded is not released', async () => {
    const { audit, auth } = fixture(() => ({ events: [stored(1)], oldest: '1' }), { record: async () => { throw new Error('audit unavailable'); } });
    await assert.rejects(exportAuditRange(audit, auth, account, query(), 'review'), (error: unknown) => error instanceof AdminHttpError && error.status === 503);
});

test('oversized, looping, unbounded or mid-range exports are refused', async () => {
    const oversized = fixture(() => ({ events: [{ ...stored(1), metadata: { value: 'x'.repeat(4 * 1024 * 1024) } }], oldest: '1' }));
    await assert.rejects(exportAuditRange(oversized.audit, oversized.auth, account, query(), 'review'), /smaller/);
    const tooMany = fixture(call => ({ events: Array.from({ length: 100 }, (_, index) => stored(call * 100 + index)), next: String(call), oldest: '1' }));
    await assert.rejects(exportAuditRange(tooMany.audit, tooMany.auth, account, query(), 'review'), /smaller/);
    const repeat = fixture(() => ({ events: [], next: 'same' }));
    await assert.rejects(exportAuditRange(repeat.audit, repeat.auth, account, query(), 'review'), /pagination/);
    await assert.rejects(exportAuditRange(repeat.audit, repeat.auth, account, new URLSearchParams(), 'review'), /endpoints/);
    const paged = query(); paged.set('after', 'cursor');
    await assert.rejects(exportAuditRange(repeat.audit, repeat.auth, account, paged, 'review'), /beginning/);
});
