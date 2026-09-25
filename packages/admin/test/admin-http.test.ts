// The console through a real site: auth's policy on /admin/* resolves the session, verifies CSRF and sets the
// principal; admin reads the account auth resolved and calls auth.administration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminSite, header, json, password, text } from './support/site.ts';

test('the console is invisible without a console permission, masks addresses and leaves CSRF and self-changes to auth', async (t) => {
    const site = await adminSite(t, { roles: { member: ['site.read'], support: ['auth.users.read'], admin: ['*'] }, auth: { allowImpersonation: true } });
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password });
    const member = await service.register({ email: 'member@example.test', password });
    // Signed out, a plain member and a garbage cookie all see a 404: the console's existence is not revealed.
    assert.equal((await call('/admin', undefined)).status, 404);
    assert.equal((await call('/admin', member.token)).status, 404);
    assert.equal((await call('/admin', 'x'.repeat(43))).status, 404);
    const listing = await call('/admin/users', owner.token);
    assert.equal(listing.status, 200);
    const list = json<{ users: { email: string }[]; csrf: string }>(listing);
    assert.ok(list.users.every(user => user.email.includes('***')));
    // A foreign origin, a missing token and another session's token are refused by auth before admin runs.
    assert.equal((await call('/admin/users/status', owner.token, { fields: { accountId: member.user.id, status: 'locked', reason: 'test' }, origin: 'https://evil.test' })).status, 403);
    assert.equal((await call('/admin/users/status', owner.token, { fields: { accountId: member.user.id, status: 'locked', reason: 'test' }, csrf: false })).status, 403);
    const other = await site.signIn('owner@example.test');
    assert.equal((await call('/admin/users/status', owner.token, { fields: { accountId: member.user.id, status: 'locked', reason: 'test' }, csrf: await site.csrf(other) })).status, 403);
    assert.equal((await service.getUser(member.user.id))?.status, 'active');
    // The token is accepted from the header as well as from the form body.
    const headerWrite = await call('/admin/users/note', owner.token, { fields: { accountId: member.user.id, reason: 'header token' }, csrf: false, headers: { 'x-csrf-token': list.csrf } });
    assert.equal(headerWrite.status, 200);
    assert.equal((await call('/admin/users/note', owner.token, { fields: { accountId: member.user.id, reason: 'form body token' }, form: true })).status, 200);
    assert.equal((await call('/admin/users/status', owner.token, { fields: { accountId: owner.user.id, status: 'locked', reason: 'test' } })).status, 403);
    assert.equal((await call('/admin/users/status', owner.token, { fields: { accountId: member.user.id, status: 'locked', reason: 'test' } })).status, 200);
    assert.equal((await service.getUser(member.user.id))?.status, 'locked');
    assert.equal((await call('/admin/audit', owner.token)).status, 200);
    // Maker-checker: the maker cannot approve their own case; a second administrator can.
    const checker = await service.register({ email: 'checker@example.test', password });
    await service.adminSetRoles({ actorToken: owner.token, accountId: checker.user.id, roles: ['admin'] });
    const reviewer = await site.signIn('checker@example.test');
    assert.equal((await call('/admin/cases/create', owner.token, { fields: { accountId: member.user.id, action: 'unlock', reason: 'restore access with review' } })).status, 200);
    const caseId = json<{ cases: { id: string }[] }>(await call('/admin/cases', owner.token)).cases[0]!.id;
    assert.equal((await call('/admin/cases/approve', owner.token, { fields: { caseId, reason: 'self approval forbidden' } })).status, 403);
    assert.equal((await call('/admin/cases/approve', reviewer, { fields: { caseId, reason: 'independent reviewed approval' } })).status, 200);
    assert.equal((await service.getUser(member.user.id))?.status, 'active');
    // Impersonation: auth sends the notice, then hands back the support session's cookie and its account page.
    const started = await call('/admin/impersonate', owner.token, { fields: { accountId: member.user.id, reason: 'support requested by customer' } });
    assert.equal(started.status, 303);
    assert.equal(header(started, 'location'), '/account/account');
    assert.equal(site.sent.at(-1)?.template, 'auth.impersonation-started');
    const support = header(started, 'set-cookie')!.split(';')[0]!.split('=')[1]!;
    const account = json<{ impersonatorId: string }>(await call('/account/account', support));
    assert.equal(account.impersonatorId, owner.user.id);
    // A support session never reaches the console.
    assert.equal((await call('/admin', support)).status, 404);
    // No raw token or key reached the response bodies.
    assert.doesNotMatch(text(started), /token|__Host/);
});

test('an operator alias origin passes auth\'s same-origin write check on the console; an unlisted origin is refused', async (t) => {
    const site = await adminSite(t, { aliasOrigins: ['https://admin.example.test'] });
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password });
    const member = await service.register({ email: 'member@example.test', password });
    const fields = { accountId: member.user.id, status: 'locked', reason: 'test' };
    assert.equal((await call('/admin/users/status', owner.token, { fields, origin: 'https://evil.test' })).status, 403);
    assert.equal((await call('/admin/users/status', owner.token, { fields, origin: 'https://www.example.test' })).status, 403, 'an unlisted sibling origin is refused');
    assert.equal((await service.getUser(member.user.id))?.status, 'active');
    assert.equal((await call('/admin/users/status', owner.token, { fields, origin: 'https://admin.example.test' })).status, 200);
    assert.equal((await service.getUser(member.user.id))?.status, 'locked');
});
