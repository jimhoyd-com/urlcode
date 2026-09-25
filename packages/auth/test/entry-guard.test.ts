// Auth's entry guard with a real abuse extension: extensions.auth.config.abuse budgets, challenge escalation and the
// password backoff, all counted in abuse's pseudonymous store.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AbuseChallengeProvider } from '@jimhoyd/urlcode-abuse';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import { createAuthService } from '../src/auth-core.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { authFor, companions, withCompanions } from './support/companions.ts';
import { activatedUi, bodyText } from './support/render.ts';

const origin = 'https://site.example', projectSha256 = 'a'.repeat(64), password = 'correct horse battery staple';
const turnstileOrigin = 'https://challenges.cloudflare.com';
/** A challenge provider whose token 'valid' passes, with the Turnstile widget shape. */
function provider(calls: { token: string; client: string; action: string }[]): AbuseChallengeProvider {
    return {
        widget: action => ({ markup: `<div class="cf-turnstile" data-sitekey="site-key" data-action="${action}" data-response-field-name="challengeToken"></div>`, csp: { script: [turnstileOrigin], frame: [turnstileOrigin], connect: [turnstileOrigin] }, scripts: [{ src: turnstileOrigin + '/turnstile/v0/api.js', async: true }] }),
        async verify(input) { calls.push({ token: input.token, client: input.client, action: input.action }); return input.token === 'valid'; },
    };
}
async function setup(t: TestContext, config: Record<string, unknown>, challenge?: AbuseChallengeProvider) {
    const root = await mkdtemp(join(tmpdir(), 'auth-entry-guard-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = 1800000000000;
    const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', registrationMode: 'open' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), http = new AuthHttp({ origin, csrfKey }), binding = randomBytes(32).toString('base64url');
    const ui = await activatedUi(t, root, projectSha256, origin);
    const hosted = await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin, { abuse: { ...(challenge ? { challenge } : {}), now: () => now } });
    const instance = await hosted.registration.activate({ registration: 'open', abuse: config }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
    cleanup(t, () => instance.close?.());
    const request = (path: string, data: Record<string, string>, { client = '192.0.2.1', html = false, session }: { client?: string | null; html?: boolean; session?: string } = {}): ExtensionRequest => {
        const headers = new Headers({ 'content-type': 'application/json', origin, cookie: session ? '__Host-urlcode-session=' + session : '__Host-urlcode-flow=' + binding, accept: html ? 'text/html' : 'application/json' });
        return { method: 'POST', path: '/account' + path, target: '/account' + path, query: new URLSearchParams(), headers, headerCounts: Object.fromEntries([...headers].map(([key]) => [key, 1])), body: new TextEncoder().encode(JSON.stringify({ ...data, csrf: http.token(session ?? binding) })), origin, mount: '/account', route: '/account/*', client, requestId: 'guard', env: {} };
    };
    return { service, instance, request, advance: (ms: number) => { now += ms; } };
}

test('client budgets answer 429 with Retry-After, escalate to a challenge and never let a challenge pass a spent budget', async (t) => {
    const calls: { token: string; client: string; action: string }[] = [];
    const { instance, request } = await setup(t, { client: { limit: 3, windowMs: 60000 }, challengeAfter: 1 }, provider(calls));
    const login = (token?: string, options = {}) => instance.handle(request('/login', { email: 'nobody@example.test', password, ...(token ? { challengeToken: token } : {}) }, options));
    assert.equal((await login()).status, 401);
    const challenged = await login();
    assert.equal(challenged.status, 403);
    assert.deepEqual(JSON.parse(bodyText(challenged.body)), { error: 'Challenge required. Return to the form and try again.', challengeRequired: true });
    assert.equal((await login('valid')).status, 401);
    assert.deepEqual(calls, [{ token: 'valid', client: '192.0.2.1', action: 'auth' }]);
    const limited = await login('valid');
    assert.equal(limited.status, 429);
    assert.ok(Number(Object.fromEntries(limited.headers)['retry-after']) > 0);
    assert.equal(calls.length, 1, 'a spent budget refuses before any challenge is verified');
    // The HTML answer to a required challenge is the status screen, not JSON.
    const { instance: fresh, request: freshRequest } = await setup(t, { client: { limit: 3, windowMs: 60000 }, challengeAfter: 1 }, provider([]));
    await fresh.handle(freshRequest('/login', { email: 'nobody@example.test', password }));
    const screen = await fresh.handle(freshRequest('/login', { email: 'nobody@example.test', password }, { html: true }));
    assert.equal(screen.status, 403);
    assert.match(bodyText(screen.body), /Challenge required/);
    // Callbacks and token redemption are not entry requests.
    assert.notEqual((await instance.handle(request('/reset', { token: 'x'.repeat(43), password }))).status, 429);
});

test('a client budget without a trusted client address answers 503 trusted_client_required; the honeypot answers 202', async (t) => {
    const { service, instance, request } = await setup(t, { client: { limit: 10, windowMs: 60000 } });
    const missing = await instance.handle(request('/login', { email: 'nobody@example.test', password }, { client: null }));
    assert.equal(missing.status, 503);
    const trap = await instance.handle(request('/register', { email: 'bot@example.test', password, website: 'https://spam.example' }));
    assert.equal(trap.status, 202);
    assert.equal((await service.listUsers()).users.length, 0);
});

test('signup budgets count per client and per email domain', async (t) => {
    const { instance, request } = await setup(t, { signupClient: { limit: 5, windowMs: 60000 }, signupDomain: { limit: 1, windowMs: 60000 } });
    assert.equal((await instance.handle(request('/register', { email: 'first@corp.example', password }, { client: '192.0.2.10' }))).status, 201);
    assert.equal((await instance.handle(request('/register', { email: 'second@corp.example', password }, { client: '192.0.2.11' }))).status, 429);
    assert.equal((await instance.handle(request('/register', { email: 'third@other.example', password }, { client: '192.0.2.11' }))).status, 201);
});

test('password backoff blocks a failing address, and a success or a reset clears it', async (t) => {
    const { service, instance, request, advance } = await setup(t, { passwordBackoff: { threshold: 1, initialDelayMs: 60000, maxDelayMs: 60000, resetAfterMs: 600000 } });
    const user = await service.register({ email: 'owner@example.test', password });
    const login = (secret: string) => instance.handle(request('/login', { email: 'owner@example.test', password: secret }));
    assert.equal((await login('wrong password guess one')).status, 401);
    const blocked = await login(password);
    assert.equal(blocked.status, 429, 'blocked before the password is checked');
    assert.ok(Number(Object.fromEntries(blocked.headers)['retry-after']) > 0);
    advance(61000);
    assert.equal((await login(password)).status, 200);
    // Cleared on success: one more failure starts over at the threshold instead of doubling.
    assert.equal((await login('wrong password guess two')).status, 401);
    assert.equal((await login(password)).status, 429);
    const reset = (await service.issueToken({ email: user.user.email, purpose: 'reset-password' })).token!;
    assert.equal((await instance.handle(request('/reset', { token: reset, password: 'a replacement passphrase now' }))).status, 200);
    assert.equal((await login('a replacement passphrase now')).status, 200, 'a reset clears the backoff');
});

test('activation refuses abuse budgets without the abuse extension and a challenge threshold without a verifier', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'auth-entry-guard-refusal-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', registrationMode: 'open' });
    cleanup(t, () => service.close());
    const ui = await activatedUi(t, root, projectSha256, origin), context = { origin, target: 'node' as const, projectSha256, mounts: ['/account'], root };
    const withoutAbuse = withCompanions(await companions(t, root, projectSha256, origin));
    await assert.rejects(Promise.resolve(withoutAbuse({ service, csrfKey: randomBytes(32), projectSha256, ui }).activate({ registration: 'open', abuse: { client: { limit: 5, windowMs: 60000 } } }, context)), /needs the abuse extension/);
    const withAbuse = withCompanions(await companions(t, root, projectSha256, origin, { abuse: true }));
    await assert.rejects(Promise.resolve(withAbuse({ service, csrfKey: randomBytes(32), projectSha256, ui }).activate({ registration: 'open', abuse: { client: { limit: 5, windowMs: 60000 }, challengeAfter: 2 } }, context)), /Challenge policy requires an operator verifier/);
    // No abuse config: abuse is optional, and auth activates without it.
    const instance = await withoutAbuse({ service, csrfKey: randomBytes(32), projectSha256, ui }).activate({ registration: 'open' }, context);
    await instance.close?.();
});

test('entry pages render the challenge widget in their POST forms with its script and CSP', async (t) => {
    const { instance } = await setup(t, { client: { limit: 5, windowMs: 60000 }, challengeAfter: 1 }, provider([]));
    const page = await instance.handle({ method: 'GET', path: '/account/login', target: '/account/login', query: new URLSearchParams(), headers: new Headers({ accept: 'text/html' }), headerCounts: {}, body: new Uint8Array(), origin, mount: '/account', route: '/account/*', client: '192.0.2.1', requestId: 'page', env: {} });
    const html = bodyText(page.body), csp = Object.fromEntries(page.headers)['content-security-policy']!;
    assert.match(html, /<form[^>]*method="post"[^>]*><div class="cf-turnstile"/);
    assert.match(html, /<script nonce="[^"]+" src="https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js" async><\/script>/);
    assert.match(csp, /script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-src[^;]*https:\/\/challenges\.cloudflare\.com/);
});
