import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthReader, validateHealthSnapshot } from '../src/admin-health.ts';
import type { AdminHealthSnapshot } from '../src/admin-health.ts';
import { adminSite, json, password, text } from './support/site.ts';
const snapshot = (): AdminHealthSnapshot => ({ checkedAt: '2026-09-17T00:00:00.000Z', runtime: { status: 'healthy', readiness: 'degraded', version: '0.3.0', routes: 12 }, sender: 'unknown', providers: [{ id: 'google', status: 'healthy' }], alerts: ['sender-failed'] });
test('health accepts bounded observations and drops arbitrary operator metadata', () => {
    const input = { ...snapshot(), password: 'do-not-expose', runtime: { ...snapshot().runtime, credentials: 'secret' } };
    assert.deepEqual(validateHealthSnapshot(input), snapshot());
    for (const bad of [{ checkedAt: 'yesterday' }, { providers: [{ id: '<script>', status: 'healthy' }] }, { alerts: ['secret=credential'] }, { runtime: { ...snapshot().runtime, routes: -1 } }, { providers: Array.from({ length: 21 }, () => ({ id: 'a', status: 'healthy' })) }]) {
        assert.throws(() => validateHealthSnapshot({ ...snapshot(), ...bad } as AdminHealthSnapshot));
    }
});
test('health failure redacts provider errors and cancellation bounds uncooperative callbacks', async () => {
    const failing = createHealthReader(async () => { throw new Error('SECRET'); });
    assert.equal(await failing(), null);
    let resolve!: (value: AdminHealthSnapshot) => void;
    let signal!: AbortSignal;
    let calls = 0;
    const reader = createHealthReader(async context => { calls++; signal = context.signal; return new Promise(done => { resolve = done; }); });
    const pending = reader();
    await Promise.resolve();
    assert.equal(await reader(), null);
    assert.equal(await pending, null);
    assert.equal(signal.aborted, true);
    assert.equal(await reader(), null);
    assert.equal(calls, 1);
    resolve(snapshot());
    await new Promise(done => setImmediate(done));
});

test('admin health requires its own permission and never exposes raw callback errors', async t => {
    let calls = 0;
    const site = await adminSite(t, { roles: { member: [], admin: ['*'], support: ['auth.users.read'] }, health: async () => { calls++; return snapshot(); } });
    const owner = await site.service.bootstrapAdmin({ email: 'owner@example.test', password });
    const support = await site.service.register({ email: 'support@example.test', password });
    await site.service.adminSetRoles({ actorToken: owner.token, accountId: support.user.id, roles: ['support'], reason: 'Health permission regression' });
    assert.equal((await site.call('/admin/health', await site.signIn('support@example.test'))).status, 403);
    assert.equal(calls, 0);
    const result = await site.call('/admin/health', owner.token);
    assert.equal(result.status, 200);
    assert.deepEqual(json<{ health: unknown }>(result).health, snapshot());
    const html = text(await site.call('/admin/health', owner.token, { html: true }));
    assert.match(html, /Service health/);
    assert.match(html, /Runtime version/);
});
