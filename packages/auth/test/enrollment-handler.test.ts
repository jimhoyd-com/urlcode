import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { createAuthService } from '../src/auth-core.ts';
import { accountOf } from '../src/exports.ts';
import { authFor, lastSent, linkIn } from './support/companions.ts';
import type { AuthPrincipal } from '../src/auth-core.ts';
/** AuthAccount.has: what an administrative consumer checks. */
const hasPermission = (principal: AuthPrincipal, permission: string) => accountOf(principal, '', undefined).has(permission);
import { AuthHttp } from '../src/auth-ui.ts';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import { activatedUi } from './support/render.ts';
test('restricted bootstrap sessions can verify and enroll but cannot access even authenticated-only policies', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-enrollment-handler-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], admin: ['*'] }, defaultRole: 'member', requireEmailVerification: true, requireMfa: true, now: () => now });
    cleanup(t, () => service.close());
    const account = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    let token = account.token;
    const cookies = new Map([['__Host-urlcode-session', token]]);
    assert.deepEqual(account.principal.restrictions, ['verify-email', 'enroll-mfa']);
    assert.deepEqual(account.principal.permissions, []);
    assert.equal(hasPermission(account.principal, 'auth.users.manage'), false);
    const origin = 'https://example.test', projectSha256 = 'a'.repeat(64), csrfKey = randomBytes(32), http = new AuthHttp({ origin, csrfKey });
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const hosted = await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin);
    const instance = await hosted.registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    function request(path: string, data?: Record<string, string>, html = false): ExtensionRequest { return { method: data ? 'POST' : 'GET', target: path, path, query: new URLSearchParams(), headers: new Headers({ cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), origin, ...(data ? { 'content-type': 'application/json' } : {}), accept: html ? 'text/html' : 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: Buffer.from(data ? JSON.stringify({ ...data, csrf: http.token(cookies.get('__Host-urlcode-session') || cookies.get('__Host-urlcode-flow') || '') }) : ''), origin, route: '/account/*', mount: '/account', client: null, requestId: 'test-request', env: {} }; }
    async function call(path: string, data?: Record<string, string>) {
        const result = await instance.handle(request('/account' + path, data));
        for (const [name, value] of result.headers)
            if (name === 'set-cookie') {
                const [key, content] = value.split(';')[0]!.split('=');
                if (value.includes('Max-Age=0'))
                    cookies.delete(key!);
                else {
                    cookies.set(key!, content!);
                    if (key === '__Host-urlcode-session')
                        token = content!;
                }
            }
        return result;
    }
    assert.equal((await instance.authorize!({}, request('/private')))?.status, 403);
    assert.equal((await instance.authorize!({ permission: '*' }, request('/private')))?.status, 403);
    const redirect = await instance.authorize!({ onDeny: 'sign-in' }, request('/private'));
    assert.equal(redirect?.status, 303);
    assert.ok(redirect?.headers.some(([key, value]) => key === 'location' && value === '/account/account'));
    const limitedPage = await instance.handle(request('/account/account', undefined, true)), html = Buffer.from(limitedPage.body ?? '').toString();
    assert.match(html, /Verify your email first/);
    assert.doesNotMatch(html, /action="\/account\/totp\/begin"|action="\/account\/change-password"/);
    for (const path of ['/export', '/totp/begin', '/providers/example/link', '/passkeys/register/options'])
        assert.equal((await call(path, {})).status, 403);
    assert.equal((await call('/send-verification', {})).status, 200);
    assert.equal(hosted.sent.length, 1);
    assert.equal((await call('/verify', { token: linkIn(lastSent(hosted.sent, 'auth.verify-email')).searchParams.get('token')! })).status, 200);
    assert.equal(await service.authenticate(token), null);
    assert.ok(!cookies.has('__Host-urlcode-session'));
    await call('/csrf');
    assert.equal((await call('/login', { email: 'owner@example.test', password: 'correct horse battery staple' })).status, 200);
    assert.deepEqual((await service.authenticate(token))?.restrictions, ['enroll-mfa']);
    assert.equal((await instance.authorize!({}, request('/private')))?.status, 403);
    now += 6 * 60 * 1000;
    assert.notEqual((await call('/totp/begin', {})).status, 200);
    assert.equal((await call('/step-up', { password: 'correct horse battery staple' })).status, 200);
    assert.deepEqual((await service.authenticate(token))?.restrictions, ['enroll-mfa']);
    const enrollment = await call('/totp/begin', {});
    assert.equal(enrollment.status, 200);
    const secret = JSON.parse(Buffer.from(enrollment.body ?? '').toString()).secret as string;
    const code = new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 }).generate({ timestamp: now });
    const confirmed = await call('/totp/confirm', { code });
    assert.equal(confirmed.status, 200);
    assert.ok(JSON.parse(Buffer.from(confirmed.body ?? '').toString()).recoveryCodes.length);
    const unrestricted = await service.authenticate(token);
    assert.equal(unrestricted?.restrictions, undefined);
    assert.equal(hasPermission(unrestricted!, 'auth.users.manage'), true);
    assert.equal(await instance.authorize!({}, request('/private')), undefined);
});
