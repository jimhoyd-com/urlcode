import test from 'node:test';
import assert from 'node:assert/strict';
import { adminSite, json, password, text } from './support/site.ts';

test('user pages keep every filter through pagination, mask addresses and need export authority to export', async t => {
    const site = await adminSite(t, { roles: { member: [], reader: ['auth.users.read'], admin: ['*'] } });
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password });
    for (let i = 0; i < 51; i++) await service.register({ email: `private-address-${i}@example.test`, password });
    const filters = new URLSearchParams({ query: 'private-address', role: 'member', status: 'active', method: 'password', verified: 'false', sort: 'email', direction: 'desc' });
    const page = await call('/admin/users?' + filters, owner.token, { html: true });
    assert.equal(page.status, 200);
    const html = text(page);
    assert.doesNotMatch(html, /private-address-\d+@example/);
    assert.match(html, /p\*\*\*@example.test/);
    const nextHref = html.match(/href="([^" ]*after=[^" ]*)"/)?.[1];
    assert.ok(nextHref);
    const next = new URL(nextHref.replaceAll('&amp;', '&'), 'https://example.test');
    for (const [key, value] of filters) {
        assert.equal(next.searchParams.get(key), value);
        assert.ok(html.includes(`name="${key}" value="${value}"`) || html.includes(`value="${value}" selected`), key);
    }
    const second = json<{ users: unknown[] }>(await call(next.pathname + next.search, owner.token));
    assert.equal(second.users.length, 1);
    const exported = await call('/admin/users/export-page', owner.token, { fields: { ...Object.fromEntries(filters), after: next.searchParams.get('after')!, reason: 'Reviewed filtered support export' } });
    assert.equal(exported.status, 200);
    const csv = text(exported);
    assert.match(csv, /observed_last_seen_utc/);
    assert.doesNotMatch(csv, /private-address/);
    assert.equal(csv.trim().split('\r\n').length, 2);
    await site.audit.flush();
    assert.equal((await site.audit.query({ action: 'admin.account_exported' })).events.length, 1);
    const member = (await service.listUsers({ query: 'private-address-0@' })).users[0]!;
    await service.adminSetRoles({ actorToken: owner.token, accountId: member.id, roles: ['reader'] });
    const reader = await site.signIn(member.email);
    assert.equal((await call('/admin/users?' + filters, reader)).status, 200);
    assert.equal((await call('/admin/users/export-page', reader, { fields: { ...Object.fromEntries(filters), reason: 'Not authorized' } })).status, 403);
    // Admin checks the filters' syntax; auth refuses a value it does not support.
    for (const invalid of ['sort=random', 'method=unknown', 'locale=../../file', 'createdFrom=2026-09-01T00%3A00Z&createdTo=2026-01-01T00%3A00Z', 'verified=yes', 'unexpected=field'])
        assert.equal((await call('/admin/users?' + invalid, owner.token)).status, 400, invalid);
});

test('real user-query pagination and page and range exports preserve combined filters across more than fifty accounts', async t => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const site = await adminSite(t, { now: () => now });
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'paging-owner@example.test', password });
    for (let i = 0; i < 52; i++)
        await service.createExternalAccount({ email: `paging-${i}@example.test`, provider: 'example', subject: 'paging-' + i, emailVerified: true, profile: { displayName: 'Imported ' + String(i).padStart(2, '0'), locale: 'fr' } });
    await service.createExternalAccount({ email: 'excluded@example.test', provider: 'example', subject: 'excluded', emailVerified: true, profile: { displayName: 'Imported outsider', locale: 'en' } });
    const stamp = new Date(now).toISOString().replace('.000Z', 'Z');
    const query = new URLSearchParams({ query: 'Imported', role: 'member', method: 'oidc', verified: 'true', locale: 'fr', createdFrom: stamp, lastSeenTo: stamp, sort: 'displayName', direction: 'asc' });
    const first = json<{ users: { email: string; profile: { displayName: string } }[]; next: string }>(await call('/admin/users?' + query, owner.token));
    assert.equal(first.users.length, 50);
    assert.equal(first.users[0]!.profile.displayName, 'Imported 00');
    assert.ok(first.users.every(user => user.email === 'p***@example.test'));
    assert.doesNotMatch(Buffer.from(first.next, 'base64url').toString(), /Imported|paging|example.test/);
    query.set('after', first.next);
    const second = json<{ users: { id: string; profile: { displayName: string } }[]; next?: string }>(await call('/admin/users?' + query, owner.token));
    assert.deepEqual(second.users.map(user => user.profile.displayName), ['Imported 50', 'Imported 51']);
    assert.equal(second.next, undefined);
    const exported = await call('/admin/users/export-page', owner.token, { fields: { ...Object.fromEntries(query), reason: 'Reviewed second filtered page' } });
    assert.equal(exported.status, 200);
    const csv = text(exported);
    assert.equal(csv.trim().split('\r\n').length, 3);
    for (const user of second.users) assert.ok(csv.includes(user.id));
    assert.doesNotMatch(csv, /paging-/);
    query.delete('after');
    const all = await call('/admin/users/export-range', owner.token, { fields: { ...Object.fromEntries(query), reason: 'Reviewed complete filtered selection' } });
    assert.equal(all.status, 200, text(all));
    const complete = text(all);
    assert.equal(complete.trim().split('\r\n').length, 53);
    assert.ok(complete.includes('Imported 00') && complete.includes('Imported 51'));
    assert.ok(!complete.includes('outsider'));
    assert.doesNotMatch(complete, /paging-/);
    assert.ok(all.headers.some(([key, value]) => key === 'cache-control' && value === 'no-store'));
});
