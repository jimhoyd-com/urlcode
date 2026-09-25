// jimhoyd-com/urlcode#746: "Recent events" on the overview and an account's activity show the newest audit events,
// not the oldest 20 of the log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adminSite, json, password, text } from './support/site.ts';

test('recent events and account activity list the newest audit events first', async t => {
    const site = await adminSite(t, { roles: { member: [], auditor: ['auth.users.read', 'audit.read'], admin: ['*'] } });
    const owner = await site.service.bootstrapAdmin({ email: 'owner@example.test', password });
    // Auth's own events (bootstrap) are drained first, so the 30 below are the newest in the log.
    await site.audit.flush();
    const start = Date.now() - 60_000;
    // More than one page of the dashboard's 20: 30 events for the owner, recorded oldest first.
    await site.audit.record(Array.from({ length: 30 }, (_, index) => ({ id: randomUUID(), source: 'test', action: `test.event-${String(index).padStart(2, '0')}`, actor: 'operator', subject: owner.user.id, at: start + index })));
    const dashboard = json<{ recentEvents: { action: string; seq: string }[] }>(await site.call('/admin', owner.token));
    assert.equal(dashboard.recentEvents.length, 20);
    const seqs = dashboard.recentEvents.map(event => BigInt(event.seq));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a > b ? -1 : a < b ? 1 : 0), 'newest first');
    assert.deepEqual(dashboard.recentEvents.map(event => event.action), Array.from({ length: 20 }, (_, index) => `test.event-${29 - index}`));
    assert.ok(!dashboard.recentEvents.some(event => event.action === 'test.event-00'), 'the oldest events are not "recent"');
    const page = text(await site.call('/admin', owner.token, { html: true }));
    assert.ok(page.indexOf('test.event-29') >= 0 && page.indexOf('test.event-29') < page.indexOf('test.event-28'));
    const activity = json<{ activity: { action: string }[] }>(await site.call('/admin/users/detail?id=' + owner.user.id, owner.token)).activity;
    assert.equal(activity[0]!.action, 'test.event-29');
    // The audit screen is newest first by default and oldest first on request, and shows every source.
    const newest = json<{ events: { action: string }[] }>(await site.call('/admin/audit?source=test', owner.token)).events;
    assert.equal(newest[0]!.action, 'test.event-29');
    const oldest = json<{ events: { action: string }[] }>(await site.call('/admin/audit?source=test&order=asc', owner.token)).events;
    assert.equal(oldest[0]!.action, 'test.event-00');
    const screen = text(await site.call('/admin/audit?source=test', owner.token, { html: true }));
    assert.match(screen, /<th scope="col">Source<\/th>/);
    assert.match(screen, /<th scope="col">Sequence<\/th>/);
});
