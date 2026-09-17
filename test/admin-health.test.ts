import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthReader, validateHealthSnapshot } from '../src/admin-health.ts';
import type { AdminHealthSnapshot } from '../src/admin-health.ts';
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
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomBytes } = await import('node:crypto');
    const { createAuthService } = await import('@jimhoyd/urlcode-auth');
    const { adminExtension } = await import('../src/admin.ts');
    const root = await mkdtemp(join(tmpdir(), 'urlcode-health-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'], support: ['auth.users.read'] }, defaultRole: 'member' });
    t.after(() => service.close());
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const support = await service.register({ email: 'support@example.test', password: 'correct horse battery staple' });
    assert.ok(support);
    await service.adminSetRoles({ actorToken: owner.token, accountId: support.user.id, roles: ['support'], reason: 'Health permission regression' });
    const supportSession = await service.login({ email: 'support@example.test', password: 'correct horse battery staple' });
    assert.ok(supportSession);
    let calls = 0;
    const origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const instance = await adminExtension({ service, csrfKey: randomBytes(32), projectSha256, health: async () => { calls++; return snapshot(); } }).activate({}, { origin, target: 'node', projectSha256, mounts: ['/admin'] });
    const request = (token: string, accept = 'application/json') => ({ method: 'GET', target: '/admin/health', path: '/admin/health', query: new URLSearchParams(), headers: new Headers({ cookie: '__Host-urlcode-session=' + token, accept }), headerCounts: { cookie: 1 }, body: new Uint8Array(), origin, route: '/admin/*', mount: '/admin', client: null });
    assert.equal((await instance.handle(request(supportSession.token))).status, 403);
    assert.equal(calls, 0);
    const result = await instance.handle(request(owner.token));
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(Buffer.from(result.body!).toString()).health, snapshot());
    const html = await instance.handle(request(owner.token, 'text/html'));
    assert.match(Buffer.from(html.body!).toString(), /Service health/);
    assert.match(Buffer.from(html.body!).toString(), /Runtime version/);
});
