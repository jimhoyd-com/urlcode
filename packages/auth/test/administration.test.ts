// AuthAdministration: every read checks the actor's permission here, every mutation is re-checked in auth's store
// transaction, and every credential or notice an administrator causes is delivered by auth itself through mail.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { installPrincipalSlot } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { MailEnvelope, MailTransport } from '@jimhoyd/urlcode-mail';
import { createAuthService, internal } from '../src/auth-core.ts';
import type { AuthOptions } from '../src/auth-core.ts';
import type { AuthAccount } from '../src/exports.ts';
import { FRESHNESS_WINDOW_MS } from '../src/freshness.ts';
import { authFor, linkIn } from './support/companions.ts';
import type { CompanionOptions } from './support/companions.ts';
import { activatedUi } from './support/render.ts';

const origin = 'https://example.test', projectSha256 = 'a'.repeat(64), password = 'correct horse battery staple';
async function setup(t: TestContext, options: Partial<AuthOptions> = {}, mail: CompanionOptions = {}) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-administration-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let clock = Date.now();
    const service = internal(await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], reader: ['auth.users.read'], support: ['auth.users.read', 'auth.users.manage', 'auth.cases.read', 'auth.cases.manage'], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open', now: () => clock, ...options }));
    cleanup(t, () => service.close());
    const ui = await activatedUi(t, root, projectSha256, origin), hosted = await authFor(t, root, { service, csrfKey: randomBytes(32), projectSha256, ui }, origin, mail);
    const instance = await hosted.registration.activate({ registration: options.registrationMode ?? 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
    cleanup(t, () => instance.close?.());
    /** The account behind `token`, as a consumer on an auth-guarded route receives it. */
    const accountOf = async (token: string): Promise<AuthAccount> => {
        const request: ExtensionRequest = { method: 'GET', target: '/admin', path: '/admin', query: new URLSearchParams(), headers: new Headers({ cookie: '__Host-urlcode-session=' + token }), headerCounts: {}, body: new Uint8Array(), origin, route: '/admin/*', mount: '/admin', client: null, requestId: 'administration', env: {} };
        const denied = await installPrincipalSlot(request).authorize('auth', true, () => instance.authorize!({}, request));
        assert.equal(denied, undefined);
        return hosted.exports.account(request)!;
    };
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password });
    return { service, hosted, administration: hosted.exports.administration, accountOf, admin, advance: (ms: number) => { clock += ms; } };
}

test('every read checks the actor\'s permission; a reader without it is refused', async (t) => {
    const { service, administration, accountOf, admin } = await setup(t);
    const reader = await service.register({ email: 'reader@example.test', password });
    await service.adminSetRoles({ actorToken: admin.token, accountId: reader.user.id, roles: ['reader'] });
    const readerAccount = await accountOf((await service.login({ email: 'reader@example.test', password })).token), owner = await accountOf(admin.token);
    assert.equal((await administration.users.list(readerAccount.actor, {})).users.length, 2);
    assert.equal((await administration.users.get(readerAccount.actor, admin.user.id))!.email, 'owner@example.test');
    assert.equal((await administration.dashboard(readerAccount.actor)).users, 2);
    for (const read of [() => administration.roles(readerAccount.actor), () => administration.users.sessions(readerAccount.actor, admin.user.id), () => administration.sessions.list(readerAccount.actor, {}), () => administration.registrations.list(readerAccount.actor, {}), () => administration.cases.list(readerAccount.actor, {}), () => administration.cases.get(readerAccount.actor, 'x'), () => administration.recovery.list(readerAccount.actor, {})])
        await assert.rejects(read(), { status: 403, code: 'permission_denied' });
    assert.deepEqual(Object.keys(await administration.roles(owner.actor)).sort(), ['admin', 'member', 'reader', 'support']);
    // Mutations are refused inside the store transaction.
    await assert.rejects(administration.users.setStatus(readerAccount.actor, { accountId: admin.user.id, status: 'locked', reason: 'no' }), { status: 403 });
    // The last-administrator guard holds whatever the caller.
    await assert.rejects(administration.users.bulk(owner.actor, { accountIds: [admin.user.id], action: 'lock', reason: 'self' }), { status: 403 });
});

test('capabilities follow mail delivery and the operator switches', async (t) => {
    const without = await setup(t, { registrationMode: 'invite-only', allowImpersonation: true, allowManualRecovery: true }, { transport: false });
    assert.deepEqual({ ...without.administration.capabilities }, { delivery: false, invitations: false, impersonation: false, manualRecovery: false, accountOperations: false });
    const owner = await without.accountOf(without.admin.token);
    await assert.rejects(without.administration.users.create(owner.actor, { email: 'new@example.test', reason: 'Onboarding' }), { status: 503, code: 'delivery_unavailable' });
    assert.equal((await without.service.listUsers()).users.length, 1, 'nothing is created without delivery');
    const withMail = await setup(t, { registrationMode: 'invite-only', allowImpersonation: true, allowManualRecovery: true });
    assert.deepEqual({ ...withMail.administration.capabilities }, { delivery: true, invitations: true, impersonation: true, manualRecovery: true, accountOperations: true });
    // Only invite-only registration redeems an invitation, so an open site offers none (the store refuses it).
    const open = await setup(t, { registrationMode: 'open' });
    assert.equal(open.administration.capabilities.invitations, false);
    await assert.rejects(open.administration.registrations.invite((await open.accountOf(open.admin.token)).actor, { email: 'invited@example.test' }), { status: 403, code: 'registration_unavailable' });
    const plain = await setup(t, { registrationMode: 'off' });
    assert.deepEqual({ ...plain.administration.capabilities }, { delivery: true, invitations: false, impersonation: false, manualRecovery: false, accountOperations: true });
});

test('account creation and invitations deliver a token link auth builds; a failed delivery keeps the account and reports 502', async (t) => {
    let fail = false;
    const sent: MailEnvelope[] = [];
    const transport: MailTransport = { kind: 'flaky', development: true, async deliver(envelope) { if (fail) throw new Error('synthetic outage'); sent.push(envelope); } };
    const { service, administration, accountOf, admin } = await setup(t, { registrationMode: 'invite-only' }, { transport });
    const owner = await accountOf(admin.token);
    const created = await administration.users.create(owner.actor, { email: 'new@example.test', reason: 'Onboarding' });
    assert.equal(created.user.email, 'new@example.test');
    assert.ok(!('setupToken' in created));
    const setupLink = linkIn(sent.at(-1)!);
    assert.equal(sent.at(-1)!.template, 'auth.account-setup');
    assert.equal(setupLink.origin + setupLink.pathname, origin + '/account/reset');
    await service.resetPassword({ token: setupLink.searchParams.get('token')!, password: 'a password the new user chose' });
    await administration.registrations.invite(owner.actor, { email: 'invited@example.test' });
    assert.equal(sent.at(-1)!.template, 'auth.invitation');
    assert.equal(linkIn(sent.at(-1)!).pathname, '/account/register');
    fail = true;
    await assert.rejects(administration.users.create(owner.actor, { email: 'later@example.test', reason: 'Onboarding' }), { status: 502, code: 'delivery_failed' });
    assert.ok((await service.listUsers({ query: 'later@' })).users.length === 1, 'the account stays; the operator can resend');
});

test('account operations deliver every staged message, and a failed delivery cancels the whole operation', async (t) => {
    let fail = false;
    const sent: MailEnvelope[] = [];
    const transport: MailTransport = { kind: 'flaky', development: true, async deliver(envelope) { if (fail) throw new Error('synthetic outage'); sent.push(envelope); } };
    const { service, administration, accountOf, admin } = await setup(t, {}, { transport });
    const member = await service.register({ email: 'member@example.test', password });
    const owner = await accountOf(admin.token);
    fail = true;
    await assert.rejects(administration.users.administer(owner.actor, { action: 'force-password-reset', accountIds: [member.user.id], reason: 'Compromise suspected' }));
    assert.equal(sent.length, 0);
    assert.ok((await service.login({ email: 'member@example.test', password })).token, 'a cancelled operation changed nothing');
    fail = false;
    assert.deepEqual(await administration.users.administer(owner.actor, { action: 'force-password-reset', accountIds: [member.user.id], reason: 'Compromise suspected' }), { affected: 1 });
    assert.equal(sent.at(-1)!.template, 'auth.reset-password');
    await assert.rejects(service.login({ email: 'member@example.test', password }), { code: 'invalid_credentials' });
    await administration.users.administer(owner.actor, { action: 'assign-roles', accountIds: [member.user.id], roles: ['support'], reason: 'Joined support' });
    assert.equal(sent.at(-1)!.template, 'auth.admin-assign-roles');
    assert.equal(linkIn(sent.at(-1)!).href, origin + '/account/account');
});

test('manual recovery warns the old address first, then delivers the link; a failed delivery cancels the credential', async (t) => {
    let fail = false;
    const sent: MailEnvelope[] = [];
    const transport: MailTransport = { kind: 'flaky', development: true, async deliver(envelope) { if (fail && envelope.template === 'auth.manual-recovery') throw new Error('synthetic outage'); sent.push(envelope); } };
    const { service, administration, accountOf, admin } = await setup(t, { allowManualRecovery: true }, { transport });
    const checker = await service.register({ email: 'checker@example.test', password }), lost = await service.register({ email: 'lost@example.test', password });
    await service.adminSetRoles({ actorToken: admin.token, accountId: checker.user.id, roles: ['admin'] });
    const maker = await accountOf(admin.token), approver = await accountOf((await service.login({ email: 'checker@example.test', password })).token);
    const open = () => administration.recovery.create(maker.actor, { accountId: lost.user.id, email: 'restored@example.test', evidence: { summary: 'Verified in person' }, reason: 'Lost every factor' });
    const first = await open();
    fail = true;
    await assert.rejects(administration.recovery.approve(approver.actor, { caseId: first.id, reason: 'Evidence holds' }));
    assert.equal((await administration.recovery.list(maker.actor, {})).cases.find(item => item.id === first.id)!.recovery.state, 'cancelled');
    fail = false;
    const second = await open();
    await administration.recovery.approve(approver.actor, { caseId: second.id, reason: 'Evidence holds' });
    assert.deepEqual(sent.slice(-2).map(envelope => [envelope.template, envelope.to]), [['auth.manual-recovery-warning', 'lost@example.test'], ['auth.manual-recovery', 'restored@example.test']]);
    const restored = await service.redeemRecoveryCase({ token: linkIn(sent.at(-1)!).searchParams.get('token')!, password: 'a restored account passphrase' });
    assert.equal(restored.user.email, 'restored@example.test');
});

test('impersonation needs its notice delivered; a failed notice ends the support session', async (t) => {
    let fail = true;
    const sent: MailEnvelope[] = [];
    const transport: MailTransport = { kind: 'flaky', development: true, async deliver(envelope) { if (fail) throw new Error('synthetic outage'); sent.push(envelope); } };
    const { service, administration, accountOf, admin } = await setup(t, { allowImpersonation: true }, { transport });
    const member = await service.register({ email: 'member@example.test', password });
    const owner = await accountOf(admin.token);
    await assert.rejects(administration.impersonate(owner.actor, { accountId: member.user.id, reason: 'Ticket 9' }));
    assert.equal((await service.listAllSessions({ accountId: member.user.id })).sessions.length, 1, 'only the member\'s own session remains');
    fail = false;
    const started = await administration.impersonate(owner.actor, { accountId: member.user.id, reason: 'Ticket 9' });
    assert.equal(started.location, '/account/account');
    const cookie = started.headers.find(([name, value]) => name === 'set-cookie' && value.startsWith('__Host-urlcode-session='))![1];
    const token = cookie.split(';')[0]!.split('=')[1]!;
    assert.equal((await service.authenticate(token))!.impersonatorId, admin.user.id);
    assert.deepEqual([sent.at(-1)!.template, sent.at(-1)!.to], ['auth.impersonation-started', 'member@example.test']);
    assert.match(sent.at(-1)!.text, /Reason given: Ticket 9/);
});

test('exportRange returns the complete selection with fresh authority, and refuses a stale actor or a cursor', async (t) => {
    const { service, administration, accountOf, admin, advance } = await setup(t);
    for (let index = 0; index < 3; index++)
        await service.register({ email: `user-${index}@example.test`, password });
    const owner = await accountOf(admin.token);
    const rows = await administration.users.exportRange(owner.actor, { query: { sort: 'email' }, reason: 'Quarterly review' });
    assert.deepEqual(rows.map(row => row.email), ['owner@example.test', 'user-0@example.test', 'user-1@example.test', 'user-2@example.test']);
    assert.ok(rows.every(row => !('passwordHash' in row)));
    await assert.rejects(administration.users.exportRange(owner.actor, { query: { after: 'abc' }, reason: 'x' }), { status: 400 });
    await assert.rejects(administration.users.exportRange(owner.actor, { query: {}, reason: ' ' }), { status: 400 });
    advance(FRESHNESS_WINDOW_MS + 1000);
    await assert.rejects(administration.users.exportRange(owner.actor, { query: {}, reason: 'Quarterly review' }), { status: 401, code: 'fresh_authentication_required' });
});

test('administrator deliveries run at most four at once and time out after five seconds', async (t) => {
    const hung: (() => void)[] = [];
    const transport: MailTransport = { kind: 'hung', development: true, deliver: (_envelope, signal) => new Promise((_resolve, reject) => { hung.push(() => reject(new Error('released'))); signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }) };
    const { service, administration, accountOf, admin } = await setup(t, {}, { transport });
    const owner = await accountOf(admin.token);
    const pending = Array.from({ length: 4 }, (_, index) => administration.users.create(owner.actor, { email: `slow-${index}@example.test`, reason: 'Onboarding' }).catch((error: { status?: number; code?: string }) => error));
    while (hung.length < 4)
        await new Promise(resolve => setTimeout(resolve, 10));
    // A fifth is refused at once and creates nothing.
    await assert.rejects(administration.users.create(owner.actor, { email: 'fifth@example.test', reason: 'Onboarding' }), { status: 503, code: 'delivery_busy' });
    assert.equal((await service.listUsers({ query: 'fifth@' })).users.length, 0);
    // The held deliveries hit the five-second deadline and report a failed delivery.
    const started = performance.now(), results = await Promise.all(pending);
    assert.ok(performance.now() - started < 6000);
    assert.deepEqual(results.map(result => (result as { code?: string }).code), Array(4).fill('delivery_failed'));
    for (const release of hung)
        release();
});

test('direct administration calls need a fresh actor, and nobody can demote, lock or case away the last administrator', async (t) => {
    const manager = ['auth.users.read', 'auth.users.manage', 'auth.roles.read', 'auth.sessions.manage', 'auth.cases.read', 'auth.cases.manage'];
    const { service, administration, accountOf, admin, advance } = await setup(t, { roles: { member: ['site.read'], manager, admin: ['*'] } });
    const ids: string[] = [];
    for (const email of ['manager-1@example.test', 'manager-2@example.test']) {
        ids.push((await service.register({ email, password })).user.id);
        await service.adminSetRoles({ actorToken: admin.token, accountId: ids.at(-1)!, roles: ['manager'] });
    }
    const owner = await accountOf(admin.token), maker = await accountOf((await service.login({ email: 'manager-1@example.test', password })).token), approver = await accountOf((await service.login({ email: 'manager-2@example.test', password })).token);
    // The store's guard (409 last_administrator_required) sits behind two earlier refusals: only an account holding
    // every permission can change an administrator, and nobody administers their own account.
    const ceiling = { status: 403, code: 'delegation_ceiling_exceeded' }, self = { status: 403, code: 'self_administration_denied' };
    await assert.rejects(administration.users.setRoles(maker.actor, { accountId: admin.user.id, roles: ['member'], reason: 'Demote' }), ceiling);
    await assert.rejects(administration.users.setStatus(maker.actor, { accountId: admin.user.id, status: 'locked', reason: 'Lock' }), ceiling);
    await assert.rejects(administration.users.bulk(maker.actor, { accountIds: [admin.user.id], action: 'lock', reason: 'Bulk lock' }), ceiling);
    await assert.rejects(administration.cases.create(maker.actor, { accountId: admin.user.id, action: 'roles', roles: ['member'], reason: 'Demote by case' }), ceiling);
    await assert.rejects(administration.users.setRoles(owner.actor, { accountId: admin.user.id, roles: ['member'], reason: 'Step down' }), self);
    await assert.rejects(administration.users.setStatus(owner.actor, { accountId: admin.user.id, status: 'locked', reason: 'Step down' }), self);
    await assert.rejects(administration.users.bulk(owner.actor, { accountIds: [ids[0]!, admin.user.id], action: 'lock', reason: 'Step down' }), self);
    const unchanged = (await service.getUser(admin.user.id))!;
    assert.deepEqual([unchanged.roles, unchanged.status], [['admin'], 'active']);
    assert.equal((await service.getUser(ids[0]!))!.status, 'active', 'a refused bulk operation changes nobody');
    // A manager's case on another manager still needs a distinct, fresh approver.
    const lock = await administration.cases.create(maker.actor, { accountId: ids[1]!, action: 'lock', reason: 'Review' });
    await assert.rejects(administration.cases.approve(maker.actor, { caseId: lock.id, reason: 'Self approval' }), { status: 403 });
    // Past the freshness window a direct call is refused before anything changes, whoever the caller.
    advance(FRESHNESS_WINDOW_MS + 1000);
    const stale = { status: 401, code: 'fresh_authentication_required' };
    await assert.rejects(administration.users.setStatus(owner.actor, { accountId: ids[1]!, status: 'locked', reason: 'Stale' }), stale);
    await assert.rejects(administration.users.setRoles(owner.actor, { accountId: ids[1]!, roles: ['member'], reason: 'Stale' }), stale);
    await assert.rejects(administration.users.bulk(owner.actor, { accountIds: [ids[1]!], action: 'lock', reason: 'Stale' }), stale);
    await assert.rejects(administration.cases.approve(approver.actor, { caseId: lock.id, reason: 'Stale' }), stale);
    assert.deepEqual([(await service.getUser(ids[1]!))!.status, (await service.getUser(ids[1]!))!.roles], ['active', ['manager']]);
});
