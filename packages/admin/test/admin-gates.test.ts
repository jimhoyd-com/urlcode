import test from 'node:test';
import assert from 'node:assert/strict';
import { adminSite, header, json, password, text } from './support/site.ts';

test('admin gates: role assignment, invitations, audit export, methods and CSV export headers', async t => {
    const roles = { member: [], reader: ['auth.users.read'], auditor: ['audit.read'], exporter: ['audit.read', 'audit.export'], admin: ['*'] };
    const site = await adminSite(t, { roles });
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password }), target = await service.register({ email: 'target@example.test', password });
    const as = async (role: string) => { await service.adminSetRoles({ actorToken: owner.token, accountId: target.user.id, roles: [role], reason: 'gate fixture' }); return site.signIn(target.user.email); };
    // A reader cannot assign roles; the store never sees the escalation.
    assert.equal((await call('/admin/users/roles', await as('reader'), { fields: { accountId: target.user.id, roles: 'admin', reason: 'self escalation attempt' } })).status, 403);
    assert.deepEqual((await service.getUser(target.user.id))!.roles, ['reader']);
    assert.equal((await call('/admin/users/roles', owner.token, { fields: { accountId: target.user.id, roles: 'reader, auditor', reason: 'grant audit access' } })).status, 200);
    assert.deepEqual((await service.getUser(target.user.id))!.roles, ['reader', 'auditor']);
    // Audit range export: audit.read alone is not enough; a reason is required; the export is itself audited.
    const range = '?from=2024-01-01T00:00Z&to=2024-01-02T00:00Z&reason=Compliance%20review';
    assert.equal((await call('/admin/audit/export' + range, await as('auditor'))).status, 403);
    const exporter = await as('exporter');
    assert.equal((await call('/admin/audit/export?from=2024-01-01T00:00Z&to=2024-01-02T00:00Z', exporter)).status, 400);
    const exported = await call('/admin/audit/export' + range, exporter);
    assert.equal(exported.status, 200);
    assert.equal(header(exported, 'content-disposition'), 'attachment; filename="audit-range.json"');
    const exportEvent = (await site.audit.query({ action: 'admin.audit_exported', order: 'desc', limit: 1 })).events[0]!;
    assert.equal(exportEvent.source, 'admin');
    assert.equal(exportEvent.actor, target.user.id);
    assert.equal(exportEvent.reason, 'Compliance review');
    assert.match(exportEvent.subject, /^range:\d+:\d+:\d+$/);
    // Only GET, HEAD and POST reach the console: another method is refused before it (auth's write check or the route's 405).
    for (const method of ['PUT', 'DELETE', 'PATCH']) assert.ok([403, 405].includes((await call('/admin/users', owner.token, { method })).status), method);
    const rangeCsv = await call('/admin/users/export-range', owner.token, { fields: { reason: 'complete filtered export' } });
    assert.equal(rangeCsv.status, 200);
    assert.equal(header(rangeCsv, 'content-type'), 'text/csv; charset=utf-8');
    assert.equal(header(rangeCsv, 'content-disposition'), 'attachment; filename="accounts-filtered.csv"');
    assert.match(text(rangeCsv), /^"id","email_masked"/);
    assert.equal(text(rangeCsv).trim().split('\r\n').length, 3);
    const pageCsv = await call('/admin/users/export-page', owner.token, { fields: { reason: 'one page export' } });
    assert.equal(pageCsv.status, 200);
    assert.equal(header(pageCsv, 'content-disposition'), 'attachment; filename="accounts-page.csv"');
    assert.match(text(pageCsv), /^"id","email_masked"/);
});

test('auth delivers an invitation the console asks for; its token never reaches the console', async t => {
    const site = await adminSite(t, { auth: { registrationMode: 'invite-only' } });
    const { call } = site;
    const owner = await site.service.bootstrapAdmin({ email: 'owner@example.test', password });
    // Auth sends the invitation through mail; its token reaches the recipient only.
    const invited = await call('/admin/invitations', owner.token, { fields: { email: 'invited@example.test', reason: 'delivery configured' } });
    assert.equal(invited.status, 200);
    const message = site.sent.at(-1)!;
    assert.equal(message.template, 'auth.invitation');
    assert.equal(message.to, 'invited@example.test');
    const token = new URL(message.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    assert.ok(token);
    assert.ok(!text(invited).includes(token));
});

test('without mail delivery the console hides and refuses every delivering operation', async t => {
    const site = await adminSite(t, { transport: false, auth: { allowImpersonation: true } });
    const owner = await site.service.bootstrapAdmin({ email: 'owner@example.test', password }), member = await site.service.register({ email: 'member@example.test', password });
    assert.equal((await site.call('/admin/invitations', owner.token, { fields: { email: 'invited@example.test', reason: 'no delivery' } })).status, 503);
    assert.equal((await site.call('/admin/users/create', owner.token, { fields: { email: 'new@example.test', reason: 'no delivery' } })).status, 503);
    assert.equal((await site.call('/admin/impersonate', owner.token, { fields: { accountId: member.user.id, reason: 'no notice possible' } })).status, 503);
    assert.equal((await site.call('/admin/account-operations', owner.token)).status, 404);
    const users = text(await site.call('/admin/users', owner.token, { html: true }));
    assert.doesNotMatch(users, /Send setup link/);
    assert.doesNotMatch(text(await site.call('/admin', owner.token, { html: true })), /support impersonation/);
    assert.equal((await site.service.listUsers()).users.length, 2);
});

test('admin mutations require a recent sign-in and a bounded reason, and a stale proof is sent to auth\'s step-up', async t => {
    const now = Date.now() - 6 * 60 * 1000;
    const site = await adminSite(t, { now: () => now });
    const owner = await site.service.bootstrapAdmin({ email: 'owner@example.test', password });
    assert.equal((await site.service.authenticate(owner.token))!.authenticatedAt, now);
    const stale = await site.call('/admin/users/note', owner.token, { fields: { accountId: owner.user.id, reason: 'signed in six minutes ago' } });
    assert.equal(stale.status, 403);
    assert.deepEqual(json(stale), { error: 'Confirm your identity before this action', stepUp: '/account/step-up?returnTo=%2Fadmin%2Fusers%2Fnote' });
    const page = await site.call('/admin/users/note', owner.token, { fields: { accountId: owner.user.id, reason: 'signed in six minutes ago' }, html: true });
    assert.equal(page.status, 403);
    assert.match(text(page), /<p role="alert" class="error">Confirm your identity before this action<\/p>/);
    assert.match(text(page), /href="\/account\/step-up\?returnTo=%2Fadmin%2Fusers%2Fnote"/);
    assert.equal((await site.call('/admin/users/note', owner.token, { fields: { accountId: owner.user.id, reason: 'x'.repeat(257) } })).status, 400);
    assert.equal((await site.call('/admin/users/note', owner.token, { fields: { accountId: owner.user.id, reason: '   ' } })).status, 400);
    assert.equal((await site.audit.query({ action: 'admin.note' })).events.length, 0);
});

test('the console refuses to activate on a mount without an auth policy', async t => {
    await assert.rejects(adminSite(t, { adminRoute: { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] } }), /\/admin\/\* must carry an auth policy \(auth: \{onDeny: 404\}\)/);
});
