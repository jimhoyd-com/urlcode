import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { validateProject } from '@jimhoyd/urlcode';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuthService, sessionReference } from '../src/auth-core.ts';
import { authConfigSchema, authPolicySchema } from '../src/auth.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { activatedUi, bodyText } from './support/render.ts';
import { authFor, lastSent } from './support/companions.ts';
import type { MailEnvelope } from '@jimhoyd/urlcode-mail';
test('authorize() gates a bearer/API-key route: 401 missing/invalid/expired/revoked, 403 insufficient scope, allow with matching scopes', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-bearer-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', now: () => now });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await (await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin)).registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const request = (authorization?: string) => ({ method: 'GET', target: '/api/items', path: '/api/items', query: new URLSearchParams(), headers: new Headers(authorization !== undefined ? { authorization } : {}), headerCounts: {}, body: new Uint8Array(), origin, route: '/api/items', mount: null, client: null, requestId: 'test-request', env: {} });
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
    assert.deepEqual(JSON.parse(bodyText(forbidden!.body)), { error: 'insufficient_scope', requiredScopes: ['items.read'] });
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
test('authorize() enforces a bearer quota per credential: 429 with Retry-After and RateLimit fields before the handler, window reset', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-quota-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', now: () => now });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await (await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin)).registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const request = (authorization: string) => ({ method: 'GET', target: '/api/items', path: '/api/items', query: new URLSearchParams(), headers: new Headers({ authorization }), headerCounts: {}, body: new Uint8Array(), origin, route: '/api/items', mount: null, client: '203.0.113.9', requestId: 'test-request', env: {} });
    const requirement = { bearer: { scopes: ['items.read'], quota: { requests: 2, window: 60 } } };
    const first = await service.issueApiKey({ name: 'first', scopes: ['items.read'] }), second = await service.issueApiKey({ name: 'second', scopes: ['items.read'] });
    const underScoped = await service.issueApiKey({ name: 'writer-only', scopes: ['items.write'] });
    // An insufficient-scope request is refused as 403 and never counted against the quota.
    for (let i = 0; i < 3; i++) assert.equal((await instance.authorize!(requirement, request('Bearer ' + underScoped.key)))?.status, 403);
    // Under quota: allowed, principal exposed as before.
    for (let i = 0; i < 2; i++) {
        const allowed = request('Bearer ' + first.key);
        assert.equal(await instance.authorize!(requirement, allowed), undefined);
        assert.ok(allowed.headers.get('x-urlcode-context-auth-principal'));
    }
    // Over quota: 429 before the handler, with Retry-After and the RateLimit fields core throttle uses.
    now += 15000;
    const refusedRequest = request('Bearer ' + first.key), refused = await instance.authorize!(requirement, refusedRequest);
    assert.equal(refused?.status, 429);
    const headers = Object.fromEntries(refused!.headers);
    assert.equal(headers['retry-after'], '45');
    assert.equal(headers['ratelimit-policy'], '"credential";q=2;w=60');
    assert.equal(headers['ratelimit'], '"credential";r=0;t=45');
    assert.equal(headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(bodyText(refused!.body)), { error: 'credential_quota_exceeded' });
    assert.equal(refusedRequest.headers.get('x-urlcode-context-auth-principal'), null);
    // The raw key never appears in the refusal.
    assert.ok(!JSON.stringify(refused!.headers).includes(first.key) && !bodyText(refused!.body).includes(first.key));
    // A separate credential has its own budget, even from the same client address.
    assert.equal(await instance.authorize!(requirement, request('Bearer ' + second.key)), undefined);
    // A route declaring a different budget counts separately.
    assert.equal(await instance.authorize!({ bearer: { scopes: ['items.read'], quota: { requests: 5, window: 60 } } }, request('Bearer ' + first.key)), undefined);
    // A route with no quota is not limited by the credential's other budgets.
    assert.equal(await instance.authorize!({ bearer: { scopes: ['items.read'] } }, request('Bearer ' + first.key)), undefined);
    // The window resets.
    now += 45000;
    assert.equal(await instance.authorize!(requirement, request('Bearer ' + first.key)), undefined);
});
test('a key issued with its own quota is counted against it instead of the route quota; a key without one uses the route quota (urlcode#703)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-key-quota-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', now: () => now });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await (await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin)).registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const request = (authorization: string, route = '/api/items') => ({ method: 'GET', target: route, path: route, query: new URLSearchParams(), headers: new Headers({ authorization }), headerCounts: {}, body: new Uint8Array(), origin, route, mount: null, client: '203.0.113.9', requestId: 'test-request', env: {} });
    const routeQuota = { bearer: { scopes: ['items.read'], quota: { requests: 2, window: 60 } } };
    const gold = await service.issueApiKey({ name: 'gold', scopes: ['items.read'], quota: { requests: 4, window: 120 } });
    const tiny = await service.issueApiKey({ name: 'tiny', scopes: ['items.read'], quota: { requests: 1, window: 30 } });
    const plain = await service.issueApiKey({ name: 'plain', scopes: ['items.read'] });
    // The route's budget (2) applies to a key without its own.
    for (let i = 0; i < 2; i++) assert.equal(await instance.authorize!(routeQuota, request('Bearer ' + plain.key)), undefined);
    const plainRefused = await instance.authorize!(routeQuota, request('Bearer ' + plain.key));
    assert.equal(plainRefused?.status, 429);
    assert.equal(Object.fromEntries(plainRefused!.headers)['ratelimit-policy'], '"credential";q=2;w=60');
    // The key's own, larger budget replaces the route's: four requests pass where the route allows two.
    for (let i = 0; i < 4; i++) assert.equal(await instance.authorize!(routeQuota, request('Bearer ' + gold.key)), undefined);
    const goldRefused = await instance.authorize!(routeQuota, request('Bearer ' + gold.key));
    assert.equal(goldRefused?.status, 429);
    const goldHeaders = Object.fromEntries(goldRefused!.headers);
    assert.equal(goldHeaders['ratelimit-policy'], '"credential";q=4;w=120');
    assert.equal(goldHeaders['ratelimit'], '"credential";r=0;t=120');
    assert.equal(goldHeaders['retry-after'], '120');
    // A smaller own budget also replaces the route's, rather than adding to it.
    assert.equal(await instance.authorize!(routeQuota, request('Bearer ' + tiny.key)), undefined);
    assert.equal((await instance.authorize!(routeQuota, request('Bearer ' + tiny.key)))?.status, 429);
    // The key's budget is one per key: it applies, and is shared, on another bearer route,
    // including one that declares no quota of its own.
    assert.equal((await instance.authorize!({ bearer: { scopes: ['items.read'] } }, request('Bearer ' + gold.key, '/api/other')))?.status, 429);
    // A key without its own quota stays unlimited on a route without one.
    assert.equal(await instance.authorize!({ bearer: { scopes: ['items.read'] } }, request('Bearer ' + plain.key, '/api/other')), undefined);
    now += 120000;
    assert.equal(await instance.authorize!(routeQuota, request('Bearer ' + gold.key)), undefined);
});
test('middleware() adds the credential RateLimit fields to an allowed bearer response, ahead of other producers\' members', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-quota-middleware-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const now = Date.now();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', now: () => now });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await (await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin)).registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const request = (authorization?: string) => ({ method: 'GET', target: '/api/items', path: '/api/items', query: new URLSearchParams(), headers: new Headers(authorization ? { authorization } : {}), headerCounts: {}, body: new Uint8Array(), origin, route: '/api/items', mount: null, client: '203.0.113.9', requestId: 'test-request', env: {} });
    const requirement = { bearer: { scopes: ['items.read'], quota: { requests: 3, window: 60 } } };
    const { key } = await service.issueApiKey({ name: 'items', scopes: ['items.read'] });
    const downstream = (headers: [string, string][]) => async () => ({ status: 200, headers, body: Buffer.from('ok') });
    // Allowed and counted: the response carries this credential's remaining budget.
    const first = request('Bearer ' + key);
    assert.equal(await instance.authorize!(requirement, first), undefined);
    const wrapped = await instance.middleware!(requirement, first, downstream([['content-type', 'text/plain']]));
    assert.deepEqual(wrapped.headers, [['content-type', 'text/plain'], ['ratelimit-policy', '"credential";q=3;w=60'], ['ratelimit', '"credential";r=2;t=60']]);
    // Another producer's members (core throttle's "default") are kept, split field lines are
    // folded, and a stale "credential" member is replaced rather than repeated.
    const second = request('Bearer ' + key);
    assert.equal(await instance.authorize!(requirement, second), undefined);
    const merged = await instance.middleware!(requirement, second, downstream([['ratelimit-policy', '"default";q=60;w=60'], ['RateLimit', '"credential";r=9;t=9, "default";r=58;t=31'], ['ratelimit', '"other";r=1;t=2']]));
    assert.deepEqual(merged.headers, [['ratelimit-policy', '"credential";q=3;w=60, "default";q=60;w=60'], ['ratelimit', '"credential";r=1;t=60, "default";r=58;t=31, "other";r=1;t=2']]);
    // A request that authorize() did not count (no quota, or not a bearer route) passes through untouched.
    const unmetered = request('Bearer ' + key);
    assert.equal(await instance.authorize!({ bearer: { scopes: ['items.read'] } }, unmetered), undefined);
    assert.deepEqual((await instance.middleware!({ bearer: { scopes: ['items.read'] } }, unmetered, downstream([['x-a', 'b']]))).headers, [['x-a', 'b']]);
    assert.deepEqual((await instance.middleware!({ role: 'member' }, request(), downstream([['x-a', 'b']]))).headers, [['x-a', 'b']]);
});
test('bearer quota configuration is validated with path-named errors', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-quota-schema-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const validateAuth = async (auth: unknown) => {
        await writeFile(join(root, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: { registration: 'off' } } }, routes: { '/account/*': { extension: 'auth' }, '/api/items': { redirect: { url: 'https://example.test/' }, auth } } }));
        // The registration only supplies its policy schema here; validation never activates it.
        return validateProject(root, { extensions: [{ name: 'auth', version: '1', projectSha256: 'a'.repeat(64), targets: ['node'], schema: authConfigSchema, policySchema: authPolicySchema, activate() { throw new Error('not activated'); } }] }).then(report => report.valid, (error: Error & { details?: unknown }) => `${error.message} ${JSON.stringify(error.details)}`);
    };
    const validate = (quota: unknown) => validateAuth({ bearer: { scopes: ['items.read'], quota } });
    assert.equal(await validate({ requests: 100, window: 60 }), true);
    // Core no longer knows the auth vocabulary; an unknown key under `auth:` is refused by this package's schema.
    assert.equal(await validateAuth({ roles: ['admin'] }), 'Invalid extension policy at route /api/items, auth (additionalProperties): unknown key "roles"; did you mean "role"? (run urlcode extensions --json for its policy schema) {"pointer":"/routes/~1api~1items/auth","route":"/api/items","code":"unknown-key","key":"roles"}');
    assert.equal(await validateAuth({ role: 'member', freshWithinSeconds: 60 }), true);
    // The auth extension's own policy schema judges the `auth:` short form (urlcode#710), and the refusal names the
    // nested quota field at the `auth` key the author wrote, not the union's `const: true` branch (urlcode#702).
    for (const quota of [{ requests: 0, window: 60 }, { requests: 10, window: 'a minute' }, { requests: 10, window: 2592001 }, { requests: 1000001, window: 60 }, { requests: 10 }, { requests: 10, window: 60, burst: 5 }]) {
        const refused = await validate(quota);
        assert.equal(typeof refused, 'string', JSON.stringify(quota));
        assert.ok((refused as string).startsWith('Invalid extension policy at route /api/items, auth.bearer.quota') && (refused as string).includes('"pointer":"/routes/~1api~1items/auth/bearer/quota'), `${JSON.stringify(quota)}: ${refused}`);
    }
});
test('email change sends old-address cancellation first and rolls back on failed delivery', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-handler-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    let now = Date.now();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member', now: () => now });
    cleanup(t, () => service.close());
    const user = await service.register({ email: 'old@example.test', password: 'correct horse battery staple' }), csrfKey = randomBytes(32), origin = 'https://example.test', http = new AuthHttp({ csrfKey, origin }), projectSha256 = 'a'.repeat(64);
    let fail = true;
    const delivered: MailEnvelope[] = [];
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const instance = await (await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin, { transport: { kind: 'failing', development: true, async deliver(envelope) {
            delivered.push(envelope);
            if (fail)
                throw new Error('synthetic sender failure');
        } } })).registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    async function post(path: string, data: Record<string, string>) { return instance.handle({ method: 'POST', target: '/account' + path, path: '/account' + path, query: new URLSearchParams(), headers: new Headers({ cookie: '__Host-urlcode-session=' + user.token, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(JSON.stringify({ ...data, csrf: http.token(user.token) })), origin, route: '/account/*', mount: '/account', client: null, requestId: 'test-request', env: {} }); }
    assert.equal((await post('/change-email', { email: 'new@example.test', password: 'correct horse battery staple' })).status, 503);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.to, 'old@example.test');
    assert.equal((await service.getUser(user.user.id))?.email, 'old@example.test');
    fail = false;
    delivered.length = 0;
    assert.equal((await post('/change-email', { email: 'new@example.test', password: 'correct horse battery staple' })).status, 200);
    assert.deepEqual(delivered.map(value => value.template), ['auth.cancel-email-change', 'auth.verify-email-change']);
    const token = new URL(/https:\/\/\S+/.exec(delivered[1]!.text)![0]).searchParams.get('token')!;
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
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const hosted = await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin), notices = () => hosted.sent.map(envelope => envelope.template);
    const instance = await hosted.registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const cookies = new Map<string, string>();
    async function call(path: string, data?: Record<string, string>) {
        const response = await instance.handle({ method: data ? 'POST' : 'GET', target: '/account' + path, path: '/account' + path, query: new URLSearchParams(), headers: new Headers({ cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), origin, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Synthetic test browser' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: null, requestId: 'test-request', env: {} });
        for (const [name, value] of response.headers || [])
            if (name === 'set-cookie') {
                const [key, content] = value.split(';')[0]!.split('=');
                if (value.includes('Max-Age=0'))
                    cookies.delete(key!);
                else
                    cookies.set(key!, content!);
            }
        return { response, data: JSON.parse(bodyText(response.body)) as {
                csrf: string;
            } };
    }
    let prepared = await call('/csrf');
    assert.ok(cookies.has('__Host-urlcode-device'));
    const first = await call('/login', { email: 'device@example.test', password: 'correct horse battery staple', csrf: prepared.data.csrf });
    assert.equal(first.response.status, 200);
    assert.deepEqual(notices(), ['auth.new-device']);
    assert.equal(lastSent(hosted.sent, 'auth.new-device').text.includes('https://example.test/account/account'), true);
    await call('/logout', { csrf: first.data.csrf });
    prepared = await call('/csrf');
    const second = await call('/login', { email: 'device@example.test', password: 'correct horse battery staple', csrf: prepared.data.csrf });
    assert.equal(second.response.status, 200);
    assert.deepEqual(notices(), ['auth.new-device']);
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
    const instance = await (await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin, { transport: { kind: 'held', development: true, async deliver(envelope) { notices.push(envelope.template.slice('auth.'.length)); await held; } } })).registration.activate({ registration: 'waitlist' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const cookies = new Map<string, string>();
    async function call(path: string, data?: Record<string, string>) {
        const response = await instance.handle({ method: data ? 'POST' : 'GET', target: '/account' + path, path: '/account' + path, query: new URLSearchParams(), headers: new Headers({ cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: null, requestId: 'test-request', env: {} });
        for (const [name, value] of response.headers || [])
            if (name === 'set-cookie' && !value.includes('Max-Age=0')) {
                const [key, content] = value.split(';')[0]!.split('=');
                cookies.set(key!, content!);
            }
        return { response, data: JSON.parse(bodyText(response.body)) as { csrf: string } };
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
    const instance = await (await authFor(t, root, { service: flowService, csrfKey: randomBytes(32), projectSha256, ui, providers: { example: provider } }, origin)).registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    async function call(path: string, data?: Record<string, string>) {
        const url = new URL(path, origin), response = await instance.handle({ method: data ? 'POST' : 'GET', target: path, path: url.pathname, query: url.searchParams, headers: new Headers({ cookie: [...cookies].map(([key, value]) => key + '=' + value).join('; '), origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(data ? JSON.stringify(data) : ''), origin, route: '/account/*', mount: '/account', client: null, requestId: 'test-request', env: {} });
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
    const csrf = JSON.parse(bodyText((await call('/account/csrf')).body)).csrf as string;
    const started = await call('/account/providers/example/start', { csrf }), state = new URL(started.headers.find(([name]) => name === 'location')![1]).searchParams.get('state');
    const pending = await call('/account/providers/example/callback?state=' + state), html = bodyText(pending.body);
    assert.match(html, /Confirm second factor/);
    const flowId = html.match(/name="flowId" value="([^"]+)"/)![1]!, pendingCsrf = html.match(/name="csrf" value="([^"]+)"/)![1]!;
    await service.unlinkExternal({ token: user.token, provider: providerId, subject: 'subject' });
    const completed = await call('/account/providers/complete', { csrf: pendingCsrf, flowId });
    assert.notEqual(completed.status, 200);
    assert.ok(!cookies.has('__Host-urlcode-session'));
});
