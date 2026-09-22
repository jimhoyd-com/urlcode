import { cleanup } from './cleanup.ts';
import type { TestContext } from 'node:test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { TOTP } from 'otpauth';
import { createAuthService, sessionReference } from '../src/auth-core.ts';
import type { AuthOptions, AuthService } from '../src/auth-core.ts';
import { authExtension } from '../src/auth.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import { activatedUi } from './support/render.ts';

const email = 'mailbox-owner@example.test', firstPassword = 'first registrant password phrase', ownerPassword = 'mailbox owner chosen password phrase';
async function setup(t: TestContext, extra: Partial<AuthOptions> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'urlcode-auth-claim-'));
    let timestamp = 1800000000000;
    const service = await createAuthService({ database: join(directory, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { user: ['content.read'], admin: ['*'] }, defaultRole: 'user', allowPasskeySecondFactor: true, trustedDeviceTtlMs: 600000, now: () => timestamp, ...extra });
    cleanup(t, async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
    return { service, now: () => timestamp, advance: (ms: number) => { timestamp += ms; } };
}
async function factorProof(service: AuthService, credentialId: string) {
    const stored = (await service.getPasskey(credentialId))!, browserHash = '2'.repeat(64);
    return { token: await service.createSecondFactorProof({ browserHash, proof: { ...stored.proof, newCounter: stored.credential.counter + 1 } }), browserHash };
}
/** An unverified account whose registrant added every kind of sign-in method and factor. */
async function unverifiedWithMethods(service: AuthService, now: () => number) {
    const first = await service.register({ email, password: firstPassword });
    await service.linkExternal({ sessionReference: sessionReference(first.token),  provider: 'oidc', subject: 'first-subject' });
    await service.addPasskey({ actorToken: first.token, credential: { id: 'first-key', publicKey: 'synthetic-first-key', counter: 0 } });
    await service.setPasskeySecondFactor({ token: first.token, credentialId: 'first-key', enabled: true, secondFactor: await factorProof(service, 'first-key') });
    const setup = await service.beginTotp(first.token), totp = new TOTP({ secret: setup.secret });
    const codes = await service.confirmTotp({ token: first.token, code: totp.generate({ timestamp: now() }) });
    const trust = await service.rememberDevice({ token: first.token });
    const before = (await service.getUser(first.user.id))!;
    assert.equal(before.emailVerified, false);
    assert.equal(before.totpEnabled, true);
    assert.equal(before.passkeyMfaEnabled, true);
    const passkeyProof = { ...(await service.getPasskey('first-key'))!.proof };
    const oidcProof = (await service.getExternalProof('oidc', 'first-subject'))!.proof;
    return { first, codes, trust, passkeyProof, oidcProof };
}
async function assertEarlierMethodsRemoved(service: AuthService, earlier: Awaited<ReturnType<typeof unverifiedWithMethods>>, proof: string) {
    const user = (await service.getUser(earlier.first.user.id))!;
    assert.equal(user.emailVerified, true);
    assert.equal(user.totpEnabled, false);
    assert.equal(user.passkeyMfaEnabled, undefined);
    assert.equal(await service.authenticate(earlier.first.token), null);
    assert.deepEqual(await service.listPasskeys(user.id), []);
    assert.equal(await service.getPasskey('first-key'), null);
    assert.equal(await service.findExternal('oidc', 'first-subject'), null);
    assert.equal(await service.getExternalProof('oidc', 'first-subject'), null);
    await assert.rejects(service.login({ email, password: firstPassword }), { code: 'invalid_credentials' });
    await assert.rejects(service.login({ email, password: firstPassword, recoveryCode: earlier.codes.recoveryCodes[0]! }), { code: 'invalid_credentials' });
    await assert.rejects(service.login({ email, password: firstPassword, trustedDevice: earlier.trust.token }), { code: 'invalid_credentials' });
    await assert.rejects(service.issueSession(user.id, { method: 'oidc', proof: earlier.oidcProof }));
    await assert.rejects(service.issueSession(user.id, { method: 'passkey', proof: { ...earlier.passkeyProof, newCounter: 5 } }));
    const claimed = (await service.listAudit({ action: 'account.claimed' })).events;
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.subject, user.id);
    assert.deepEqual(JSON.parse(claimed[0]!.reason), { proof, removed: { passkeys: 1, identities: 1, recoveryCodes: 10, trustedDevices: 1, sessions: 1, authenticator: true, password: true } });
}

test('first mailbox proof by password reset removes sign-in methods added while unverified', async (t) => {
    const { service, now } = await setup(t), earlier = await unverifiedWithMethods(service, now);
    const reset = (await service.issueToken({ email, purpose: 'reset-password' })).token!;
    await service.resetPassword({ token: reset, password: ownerPassword });
    await assertEarlierMethodsRemoved(service, earlier, 'password-reset');
    const owner = await service.login({ email, password: ownerPassword });
    assert.equal(owner.principal.id, earlier.first.user.id);
    assert.equal(owner.principal.restrictions, undefined);
});

test('first mailbox proof by email code removes earlier methods, the password and does not demand earlier factors', async (t) => {
    const { service, now } = await setup(t), earlier = await unverifiedWithMethods(service, now);
    const code = await service.issueEmailCode({ email });
    const owner = await service.consumeEmailCode({ flowId: code.flowId, code: code.code! });
    assert.equal(owner.principal.id, earlier.first.user.id);
    assert.ok(await service.authenticate(owner.token), 'the session issued by the proof survives');
    await assertEarlierMethodsRemoved(service, earlier, 'email-code');
    const again = await service.issueEmailCode({ email });
    await service.consumeEmailCode({ flowId: again.flowId, code: again.code! });
    assert.equal((await service.listAudit({ action: 'account.claimed' })).events.length, 1, 'a verified account is not claimed again');
});

test('first mailbox proof by verification link outside the registrant session removes earlier methods and the password', async (t) => {
    const { service, now } = await setup(t), earlier = await unverifiedWithMethods(service, now);
    const other = await service.register({ email: 'unrelated@example.test', password: ownerPassword });
    const link = (await service.issueToken({ email, purpose: 'verify-email' })).token!;
    const verified = await service.consumeVerification(link, other.token);
    assert.equal(verified.signInMethodsReset, true);
    await assertEarlierMethodsRemoved(service, earlier, 'verify-email');
    assert.ok(await service.authenticate(other.token), 'a different account session is untouched');
    const reset = (await service.issueToken({ email, purpose: 'reset-password' })).token!;
    await service.resetPassword({ token: reset, password: ownerPassword });
    assert.equal((await service.login({ email, password: ownerPassword })).principal.id, earlier.first.user.id);
});

test('the registrant verifying in its own session keeps its methods', async (t) => {
    const { service } = await setup(t), first = await service.register({ email, password: firstPassword });
    await service.addPasskey({ actorToken: first.token, credential: { id: 'own-key', publicKey: 'synthetic-own-key', counter: 0 } });
    const verified = await service.consumeVerification((await service.issueToken({ email, purpose: 'verify-email' })).token!, first.token);
    assert.equal(verified.emailVerified, true);
    assert.equal(verified.signInMethodsReset, undefined);
    assert.ok(await service.authenticate(first.token));
    assert.equal((await service.listPasskeys(first.user.id)).length, 1);
    assert.equal((await service.login({ email, password: firstPassword })).principal.id, first.user.id);
    assert.equal((await service.listAudit({ action: 'account.claimed' })).events.length, 0);
});

test('password reset of an already verified account keeps its passkeys, links and factors', async (t) => {
    const { service, now, advance } = await setup(t), first = await service.register({ email, password: firstPassword });
    await service.consumeVerification((await service.issueToken({ email, purpose: 'verify-email' })).token!, first.token);
    await service.linkExternal({ sessionReference: sessionReference(first.token),  provider: 'oidc', subject: 'verified-subject' });
    await service.addPasskey({ actorToken: first.token, credential: { id: 'verified-key', publicKey: 'synthetic-verified-key', counter: 0 } });
    const setup2 = await service.beginTotp(first.token), totp = new TOTP({ secret: setup2.secret });
    await service.confirmTotp({ token: first.token, code: totp.generate({ timestamp: now() }) });
    await service.resetPassword({ token: (await service.issueToken({ email, purpose: 'reset-password' })).token!, password: ownerPassword });
    assert.equal((await service.listPasskeys(first.user.id)).length, 1);
    assert.ok(await service.findExternal('oidc', 'verified-subject'));
    assert.equal((await service.getUser(first.user.id))?.totpEnabled, true);
    await assert.rejects(service.login({ email, password: ownerPassword }), { code: 'invalid_credentials' });
    advance(30000);
    assert.equal((await service.login({ email, password: ownerPassword, totp: totp.generate({ timestamp: now() }) })).principal.id, first.user.id);
    const code = await service.issueEmailCode({ email });
    await assert.rejects(service.consumeEmailCode({ flowId: code.flowId, code: code.code! }), { code: 'invalid_credentials' });
    assert.equal((await service.listAudit({ action: 'account.claimed' })).events.length, 0);
});

test('required verification refuses new sign-in methods and factors before mailbox proof', async (t) => {
    const { service } = await setup(t, { requireEmailVerification: true }), first = await service.register({ email, password: firstPassword });
    await assert.rejects(service.addPasskey({ actorToken: first.token, credential: { id: 'early-key', publicKey: 'synthetic-early-key', counter: 0 } }), { code: 'enrollment_required' });
    await assert.rejects(service.linkExternal({ sessionReference: sessionReference(first.token),  provider: 'oidc', subject: 'early-subject' }), { code: 'enrollment_required' });
    await assert.rejects(service.beginTotp(first.token), { code: 'enrollment_required' });
    await assert.rejects(service.rememberDevice({ token: first.token }));
});

test('HTTP verification without the registrant session reports that a new password is required', async (t) => {
    const { service } = await setup(t), first = await service.register({ email, password: firstPassword });
    await service.addPasskey({ actorToken: first.token, credential: { id: 'http-key', publicKey: 'synthetic-http-key', counter: 0 } });
    const origin = 'https://example.test', projectSha256 = 'a'.repeat(64), csrfKey = randomBytes(32), http = new AuthHttp({ origin, csrfKey }), delivered: { purpose: string; token: string }[] = [];
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui, sendToken: async (message) => { delivered.push(message); } }).activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const cookies = new Map<string, string>();
    const call = async (path: string, data?: Record<string, string>) => {
        const request: ExtensionRequest = { method: data ? 'POST' : 'GET', target: '/account' + path, path: '/account' + path, query: new URLSearchParams(), headers: new Headers({ cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), origin, ...(data ? { 'content-type': 'application/json' } : {}), accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: Buffer.from(data ? JSON.stringify({ ...data, csrf: http.token(cookies.get('__Host-urlcode-session') || cookies.get('__Host-urlcode-flow') || '') }) : ''), origin, route: '/account/*', mount: '/account', client: null };
        const result = await instance.handle(request);
        for (const [name, value] of result.headers)
            if (name === 'set-cookie') {
                const [key, content] = value.split(';')[0]!.split('=');
                if (value.includes('Max-Age=0'))
                    cookies.delete(key!);
                else
                    cookies.set(key!, content!);
            }
        return { status: result.status, json: JSON.parse(Buffer.from(result.body ?? '').toString() || 'null') as Record<string, unknown> };
    };
    await call('/csrf');
    const link = (await service.issueToken({ email, purpose: 'verify-email' })).token!;
    const verified = await call('/verify', { token: link });
    assert.equal(verified.status, 200);
    assert.deepEqual(verified.json, { verified: true, signInRequired: true, passwordResetRequired: true });
    assert.equal(await service.authenticate(first.token), null);
    assert.deepEqual(await service.listPasskeys(first.user.id), []);
    assert.equal(delivered.length, 0);
});
