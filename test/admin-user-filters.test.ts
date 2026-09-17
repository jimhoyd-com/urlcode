import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuthService, AuthHttp } from '@jimhoyd/urlcode-auth';
import type { UserQuery } from '@jimhoyd/urlcode-auth';
import { adminExtension } from '../src/admin.ts';
test('admin pages and CSV export preserve expanded filters, masked results and read/export permissions', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'admin-user-filters-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], reader: ['auth.users.read'], admin: ['*'] }, defaultRole: 'member' });
    t.after(() => service.close());
    const password = 'synthetic password phrase for tests', admin = await service.bootstrapAdmin({ email: 'owner@example.test', password }), member = await service.register({ email: 'private-address@example.test', password });
    const seen: UserQuery[] = [], observedLastSeen = Date.parse('2026-08-04T12:00:00Z');
    const client = { ...service, async listUsers(filters?: UserQuery) { seen.push(filters ?? {}); return { users: [{ ...member.user, observedLastSeen }], next: 'opaque_cursor' }; } };
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64), http = new AuthHttp({ origin, csrfKey });
    const instance = await adminExtension({ service: client, csrfKey, projectSha256 }).activate({}, { origin, target: 'node', projectSha256, mounts: ['/admin'] });
    const filters = new URLSearchParams({ query: 'p***@example.test', role: 'member', status: 'active', method: 'passkey', verified: 'true', locale: 'fr', createdFrom: '2026-01-01T00:00Z', lastSeenTo: '2026-09-01T00:00Z', sort: 'lastSeen', direction: 'desc' });
    async function request(path: string, token: string, query = new URLSearchParams(), fields?: Record<string, string>) { return instance.handle({ method: fields ? 'POST' : 'GET', path: '/admin' + path, target: '/admin' + path, query, headers: new Headers({ cookie: '__Host-urlcode-session=' + token, origin, ...(fields ? { 'content-type': 'application/json' } : {}), accept: 'text/html' }), headerCounts: { cookie: 1, origin: 1 }, body: Buffer.from(fields ? JSON.stringify({ ...fields, csrf: http.token(token) }) : ''), origin, mount: '/admin', route: '/admin/*', client: null }); }
    const page = await request('/users', admin.token, filters);
    assert.equal(page.status, 200);
    const html = Buffer.from(page.body!).toString();
    assert.doesNotMatch(html, /private-address@example/);
    assert.match(html, /p\*\*\*@example.test/);
    assert.match(html, /2026-08-04T12:00:00.000Z/);
    const nextHref = html.match(/href="([^" ]*after=opaque_cursor[^" ]*)"/)?.[1];
    assert.ok(nextHref);
    const next = new URL(nextHref.replaceAll('&amp;', '&'), origin);
    for (const [key, value] of filters) {
        assert.equal(next.searchParams.get(key), value);
        assert.ok(html.includes(`name="${key}" value="${value}"`));
    }
    assert.equal(seen[0]?.verified, true);
    assert.equal(seen[0]?.method, 'passkey');
    assert.equal(seen[0]?.lastSeenTo, Date.parse('2026-09-01T00:00Z'));
    const exported = await request('/users/export-page', admin.token, new URLSearchParams(), { ...Object.fromEntries(filters), after: 'opaque_cursor', reason: 'Reviewed filtered support export' });
    assert.equal(exported.status, 200);
    assert.equal(seen[1]?.after, 'opaque_cursor');
    assert.equal(seen[1]?.sort, 'lastSeen');
    assert.equal(seen[1]?.locale, 'fr');
    const csv = Buffer.from(exported.body!).toString();
    assert.match(csv, /observed_last_seen_utc/);
    assert.match(csv, /2026-08-04T12:00:00.000Z/);
    assert.doesNotMatch(csv, /private-address/);
    assert.equal(csv.trim().split('\r\n').length, 2);
    assert.equal((await service.listAudit({ action: 'admin.account_exported' })).events.length, 1);
    await service.adminSetRoles({ actorToken: admin.token, accountId: member.user.id, roles: ['reader'] });
    const reader = await service.login({ email: member.user.email, password });
    assert.equal((await request('/users', reader.token, filters)).status, 200);
    assert.equal((await request('/users/export-page', reader.token, new URLSearchParams(), { ...Object.fromEntries(filters), reason: 'Not authorized' })).status, 403);
});
test('real user-query pagination and page export preserve combined filters across more than fifty accounts', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'admin-query-pages-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const now = Math.floor(Date.now() / 1000) * 1000;
    const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member', now: () => now });
    t.after(() => service.close());
    const owner = await service.bootstrapAdmin({ email: 'paging-owner@example.test', password: 'synthetic password for pagination' });
    for (let i = 0; i < 52; i++)
        await service.createExternalAccount({ email: `paging-${i}@example.test`, provider: 'example', subject: 'paging-' + i, emailVerified: true, profile: { displayName: 'Imported ' + String(i).padStart(2, '0'), locale: 'fr' } });
    await service.createExternalAccount({ email: 'excluded@example.test', provider: 'example', subject: 'excluded', emailVerified: true, profile: { displayName: 'Imported outsider', locale: 'en' } });
    const origin = 'https://example.test', csrfKey = randomBytes(32), projectSha256 = 'b'.repeat(64), http = new AuthHttp({ origin, csrfKey }), instance = await adminExtension({ service, csrfKey, projectSha256 }).activate({}, { origin, target: 'node', projectSha256, mounts: ['/admin'] });
    const query = new URLSearchParams({ query: 'Imported', role: 'member', method: 'oidc', verified: 'true', locale: 'fr', createdFrom: new Date(now).toISOString().replace('.000Z', 'Z'), lastSeenTo: new Date(now).toISOString().replace('.000Z', 'Z'), sort: 'displayName', direction: 'asc' });
    async function call(path: string, params: URLSearchParams, fields?: Record<string, string>) { return instance.handle({ method: fields ? 'POST' : 'GET', target: '/admin' + path, path: '/admin' + path, query: params, headers: new Headers({ cookie: '__Host-urlcode-session=' + owner.token, origin, accept: 'application/json', ...(fields ? { 'content-type': 'application/json' } : {}) }), headerCounts: { cookie: 1, origin: 1 }, body: Buffer.from(fields ? JSON.stringify({ ...fields, csrf: http.token(owner.token) }) : ''), origin, mount: '/admin', route: '/admin/*', client: null }); }
    const firstResponse = await call('/users', query);
    assert.equal(firstResponse.status, 200);
    const first = JSON.parse(Buffer.from(firstResponse.body!).toString()) as {
        users: {
            id: string;
            email: string;
            profile: {
                displayName: string;
            };
        }[];
        next: string;
    };
    assert.equal(first.users.length, 50);
    assert.equal(first.users[0]!.profile.displayName, 'Imported 00');
    assert.ok(first.users.every(user => user.email === 'p***@example.test'));
    assert.doesNotMatch(Buffer.from(first.next, 'base64url').toString(), /Imported|paging|example.test/);
    query.set('after', first.next);
    const secondResponse = await call('/users', query);
    assert.equal(secondResponse.status, 200);
    const second = JSON.parse(Buffer.from(secondResponse.body!).toString()) as {
        users: {
            id: string;
            profile: {
                displayName: string;
            };
        }[];
        next?: string;
    };
    assert.deepEqual(second.users.map(user => user.profile.displayName), ['Imported 50', 'Imported 51']);
    assert.equal(second.next, undefined);
    const exported = await call('/users/export-page', new URLSearchParams(), { ...Object.fromEntries(query), reason: 'Reviewed second filtered page' });
    assert.equal(exported.status, 200);
    const csv = Buffer.from(exported.body!).toString();
    assert.equal(csv.trim().split('\r\n').length, 3);
    for (const user of second.users)
        assert.ok(csv.includes(user.id));
    assert.doesNotMatch(csv, /paging-/);
    const all = await call('/users/export-range', new URLSearchParams(), { ...Object.fromEntries(query), reason: 'Reviewed complete filtered selection' });
    assert.equal(all.status, 200, Buffer.from(all.body!).toString());
    const completeCsv = Buffer.from(all.body!).toString();
    assert.equal(completeCsv.trim().split('\r\n').length, 53);
    assert.ok(completeCsv.includes('Imported 00') && completeCsv.includes('Imported 51'));
    assert.ok(!completeCsv.includes('outsider'));
    assert.doesNotMatch(completeCsv, /paging-/);
    assert.ok(all.headers.some(([key,value]) => key === 'cache-control' && value === 'no-store'));
});
