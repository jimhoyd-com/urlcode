import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuthService, sessionReference } from '../src/auth-core.ts';
import { authExtension } from '../src/auth.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { activatedUi } from './support/render.ts';
test('authorize() gates a bearer/API-key route: 401 missing/invalid/expired/revoked, 403 insufficient scope, allow with matching scopes', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-bearer-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', now: () => now });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui }).activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const request = (authorization?: string) => ({ method: 'GET', target: '/api/items', path: '/api/items', query: new URLSearchParams(), headers: new Headers(authorization !== undefined ? { authorization } : {}), headerCounts: {}, body: new Uint8Array(), origin, route: '/api/items', mount: null, client: null });
    const requirement = { bearer: { scopes: ['items.read'] } };
    const missing = await instance.authorize!(requirement, request());
    assert.equal(missing?.status, 401);
    assert.equal(Object.fromEntries(missing!.headers)['www-authenticate'], 'Bearer');
    const malformed = await instance.authorize!(requirement, request('Basic dXNlcjpwYXNz'));
    assert.equal(malformed?.status, 401);
    const unknown = await instance.authorize!(requirement, request('Bearer uak_' + '0'.repeat(36) + '.' + 'x'.repeat(43)));
    assert.equal(unknown?.status, 401);
    assert.match(Object.fromEntries(unknown!.headers)['www-authenticate']!, /error="invalid_token"/);
    const issued = await service.issueApiKey({ name: 'agent', scopes: ['items.read'] });
    // Every denied case above must never write the reserved context header:
    // a bearer request that never verifies must not leak a principal.
    for (const denied of [request(), request('Basic dXNlcjpwYXNz'), request('Bearer uak_' + '0'.repeat(36) + '.' + 'x'.repeat(43))]) { await instance.authorize!(requirement, denied); assert.equal(denied.headers.get('x-urlcode-context-auth-principal'), null); }
    const allowedRequest = request('Bearer ' + issued.key);
    const allowed = await instance.authorize!(requirement, allowedRequest);
    assert.equal(allowed, undefined);
    // On success, the verified principal (id/name/scopes, never the raw key)
    // is written into the reserved x-urlcode-context-* namespace a route's
    // own function/middleware reads (urlcode#618).
    assert.deepEqual(JSON.parse(Buffer.from(allowedRequest.headers.get('x-urlcode-context-auth-principal')!, 'base64').toString()), { id: issued.id, name: 'agent', scopes: ['items.read'] });
    assert.ok(!Buffer.from(allowedRequest.headers.get('x-urlcode-context-auth-principal')!, 'base64').toString().includes(issued.key));
    const underScoped = await service.issueApiKey({ name: 'writer-only', scopes: ['items.write'] });
    const forbiddenRequest = request('Bearer ' + underScoped.key);
    const forbidden = await instance.authorize!(requirement, forbiddenRequest);
    assert.equal(forbiddenRequest.headers.get('x-urlcode-context-auth-principal'), null);
    assert.equal(forbidden?.status, 403);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(forbidden!.body as Uint8Array)), { error: 'insufficient_scope', requiredScopes: ['items.read'] });
    assert.match(Object.fromEntries(forbidden!.headers)['www-authenticate']!, /error="insufficient_scope", scope="items\.read"/);
    await service.revokeApiKey(issued.id);
    const revoked = await instance.authorize!(requirement, request('Bearer ' + issued.key));
    assert.equal(revoked?.status, 401);
    const expiring = await service.issueApiKey({ name: 'short-lived', scopes: ['items.read'], expiresInMs: 60000 });
    assert.equal(await instance.authorize!(requirement, request('Bearer ' + expiring.key)), undefined);
    now += 120000;
    const expired = await instance.authorize!(requirement, request('Bearer ' + expiring.key));
    assert.equal(expired?.status, 401);
});
test('email change sends old-address cancellation first and rolls back on failed delivery', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-handler-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', now: () => now });
    cleanup(t, () => service.close());
    const user = await service.register({ email: 'old@example.test', password: 'correct horse battery staple' }), csrfKey = randomBytes(32), origin = 'https://example.test', http = new AuthHttp({ csrfKey, origin }), projectSha256 = 'a'.repeat(64);
    let fail = true;
    const delivered: {
        email: string;
        purpose: string;
        token: string;
    }[] = [];
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui, sendToken: async (message) => {
            delivered.push(message);
            if (fail)
                throw new Error('synthetic sender failure');
        } }).activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    async function post(path: string, data: Record<string, string>) { return instance.handle({ method: 'POST', target: '/account' + path, path: '/account' + path, query: new URLSearchParams(), headers: new Headers({ cookie: '__Host-urlcode-session=' + user.token, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(JSON.stringify({ ...data, csrf: http.token(user.token) })), origin, route: '/account/*', mount: '/account', client: null }); }
    assert.equal((await post('/change-email', { email: 'new@example.test', password: 'correct horse battery staple' })).status, 503);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.email, 'old@example.test');
    assert.equal((await service.getUser(user.user.id))?.email, 'old@example.test');
    fail = false;
    delivered.length = 0;
    assert.equal((await post('/change-email', { email: 'new@example.test', password: 'correct horse battery staple' })).status, 200);
    assert.deepEqual(delivered.map(value => value.purpose), ['cancel-email-change', 'verify-email-change']);
    const token = delivered[1]!.token;
    assert.notEqual((await post('/verify-email-change', { token })).status, 200);
    now += 24 * 60 * 60 * 1000 + 1;
    assert.equal((await post('/verify-email-change', { token })).status, 200);
    assert.equal((await service.getUser(user.user.id))?.email, 'new@example.test');
    assert.equal(await service.authenticate(user.token), null);
});
test('new-device notices follow a stable HttpOnly device cookie and do not repeat on recognized sign-in', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-device-handler-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    await service.register({ email: 'device@example.test', password: 'correct horse battery staple' });
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64), notices: string[] = [];
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui, sendNotice: async (message) => { notices.push(message.event); } }).activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const cookies = new Map<string, string>();
    async function call(path: string, data?: Record<string, string>) {
        const response = await instance.handle({ method: data ? 'POST' : 'GET', target: '/account' + path, path: '/account' + path, query: new URLSearchParams(), headers: new Headers({ cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), origin, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Synthetic test browser' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: null });
        for (const [name, value] of response.headers || [])
            if (name === 'set-cookie') {
                const [key, content] = value.split(';')[0]!.split('=');
                if (value.includes('Max-Age=0'))
                    cookies.delete(key!);
                else
                    cookies.set(key!, content!);
            }
        return { response, data: JSON.parse(new TextDecoder().decode(response.body as Uint8Array)) as {
                csrf: string;
            } };
    }
    let prepared = await call('/csrf');
    assert.ok(cookies.has('__Host-urlcode-device'));
    const first = await call('/login', { email: 'device@example.test', password: 'correct horse battery staple', csrf: prepared.data.csrf });
    assert.equal(first.response.status, 200);
    assert.deepEqual(notices, ['new-device']);
    await call('/logout', { csrf: first.data.csrf });
    prepared = await call('/csrf');
    const second = await call('/login', { email: 'device@example.test', password: 'correct horse battery staple', csrf: prepared.data.csrf });
    assert.equal(second.response.status, 200);
    assert.deepEqual(notices, ['new-device']);
});
test('waitlist registration replies without waiting for the duplicate-address notice (#548)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-waitlist-notice-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', registrationMode: 'waitlist' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64), notices: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    cleanup(t, () => release());
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui, sendNotice: async (message) => { notices.push(message.event); await held; } }).activate({ registration: 'waitlist' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const cookies = new Map<string, string>();
    async function call(path: string, data?: Record<string, string>) {
        const response = await instance.handle({ method: data ? 'POST' : 'GET', target: '/account' + path, path: '/account' + path, query: new URLSearchParams(), headers: new Headers({ cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: null });
        for (const [name, value] of response.headers || [])
            if (name === 'set-cookie' && !value.includes('Max-Age=0')) {
                const [key, content] = value.split(';')[0]!.split('=');
                cookies.set(key!, content!);
            }
        return { response, data: JSON.parse(new TextDecoder().decode(response.body as Uint8Array)) as { csrf: string } };
    }
    const password = 'correct horse battery staple';
    let csrf = (await call('/csrf')).data.csrf;
    assert.equal((await call('/register', { email: 'held@example.test', password, csrf })).response.status, 202);
    assert.deepEqual(notices, []);
    csrf = (await call('/csrf')).data.csrf;
    // The duplicate gets the same reply while its notice is still undelivered (awaiting it
    // would hold the reply until the 5 s notice timeout).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = await Promise.race([call('/register', { email: 'held@example.test', password, csrf }), new Promise<'held'>(resolve => { timer = setTimeout(() => resolve('held'), 2500); })]);
    clearTimeout(timer);
    assert.notEqual(reply, 'held');
    assert.equal(reply !== 'held' && reply.response.status, 202);
    assert.deepEqual(notices, ['registration-attempt']);
});
test('pending OIDC sign-in retains its original proof and fails after identity unlink', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-proof-handler-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const { createHash } = await import('node:crypto');
    const issuer = 'https://issuer.test', providerId = 'oidc-' + createHash('sha256').update(issuer).digest('hex').slice(0, 56);
    const user = await service.register({ email: 'proof@example.test', password: 'correct horse battery staple' });
    await service.linkExternal({ sessionReference: sessionReference(user.token),  provider: providerId, subject: 'subject' });
    // Force the UI's second-factor continuation while retaining the real service's
    // proof/version checks. The final service state has no factor, reproducing a
    // factor reset between primary proof and final issuance without a clock race.
    const flowService = new Proxy(service, { get(target, key) {
            if (key === 'getExternalProof')
                return async (provider: string, subject: string) => { const result = await target.getExternalProof(provider, subject); return result ? { ...result, user: { ...result.user, totpEnabled: true } } : null; };
            return Reflect.get(target, key);
        } });
    const provider = { async start() { const state = randomBytes(32).toString('base64url'); return { url: 'https://issuer.test/authorize?state=' + state, flow: { state, nonce: state, verifier: state } }; }, async complete() { return { issuer, subject: 'subject', email: user.user.email, emailVerified: true }; } };
    const origin = 'https://example.test', projectSha256 = 'a'.repeat(64), cookies = new Map<string, string>();
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await authExtension({ service: flowService, csrfKey: randomBytes(32), projectSha256, ui, providers: { example: provider } }).activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    async function call(path: string, data?: Record<string, string>) {
        const url = new URL(path, origin), response = await instance.handle({ method: data ? 'POST' : 'GET', target: path, path: url.pathname, query: url.searchParams, headers: new Headers({ cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: null });
        for (const [name, value] of response.headers || [])
            if (name === 'set-cookie') {
                const [key, content] = value.split(';')[0]!.split('=');
                if (value.includes('Max-Age=0'))
                    cookies.delete(key!);
                else
                    cookies.set(key!, content!);
            }
        return response;
    }
    const csrf = JSON.parse(new TextDecoder().decode((await call('/account/csrf')).body as Uint8Array)).csrf as string;
    const started = await call('/account/providers/example/start', { csrf }), state = new URL(started.headers.find(([name]) => name === 'location')![1]).searchParams.get('state');
    const pending = await call('/account/providers/example/callback?state=' + state), html = new TextDecoder().decode(pending.body as Uint8Array);
    assert.match(html, /Confirm second factor/);
    const flowId = html.match(/name="flowId" value="([^"]+)"/)![1]!, pendingCsrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
    await service.unlinkExternal({ token: user.token, provider: providerId, subject: 'subject' });
    const completed = await call('/account/providers/complete', { csrf: pendingCsrf, flowId });
    assert.notEqual(completed.status, 200);
    assert.ok(!cookies.has('__Host-urlcode-session'));
});
