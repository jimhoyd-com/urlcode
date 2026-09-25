// AuthExports v1: the signed-in account of a request auth authorized, its CSRF token, auth's page URLs and the
// administration API, without a session token, cookie or key ever leaving auth.
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
import { createAuthService, internal } from '../src/auth-core.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { authPermissions } from '../src/exports.ts';
import type { AuthActor } from '../src/exports.ts';
import { FRESHNESS_WINDOW_MS } from '../src/freshness.ts';
import { authFor } from './support/companions.ts';
import { activatedUi, bodyText } from './support/render.ts';

const origin = 'https://example.test', projectSha256 = 'a'.repeat(64), password = 'correct horse battery staple';
async function setup(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-exports-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const service = internal(await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], support: ['auth.cases.read'], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open', allowImpersonation: true, now: () => now }));
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), http = new AuthHttp({ csrfKey, origin }), ui = await activatedUi(t, root, projectSha256, origin);
    const hosted = await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin);
    const request = (method: string, headers: Record<string, string>, body = '', target = '/app'): ExtensionRequest => ({ method, target, path: target.split('?')[0]!, query: new URLSearchParams(target.split('?')[1] ?? ''), headers: new Headers(headers), headerCounts: Object.fromEntries(Object.keys(headers).map(name => [name, 1])), body: new TextEncoder().encode(body), origin, route: '/app', mount: null, client: null, requestId: 'exports', env: {} });
    return { root, service, http, hosted, request, advance: (ms: number) => { now += ms; } };
}
/** Runs auth's authorize() for `requirement` the way the runtime does, with the principal slot installed. */
async function authorized(instance: Awaited<ReturnType<import('@jimhoyd/urlcode/extensions').RuntimeExtension['activate']>>, requirement: Record<string, unknown>, value: ExtensionRequest) {
    const slot = installPrincipalSlot(value);
    return slot.authorize('auth', true, () => instance.authorize!(requirement, value));
}

test('exports are version 1 and active only between activate and the instance close', async (t) => {
    const { hosted } = await setup(t);
    const { exports } = hosted;
    assert.equal(exports.version, 1);
    assert.equal(exports.active, false);
    assert.deepEqual(exports.permissions, authPermissions);
    assert.equal(authPermissions.length, 11);
    assert.ok(!authPermissions.some(permission => permission.startsWith('auth.audit')));
    assert.throws(() => exports.urls.mount, { code: 'auth_inactive' });
    assert.throws(() => exports.administration, { code: 'auth_inactive' });
    const instance = await hosted.registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    assert.equal(exports.active, true);
    assert.equal(exports.urls.mount, '/account');
    assert.equal(exports.urls.account(), '/account/account');
    await instance.close?.();
    assert.equal(exports.active, false);
});

test('account() answers only for a request auth authorized with a session, and matches its principal', async (t) => {
    const { service, http, hosted, request } = await setup(t);
    const instance = await hosted.registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const { exports } = hosted;
    const alice = await service.register({ email: 'alice@example.test', password, profile: { locale: 'fr' } }), cookie = '__Host-urlcode-session=' + alice.token;
    // Never authorized (a route without an auth policy): null, even with a valid session cookie.
    assert.equal(exports.account(request('GET', { cookie })), null);
    const read = request('GET', { cookie });
    assert.equal(await authorized(instance, {}, read), undefined);
    const account = exports.account(read)!;
    assert.equal(account.id, alice.user.id);
    assert.equal(account.email, 'alice@example.test');
    assert.equal(account.locale, 'fr');
    assert.equal(account.impersonated, false);
    assert.equal(account.fresh, true);
    assert.equal(account.freshUntil, account.authenticatedAt + FRESHNESS_WINDOW_MS);
    assert.equal(account.has('site.read'), true);
    assert.equal(account.has('auth.users.read'), false);
    assert.ok(Object.isFrozen(account));
    assert.ok(!JSON.stringify(account).includes(alice.token));
    // Signed out, a bearer principal, or a principal another provider stamped: null.
    assert.equal(await authorized(instance, {}, request('GET', {})).then(result => result?.status), 401);
    const key = await service.issueApiKey({ name: 'agent', scopes: ['site.read'] }), bearer = request('GET', { authorization: 'Bearer ' + key.key });
    assert.equal(await authorized(instance, { bearer: { scopes: ['site.read'] } }, bearer), undefined);
    assert.equal(exports.account(bearer), null);
    // The same session authorized, but the principal stamped for another provider name.
    const foreign = request('GET', { cookie });
    await installPrincipalSlot(foreign).authorize('other', true, () => instance.authorize!({}, foreign));
    assert.deepEqual(foreign.principal, { id: alice.user.id, provider: 'other' });
    assert.equal(exports.account(foreign), null);
    // csrf.token is the session-bound token authorize() verifies, from the header or the body field.
    const token = exports.csrf.token(read);
    assert.equal(token, http.token(alice.token));
    assert.equal(exports.csrf.field, 'csrf');
    assert.equal(exports.csrf.header, 'x-csrf-token');
    assert.throws(() => exports.csrf.token(request('GET', {})), { code: 'sign_in_required' });
    const write = (headers: Record<string, string>, body: string) => authorized(instance, {}, request('POST', { cookie, origin, ...headers }, body));
    assert.equal(await write({ 'x-csrf-token': token }, ''), undefined);
    assert.equal(await write({ 'content-type': 'application/x-www-form-urlencoded' }, 'csrf=' + token), undefined);
    assert.equal(await write({ 'content-type': 'application/json' }, JSON.stringify({ csrf: token })), undefined);
    assert.equal((await write({ 'content-type': 'application/x-www-form-urlencoded' }, `csrf=${token}&csrf=${token}`))?.status, 403);
    const large = await write({ 'content-type': 'application/json', accept: 'application/json' }, JSON.stringify({ csrf: token, pad: 'x'.repeat(17000) }));
    assert.equal(large?.status, 403);
    assert.match(bodyText(large!.body), /Send the CSRF token in the x-csrf-token header/);
    assert.equal((await write({ 'content-type': 'text/plain' }, 'csrf=' + token))?.status, 403);
    // csrf: origin admits a same-origin write with no token, and refuses cross-site or unprovenanced ones.
    assert.equal(await authorized(instance, { csrf: 'origin' }, request('POST', { cookie, origin }, '{}')), undefined);
    assert.equal((await authorized(instance, { csrf: 'origin' }, request('POST', { cookie, 'sec-fetch-site': 'cross-site', origin }, '{}')))?.status, 403);
    assert.equal((await authorized(instance, { csrf: 'origin' }, request('POST', { cookie }, '{}')))?.status, 403);
});

test('an impersonated session reads as impersonated, and a stale proof as not fresh', async (t) => {
    const { service, hosted, request, advance } = await setup(t);
    const instance = await hosted.registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    // The service clock runs behind: its sessions were proved more than the freshness window ago in real time.
    advance(-(FRESHNESS_WINDOW_MS + 1000));
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password }), member = await service.register({ email: 'member@example.test', password });
    const support = await service.createImpersonation({ actorToken: admin.token, accountId: member.user.id, reason: 'Ticket 42' });
    const impersonated = request('GET', { cookie: '__Host-urlcode-session=' + support.token });
    await authorized(instance, {}, impersonated);
    assert.equal(hosted.exports.account(impersonated)!.impersonated, true);
    assert.equal(hosted.exports.account(impersonated)!.fresh, false, 'a support session is never fresh');
    const stale = request('GET', { cookie: '__Host-urlcode-session=' + member.token });
    await authorized(instance, {}, stale);
    assert.equal(hosted.exports.account(stale)!.fresh, false);
});

test('urls build auth pages and accept only a local returnTo outside auth', async (t) => {
    const { hosted, service, request, http } = await setup(t);
    const instance = await hosted.registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const { urls } = hosted.exports;
    assert.equal(urls.signIn(), '/account/login');
    assert.equal(urls.signIn('/desk/cases?page=2'), '/account/login?returnTo=%2Fdesk%2Fcases%3Fpage%3D2');
    assert.equal(urls.stepUp('/admin/users'), '/account/step-up?returnTo=%2Fadmin%2Fusers');
    for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '/desk\u0000', '/desk\nx', '/' + 'x'.repeat(512), 'desk', '/account/login', '/account'])
        assert.throws(() => urls.signIn(bad), TypeError, JSON.stringify(bad));
    // onDeny: sign-in sends the browser to sign in with the page it asked for.
    const denied = await authorized(instance, { onDeny: 'sign-in' }, request('GET', {}, '', '/desk/cases?page=2'));
    assert.equal(denied?.status, 303);
    assert.equal(Object.fromEntries(denied!.headers).location, '/account/login?returnTo=%2Fdesk%2Fcases%3Fpage%3D2');
    const unsafe = await authorized(instance, { onDeny: 'sign-in' }, request('GET', {}, '', '//evil.example'));
    assert.equal(Object.fromEntries(unsafe!.headers).location, '/account/login');
    // After sign-in auth answers 303 to the submitted returnTo; a foreign one falls back to the account page.
    await service.register({ email: 'reader@example.test', password });
    const flow = randomBytes(32).toString('base64url');
    const login = (returnTo: string) => instance.handle({ method: 'POST', target: '/account/login', path: '/account/login', query: new URLSearchParams(), headers: new Headers({ origin, cookie: '__Host-urlcode-flow=' + flow, 'content-type': 'application/x-www-form-urlencoded' }), headerCounts: {}, body: new TextEncoder().encode(new URLSearchParams({ email: 'reader@example.test', password, returnTo, csrf: http.token(flow) }).toString()), origin, route: '/account/*', mount: '/account', client: null, requestId: 'login', env: {} });
    assert.equal(Object.fromEntries((await login('/desk/cases')).headers).location, '/desk/cases');
    assert.equal(Object.fromEntries((await login('//evil.example')).headers).location, '/account/account');
});

test('administration names an actor: a forged one, a revoked or impersonated session is refused', async (t) => {
    const { service, hosted, request } = await setup(t);
    const instance = await hosted.registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password });
    const signedIn = request('GET', { cookie: '__Host-urlcode-session=' + admin.token });
    await authorized(instance, {}, signedIn);
    const { administration } = hosted.exports, account = hosted.exports.account(signedIn)!;
    assert.equal((await administration.reauthorize(account.actor, { permissions: ['auth.users.read', 'audit.read'], fresh: true })).id, admin.user.id);
    await assert.rejects(administration.dashboard({} as AuthActor), { code: 'invalid_actor' });
    await assert.rejects(administration.users.setRoles(Object.freeze(Object.create(null)) as AuthActor, { accountId: admin.user.id, roles: ['admin'], reason: 'x' }), { code: 'invalid_actor' });
    await service.logout(admin.token);
    await assert.rejects(administration.reauthorize(account.actor, { permissions: [] }), { status: 401, code: 'invalid_session' });
    await assert.rejects(administration.dashboard(account.actor), { status: 401 });
});

test('activation refuses an inactive audit or mail extension', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-companions-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', registrationMode: 'open' });
    cleanup(t, () => service.close());
    const ui = await activatedUi(t, root, projectSha256, origin), context = { origin, target: 'node' as const, projectSha256, mounts: ['/account'], root };
    const { siteCompanions, companions } = await import('./support/companions.ts'), { createAuth } = await import('../src/auth.ts');
    const hosted = await siteCompanions(t, root, projectSha256), active = await companions(t, root, projectSha256, origin);
    await assert.rejects(Promise.resolve(createAuth({ service, csrfKey: randomBytes(32), projectSha256, ui, audit: hosted.audit, mail: active.mail }).registration.activate({ registration: 'open' }, context)), /activated audit extension/);
    await assert.rejects(Promise.resolve(createAuth({ service, csrfKey: randomBytes(32), projectSha256, ui, audit: active.audit, mail: hosted.mail }).registration.activate({ registration: 'open' }, context)), /activated mail extension/);
});
