// The console's handlers over a real site: every mutation goes through auth.administration, and every message that
// carries a credential is sent by auth through mail, so admin's responses never hold one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adminSite, header, json, linkIn, password, text } from './support/site.ts';

test('admin handlers create with auth\'s setup delivery, export audited data, revoke one session and apply bulk changes atomically', async t => {
    const site = await adminSite(t);
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password });
    const created = await call('/admin/users/create', owner.token, { fields: { email: 'created@example.test', reason: 'approved onboarding' } });
    assert.equal(created.status, 200);
    const setup = site.sent.at(-1)!;
    assert.equal(setup.template, 'auth.account-setup');
    assert.equal(setup.to, 'created@example.test');
    const token = linkIn(setup).searchParams.get('token')!;
    assert.ok(!text(created).includes(token));
    const user = (await service.listUsers()).users.find(value => value.email === 'created@example.test')!;
    assert.equal(user.emailVerified, false);
    assert.deepEqual(user.roles, ['member']);
    await service.resetPassword({ token, password: 'another sufficiently long password' });
    const login = await service.login({ email: user.email, password: 'another sufficiently long password' });
    const exported = await call('/admin/users/export', owner.token, { fields: { accountId: user.id, reason: 'user requested export' } });
    assert.equal(exported.status, 200);
    assert.equal(header(exported, 'content-disposition'), 'attachment; filename="account-export.json"');
    assert.equal((await call('/admin/sessions/revoke-one', owner.token, { fields: { sessionId: login.principal.sessionId, reason: 'compromised device' } })).status, 200);
    assert.equal(await service.authenticate(login.token), null);
    assert.ok(await service.authenticate(owner.token));
    const again = await service.login({ email: user.email, password: 'another sufficiently long password' });
    await service.updateProfile({ token: again.token, profile: { displayName: '=HYPERLINK("https://example.test")' } });
    const page = await call('/admin/users/export-page', owner.token, { fields: { query: 'created@', role: 'member', reason: 'filtered account report' } });
    assert.equal(page.status, 200);
    const csv = text(page);
    assert.match(csv, /c\*\*\*@example.test/);
    assert.ok(csv.includes("'=HYPERLINK"));
    assert.ok(!csv.includes(user.email));
    // A bulk change that includes the actor's own account is refused as a whole.
    assert.notEqual((await call('/admin/users/bulk', owner.token, { fields: { accountIds: user.id + ',' + owner.user.id, action: 'lock', confirmation: 'LOCK 2', reason: 'must be atomic' } })).status, 200);
    assert.equal((await service.getUser(user.id))?.status, 'active');
    assert.equal((await call('/admin/users/bulk', owner.token, { fields: { accountIds: user.id, action: 'lock', confirmation: 'LOCK 2', reason: 'wrong confirmation' } })).status, 400);
    assert.equal((await service.getUser(user.id))?.status, 'active');
    assert.equal((await call('/admin/users/bulk', owner.token, { fields: { accountIds: user.id, action: 'lock', confirmation: 'LOCK 1', reason: 'confirmed action' } })).status, 200);
    assert.equal((await service.getUser(user.id))?.status, 'locked');
    assert.equal((await call('/admin/users/bulk', owner.token, { fields: { ['selected.' + user.id]: 'yes', action: 'unlock', confirmation: 'UNLOCK 1', reason: 'native checkbox selection' }, form: true })).status, 200);
    assert.equal((await service.getUser(user.id))?.status, 'active');
});

test('identifier reveal needs read and reveal authority, a reason and a fresh proof, and is audited', async t => {
    let now = Date.now();
    const site = await adminSite(t, { roles: { member: [], reader: ['auth.users.read'], revealer: ['auth.users.reveal'], support: ['auth.users.read', 'auth.users.reveal'], admin: ['*'] }, now: () => now });
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password }), target = await service.register({ email: 'private-reveal@example.test', password });
    const detail = text(await call('/admin/users/detail?id=' + target.user.id, owner.token, { html: true }));
    assert.match(detail, /Reveal email address/);
    assert.doesNotMatch(detail, /private-reveal@example/);
    for (const section of ['overview', 'methods', 'sessions', 'recovery', 'activity', 'data']) assert.match(detail, new RegExp('id="detail-' + section + '"'));
    assert.equal((await call('/admin/users/note', owner.token, { fields: { accountId: target.user.id, reason: '<script>synthetic note</script>' } })).status, 200);
    const noted = text(await call('/admin/users/detail?id=' + target.user.id, owner.token, { html: true }));
    assert.match(noted, /&lt;script&gt;synthetic note/);
    assert.doesNotMatch(noted, /<script>synthetic note/);
    const body = { accountId: target.user.id, reason: 'Support confirmed account identifier' };
    assert.equal((await call('/admin/users/reveal', owner.token, { fields: body, csrf: false })).status, 403);
    assert.equal((await call('/admin/users/reveal', owner.token, { fields: { ...body, reason: '' } })).status, 400);
    const revealed = await call('/admin/users/reveal', owner.token, { fields: body });
    assert.equal(revealed.status, 200);
    assert.deepEqual(json(revealed), { id: target.user.id, email: target.user.email });
    assert.ok(header(revealed, 'cache-control')?.includes('no-store'));
    await site.audit.flush();
    const event = (await site.audit.query({ action: 'admin.identifier_revealed' })).events[0]!;
    assert.equal(event.source, 'auth');
    assert.equal(event.actor, owner.user.id);
    assert.equal(event.subject, target.user.id);
    assert.equal(event.reason, body.reason);
    for (const role of ['reader', 'revealer']) {
        await service.adminSetRoles({ actorToken: owner.token, accountId: target.user.id, roles: [role] });
        const actor = await site.signIn(target.user.email);
        assert.equal((await call('/admin/users/reveal', actor, { fields: body })).status, 403);
    }
    await service.adminSetRoles({ actorToken: owner.token, accountId: target.user.id, roles: ['support'] });
    const support = await site.signIn(target.user.email);
    assert.equal((await call('/admin/users/reveal', support, { fields: { accountId: owner.user.id, reason: 'No delegation authority' } })).status, 403);
    now += 300001;
    assert.notEqual((await call('/admin/users/reveal', owner.token, { fields: body })).status, 200);
    await site.audit.flush();
    assert.equal((await site.audit.query({ action: 'admin.identifier_revealed' })).events.length, 1);
});

test('account operations: the method page escapes identifiers, the typed confirmation precedes staging, and auth delivers before it applies', async t => {
    const site = await adminSite(t);
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password }), target = await service.register({ email: 'subject@example.test', password });
    const page = text(await call('/admin/account-operations?accountId=' + target.user.id, owner.token, { html: true }));
    assert.match(page, /two-administrator case/);
    assert.match(page, /name="csrf"/);
    const fields = { action: 'verify-email', accountIds: target.user.id, reason: 'Documented manual verification', confirmation: 'VERIFY-EMAIL 2' };
    assert.equal((await call('/admin/account-operations', owner.token, { fields })).status, 400);
    assert.equal((await service.getUser(target.user.id))?.emailVerified, false);
    const applied = await call('/admin/account-operations', owner.token, { fields: { ...fields, confirmation: 'VERIFY-EMAIL 1' } });
    assert.equal(applied.status, 200);
    assert.deepEqual(json(applied), { affected: 1 });
    assert.equal((await service.getUser(target.user.id))?.emailVerified, true);
    assert.equal(site.sent.at(-1)?.template, 'auth.admin-verify-email');
    assert.doesNotMatch(text(applied), /subject@example|operationId|token/);
    await site.audit.flush();
    assert.ok((await site.audit.query({ subject: target.user.id })).events.some(event => event.action === 'admin.verify-email'));
});

test('manual recovery: evidence is escaped, RESTORE is typed, a second administrator approves and auth delivers the link', async t => {
    const site = await adminSite(t, { auth: { allowManualRecovery: true } });
    const { service, call } = site;
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password }), lost = await service.register({ email: 'lost@example.test', password });
    const checker = await service.register({ email: 'checker@example.test', password });
    await service.adminSetRoles({ actorToken: owner.token, accountId: checker.user.id, roles: ['admin'] });
    assert.equal((await call('/admin/recovery-cases/create', owner.token, { fields: { accountId: lost.user.id, email: 'replacement@example.test', summary: '<img src=x onerror=alert(1)>', reference: 'https://internal.invalid/evidence', reason: 'Lost every factor' } })).status, 200);
    const listed = await call('/admin/recovery-cases', owner.token, { html: true });
    assert.match(text(listed), /&lt;img/);
    assert.doesNotMatch(text(listed), /<img src=x|replacement@example.test|href="https:\/\/internal/);
    const caseId = json<{ cases: { id: string }[] }>(await call('/admin/recovery-cases', owner.token)).cases[0]!.id;
    assert.doesNotMatch(text(await call('/admin/recovery-cases', owner.token)), /replacement@example.test/);
    const reviewer = await site.signIn('checker@example.test');
    assert.equal((await call('/admin/recovery-cases/approve', reviewer, { fields: { caseId, reason: 'Independent assessment' } })).status, 400);
    assert.equal((await call('/admin/recovery-cases/approve', owner.token, { fields: { caseId, reason: 'Self approval', confirmation: 'RESTORE' } })).status, 403);
    const approved = await call('/admin/recovery-cases/approve', reviewer, { fields: { caseId, reason: 'Independent assessment', confirmation: 'RESTORE' } });
    assert.equal(approved.status, 200);
    assert.deepEqual(site.sent.slice(-2).map(message => [message.template, message.to]), [['auth.manual-recovery-warning', 'lost@example.test'], ['auth.manual-recovery', 'replacement@example.test']]);
    assert.ok(!text(approved).includes(linkIn(site.sent.at(-1)!).searchParams.get('token') ?? '\0'));
    assert.equal((await call('/admin/recovery-cases/approve', reviewer, { method: 'GET' })).status, 405);
});

test('the console follows the account locale and the project\'s admin.* copy without translating account data', async t => {
    const site = await adminSite(t, {
        uiConfig: { languages: ['en', 'fr'], copy: 'ui/copy' },
        files: { 'ui/copy/fr.json': JSON.stringify({ 'admin.nav.overview': 'Accueil', 'admin.copy.status': 'État <svg onload=alert(1)>', 'admin.copy.email': 'Courriel', 'admin.copy.recentEvents': 'Événements récents', 'admin.copy.dailyAuthenticationCounts': 'Activité quotidienne', 'admin.message.adminTotals': 'Comptes {users}; sessions {sessions}; verrouillés {locked}; suppression {pending}; attente {waitlist}.' }) },
    });
    const owner = await site.service.bootstrapAdmin({ email: 'owner@example.test', password });
    await site.service.updateProfile({ token: owner.token, profile: { locale: 'fr', displayName: 'Status' } });
    const get = async (path: string) => { const response = await site.call(path, owner.token, { html: true, headers: { 'accept-language': 'en' } }); assert.equal(response.status, 200); return text(response); };
    const users = await get('/admin/users?lang=en');
    assert.match(users, /lang="fr"/);
    assert.match(users, /Accueil/);
    assert.match(users, /État &lt;svg onload=alert\(1\)&gt;/);
    assert.doesNotMatch(users, /<svg onload=/);
    const dashboard = await get('/admin?lang=en');
    assert.match(dashboard, /Événements récents/);
    assert.match(dashboard, /Activité quotidienne/);
    assert.match(dashboard, /Comptes 1; sessions 1/);
    const detail = await get('/admin/users/detail?id=' + owner.user.id);
    assert.match(detail, /<dd>Status<\/dd>/);
    assert.doesNotMatch(detail, /<dd>État/);
});
