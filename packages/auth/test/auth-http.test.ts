import { cleanup } from './cleanup.ts';
import { TOTP } from 'otpauth';
import { createRegistrationPolicy } from '../src/registration.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createAuthService } from '../src/auth-core.ts';
import { createAuth } from '../src/auth.ts';
import type { AuthExtensionOptions } from '../src/auth.ts';
import { siteCompanions, lastSent, linkIn } from './support/companions.ts';
import type { TestContext } from 'node:test';
import { kitSetup, kitYaml, writeCopy } from './support/render.ts';
/** `delivery`: mail records what auth sends (`sent`); without it mail has no transport and auth serves password sign-in only. */
async function app(t: TestContext, { delivery = false, providers, uiConfig = {}, copy = {}, serviceOptions, aliasOrigins }: { delivery?: boolean; providers?: AuthExtensionOptions['providers']; /** `extensions.ui.config`, and project catalogues written to `ui/copy/<locale>.json`. */ uiConfig?: Record<string, unknown>; copy?: Record<string, Record<string, string>>; serviceOptions?: Partial<Parameters<typeof createAuthService>[0]>; aliasOrigins?: string[] } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-http-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project);
    if (Object.keys(copy).length)
        uiConfig = { ...uiConfig, ...await writeCopy(project, copy) };
    const kit = kitYaml(uiConfig);
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ...kit.extensions, auth: { version: '1', config: { registration: serviceOptions?.registrationMode ?? 'open' } } }, routes: {
            '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
            '/private': { respond: { json: { protected: true } }, methods: ['GET', 'POST'], policies: { extensions: { auth: { permission: 'site.read' } } } },
            ...kit.routes,
        } }));
    const projectSha256 = await inspectExtensionRevision(project), { ui, registrations } = kitSetup(project, projectSha256, uiConfig);
    const hosted = await siteCompanions(t, root, projectSha256, delivery ? {} : { transport: false });
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], admin: ['*'] }, defaultRole: 'member', ...serviceOptions });
    const extension = createAuth({ ...(providers ? { providers } : {}), ui, service, csrfKey: randomBytes(32), projectSha256, audit: hosted.audit, mail: hosted.mail }).registration;
    const server = await startServer({ project, origin: 'https://example.test', ...(aliasOrigins ? { aliasOrigins } : {}), port: 0, extensions: [...registrations, ...hosted.registrations, extension], log: () => { } }).catch(async (error) => { await service.close(); throw error; });
    cleanup(t, async () => { try { await server.close(); } finally { await service.close(); } });
    const cookies = new Map<string, string>();
    async function request(path: string, { method = 'GET', data, origin = 'https://example.test', csrf, html = false }: {
        method?: string;
        data?: Record<string, string>;
        origin?: string;
        csrf?: string;
        html?: boolean;
    } = {}) {
        const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { method, redirect: 'manual', headers: { accept: html ? 'text/html' : 'application/json', ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}), ...(data ? { 'content-type': html ? 'application/x-www-form-urlencoded' : 'application/json', origin } : {}), ...(csrf ? { 'x-csrf-token': csrf, origin } : {}) }, ...(data ? { body: html ? new URLSearchParams(data).toString() : JSON.stringify(data) } : {}) });
        for (const header of response.headers.getSetCookie()) {
            const first = header.split(';')[0]!, index = first.indexOf('=');
            if (header.includes('Max-Age=0'))
                cookies.delete(first.slice(0, index));
            else
                cookies.set(first.slice(0, index), first.slice(index + 1));
        }
        return response;
    }
    return { request, service, cookies, sent: hosted.sent };
}
test('a credential-quota 429 on a throttled route carries both the credential and the core throttle RateLimit policies (#701)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-quota-throttle-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project);
    const kit = kitYaml();
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ...kit.extensions, auth: { version: '1', config: { registration: 'open' } } }, routes: {
            '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
            '/api/items': { respond: { json: { items: [] } }, auth: { bearer: { scopes: ['items.read'], quota: { requests: 2, window: 60 } } }, policies: { throttle: { quota: 60, window: 60 } } },
            ...kit.routes,
        } }));
    const projectSha256 = await inspectExtensionRevision(project), { ui, registrations } = kitSetup(project, projectSha256);
    const hosted = await siteCompanions(t, root, projectSha256);
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    const extension = createAuth({ ui, service, csrfKey: randomBytes(32), projectSha256, audit: hosted.audit, mail: hosted.mail }).registration;
    const server = await startServer({ project, origin: 'https://example.test', port: 0, extensions: [...registrations, ...hosted.registrations, extension], log: () => { } }).catch(async (error) => { await service.close(); throw error; });
    cleanup(t, async () => { try { await server.close(); } finally { await service.close(); } });
    const { key } = await service.issueApiKey({ name: 'items', scopes: ['items.read'] });
    const call = () => fetch(`http://127.0.0.1:${server.address.port}/api/items`, { headers: { authorization: `Bearer ${key}` } });
    for (let i = 0; i < 2; i++) {
        const allowed = await call();
        assert.equal(allowed.status, 200);
        await allowed.arrayBuffer();
        // An allowed response carries both budgets too (urlcode#703): the credential's, from
        // auth's middleware(), and core throttle's "default" in the same list fields.
        assert.equal(allowed.headers.get('ratelimit-policy'), '"credential";q=2;w=60, "default";q=60;w=60');
        assert.match(allowed.headers.get('ratelimit') ?? '', new RegExp(`^"credential";r=${1 - i};t=\\d+, "default";r=\\d+;t=\\d+$`));
        assert.equal(allowed.headers.get('cache-control'), 'no-store');
    }
    const refused = await call();
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { error: 'credential_quota_exceeded' });
    // The refusal is the credential's: its budget and Retry-After survive, and throttle's
    // own policy is appended to the same list fields rather than replacing them.
    assert.equal(refused.headers.get('ratelimit-policy'), '"credential";q=2;w=60, "default";q=60;w=60');
    assert.match(refused.headers.get('ratelimit') ?? '', /^"credential";r=0;t=(\d+), "default";r=\d+;t=\d+$/);
    const reset = /^"credential";r=0;t=(\d+)/.exec(refused.headers.get('ratelimit') ?? '')![1];
    assert.equal(refused.headers.get('retry-after'), reset);
});
test('allowed bearer responses carry the credential RateLimit fields, a key quota replaces the route quota, and nothing is cached (#703)', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-key-quota-http-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project);
    const kit = kitYaml();
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    const write = (cache?: object) => writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ...kit.extensions, auth: { version: '1', config: { registration: 'open' } } }, routes: {
            '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
            '/api/items': { respond: { json: { items: [] } }, auth: { bearer: { scopes: ['items.read'], quota: { requests: 2, window: 60 } } }, ...(cache ? { cache } : {}) },
            '/api/open': { respond: { json: { open: true } }, auth: { bearer: { scopes: ['items.read'] } } },
            ...kit.routes,
        } }));
    const start = async () => {
        const projectSha256 = await inspectExtensionRevision(project), { ui, registrations } = kitSetup(project, projectSha256);
        const hosted = await siteCompanions(t, root, projectSha256);
        return startServer({ project, origin: 'https://example.test', port: 0, extensions: [...registrations, ...hosted.registrations, createAuth({ ui, service, csrfKey: randomBytes(32), projectSha256, audit: hosted.audit, mail: hosted.mail }).registration], log: () => { } });
    };
    // A shared-cache strategy on a route auth protects is refused before serving: core treats
    // it as confidential (auth declares no `cacheSensitive: false`), so per-credential fields
    // can never be stored in or served from its cache.
    await write({ strategy: 'public', maxAge: 300 });
    await assert.rejects(start(), { message: '/api/items: routes protected by extension "auth" cannot be cached; use cache: {strategy: no-store} or remove cache' });
    await write();
    const server = await start().catch(async (error) => { await service.close(); throw error; });
    cleanup(t, async () => { try { await server.close(); } finally { await service.close(); } });
    const plain = await service.issueApiKey({ name: 'plain', scopes: ['items.read'] });
    const gold = await service.issueApiKey({ name: 'gold', scopes: ['items.read'], quota: { requests: 3, window: 120 } });
    const call = (key: string, path = '/api/items') => fetch(`http://127.0.0.1:${server.address.port}${path}`, { headers: { authorization: `Bearer ${key}` } });
    // A key without its own quota: the route's budget, reported on every allowed response.
    for (let i = 0; i < 2; i++) {
        const allowed = await call(plain.key);
        assert.equal(allowed.status, 200);
        assert.deepEqual(await allowed.json(), { items: [] });
        assert.equal(allowed.headers.get('ratelimit-policy'), '"credential";q=2;w=60');
        assert.match(allowed.headers.get('ratelimit') ?? '', new RegExp(`^"credential";r=${1 - i};t=([1-9]\\d*)$`));
        // Per-credential values: never storable by any cache, and never served from one.
        assert.equal(allowed.headers.get('cache-control'), 'no-store');
        assert.equal(allowed.headers.get('age'), null);
    }
    assert.equal((await call(plain.key)).status, 429);
    // A key with its own quota: its budget replaces the route's, on this route and every other.
    for (let i = 0; i < 3; i++) {
        const allowed = await call(gold.key, i === 2 ? '/api/open' : '/api/items');
        assert.equal(allowed.status, 200);
        await allowed.arrayBuffer();
        assert.equal(allowed.headers.get('ratelimit-policy'), '"credential";q=3;w=120');
        assert.match(allowed.headers.get('ratelimit') ?? '', new RegExp(`^"credential";r=${2 - i};t=\\d+$`));
        assert.equal(allowed.headers.get('cache-control'), 'no-store');
    }
    const refused = await call(gold.key);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('ratelimit-policy'), '"credential";q=3;w=120');
    // A key with no quota on a route with none: no credential fields at all.
    const open = await call(plain.key, '/api/open');
    assert.equal(open.status, 200);
    await open.arrayBuffer();
    assert.equal(open.headers.get('ratelimit-policy'), null);
    assert.equal(open.headers.get('ratelimit'), null);
    // An unauthenticated request is still refused: no cached copy was ever stored to serve it.
    const anonymous = await fetch(`http://127.0.0.1:${server.address.port}/api/items`);
    assert.equal(anonymous.status, 401);
    await anonymous.arrayBuffer();
});
test('real runtime enforces session policy, CSRF and cookie privacy end to end', async (t) => {
    const { request, cookies } = await app(t);
    assert.equal((await request('/private')).status, 401);
    const flow = await request('/account/csrf');
    const { csrf } = await flow.json() as {
        csrf: string;
    };
    const denied = await request('/account/register', { method: 'POST', origin: 'https://evil.test', data: { email: 'reader@example.test', password: 'correct horse battery staple', csrf } });
    assert.equal(denied.status, 403);
    const registered = await request('/account/register', { method: 'POST', data: { email: 'reader@example.test', password: 'correct horse battery staple', csrf } });
    assert.equal(registered.status, 201);
    const data = await registered.json() as {
        csrf: string;
        user: {
            email: string;
        };
        token?: string;
    };
    assert.equal(data.user.email, 'reader@example.test');
    assert.equal(data.token, undefined);
    const cookie = registered.headers.getSetCookie().find(value => value.startsWith('__Host-urlcode-session='))!;
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/'])
        assert.ok(cookie.includes(flag));
    assert.ok(cookies.has('__Host-urlcode-session'));
    assert.equal((await request('/private')).status, 200);
    assert.equal((await request('/private', { method: 'POST' })).status, 403);
    assert.equal((await request('/private', { method: 'POST', csrf: data.csrf })).status, 200);
    assert.equal((await request('/account/logout', { method: 'POST', data: { csrf: '0'.repeat(64) } })).status, 403);
    assert.equal((await request('/account/logout', { method: 'POST', data: { csrf: data.csrf } })).status, 200);
    assert.equal((await request('/private')).status, 401);
});
test('trusted UI is no-store with restrictive CSP and never exposes a session token', async (t) => {
    const { request } = await app(t);
    const page = await request('/account/login');
    const html = await page.text();
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy') || '', /form-action 'self'/);
    assert.match(html, /autocomplete="username"/);
    assert.match(html, /<label class="ui-label" data-slot="field-label" for="email-[a-f0-9]+">/);
    assert.match(html, /Skip to content/);
    assert.match(html, /<(?:main|body)[^>]*data-layout="compact"/);
    assert.doesNotMatch(html, /<p class="ui-intro"><\/p>/);
    assert.match(html, /Enter your email to continue to your account\./);
    assert.doesNotMatch(html, /class="ui-field-separator"/, 'the separator is omitted when no alternative method is configured');
    const scriptNonces = [...html.matchAll(/<script nonce="([^"]+)"/g)].map(match => match[1]);
    const styleNonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
    assert.equal(scriptNonces.length, 1, 'Only the reviewed theme bootstrap runs on identifier entry');
    assert.equal(scriptNonces[0], styleNonce);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/ui\/static\/kit\.[0-9a-f]{12}\.css">/);
    assert.ok(page.headers.get('content-security-policy')!.includes(`script-src 'nonce-${scriptNonces[0]}'`));
    assert.doesNotMatch(page.headers.get('content-security-policy')!, /script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(html, /<script[^>]+src=/);
    const { csrf } = await (await request('/account/csrf')).json() as {
        csrf: string;
    };
    const identify = await request('/account/identify', { method: 'POST', data: { email: 'missing@example.test', csrf } });
    assert.equal(identify.status, 200);
    const passwordHtml = await identify.text();
    assert.match(passwordHtml, /autocomplete="current-password"/);
    assert.match(passwordHtml, /<h1[^>]*>Enter your password<\/h1>/);
    assert.match(passwordHtml, /type="hidden" name="email" value="missing@example.test"/);
    assert.doesNotMatch(passwordHtml, /name="email" type="email"/);
    assert.match(passwordHtml, /<details class="ui-disclosure"><summary>Two-step verification/);
    assert.doesNotMatch(passwordHtml, /<details[^>]+open/);
    assert.equal((await request('/account/login', { method: 'POST', data: { email: 'missing@example.test', password: 'wrong password value', csrf } })).status, 401);
    assert.equal((await request('/account/logout')).status, 401);
});
test('an operator alias origin passes the same-origin mutation check; an unlisted origin is still refused', async (t) => {
    const { request } = await app(t, { aliasOrigins: ['https://www.example.test'] });
    const { csrf } = await (await request('/account/csrf')).json() as {
        csrf: string;
    };
    const denied = await request('/account/register', { method: 'POST', origin: 'https://evil.test', data: { email: 'alias@example.test', password: 'correct horse battery staple', csrf } });
    assert.equal(denied.status, 403);
    const sibling = await request('/account/register', { method: 'POST', origin: 'https://api.example.test', data: { email: 'alias@example.test', password: 'correct horse battery staple', csrf } });
    assert.equal(sibling.status, 403, 'an alias names one origin, not its sibling subdomains');
    const registered = await request('/account/register', { method: 'POST', origin: 'https://www.example.test', data: { email: 'alias@example.test', password: 'correct horse battery staple', csrf } });
    assert.equal(registered.status, 201);
});
test('same-origin still requires unambiguous CSRF and no token-bearing query mutation', async (t) => {
    const { request } = await app(t);
    assert.equal((await request('/account/register', { method: 'POST', data: { email: 'new@example.test', password: 'correct horse battery staple' } })).status, 403);
    assert.equal((await request('/account/verify?token=a&token=b')).status, 400);
    assert.equal((await request('/account/reset')).status, 400);
});
test('email links, private export, password change and deletion grace work end to end', async (t) => {
    const { request, cookies, sent } = await app(t, { delivery: true });
    const codes = () => sent.filter(envelope => envelope.template === 'auth.sign-in-code').map(envelope => ({ flowId: linkIn(envelope).searchParams.get('flowId')!, code: /code is: (\d{6})/.exec(envelope.text)![1]! }));
    let { csrf } = await (await request('/account/csrf')).json() as {
        csrf: string;
    };
    const registered = await request('/account/register', { method: 'POST', data: { email: 'lifecycle@example.test', password: 'correct horse battery staple', csrf } });
    ({ csrf } = await registered.json() as {
        csrf: string;
    });
    const exported = await request('/account/export', { method: 'POST', data: { csrf } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-disposition') || '', /attachment/);
    assert.doesNotMatch(await exported.text(), /passwordHash|publicKey|sessionToken/);
    assert.equal((await request('/account/delete', { method: 'POST', data: { csrf, password: 'correct horse battery staple' } })).status, 400);
    assert.equal((await request('/account/change-password', { method: 'POST', data: { csrf, currentPassword: 'correct horse battery staple', password: 'a different long password phrase' } })).status, 200);
    assert.ok(!cookies.has('__Host-urlcode-session'));
    assert.equal((await request('/private')).status, 401);
    ({ csrf } = await (await request('/account/csrf')).json() as {
        csrf: string;
    });
    assert.equal((await request('/account/send-email-code', { method: 'POST', data: { csrf, email: 'lifecycle@example.test' } })).status, 200);
    assert.equal(codes().length, 1);
    const logged = await request('/account/email-code', { method: 'POST', data: { csrf, flowId: codes()[0]!.flowId, code: codes()[0]!.code } });
    assert.equal(logged.status, 200);
    ({ csrf } = await logged.json() as {
        csrf: string;
    });
    assert.equal((await request('/account/delete', { method: 'POST', data: { csrf, confirmation: 'DELETE', password: 'a different long password phrase' } })).status, 200);
    assert.equal((await request('/private')).status, 401);
    assert.equal(sent.filter(envelope => envelope.template === 'auth.cancel-deletion').length, 1);
    ({ csrf } = await (await request('/account/csrf')).json() as {
        csrf: string;
    });
    assert.equal((await request('/account/cancel-deletion', { method: 'POST', data: { csrf, token: linkIn(lastSent(sent, 'auth.cancel-deletion')).searchParams.get('token')! } })).status, 200);
});
test('OIDC subjects are scoped to verified issuer across operator provider replacement', async (t) => {
    let issuer = 'https://issuer-one.test', email = 'one@example.test';
    const provider = { async start() { const state = randomBytes(32).toString('base64url'); return { url: 'https://provider.test/authorize?state=' + state, flow: { state, nonce: state, verifier: state } }; }, async complete() { return { issuer, subject: 'same-subject', email, emailVerified: true }; } };
    const { request, cookies } = await app(t, { providers: { example: provider } });
    async function signIn() {
        const { csrf } = await (await request('/account/csrf')).json() as {
            csrf: string;
        };
        const started = await request('/account/providers/example/start', { method: 'POST', data: { csrf } });
        assert.equal(started.status, 303);
        const state = new URL(started.headers.get('location')!).searchParams.get('state');
        const completed = await request('/account/providers/example/callback?state=' + state);
        assert.equal(completed.status, 200);
        return await completed.json() as {
            user: {
                id: string;
                email: string;
            };
        };
    }
    const first = await signIn();
    cookies.clear();
    issuer = 'https://issuer-two.test';
    email = 'two@example.test';
    const second = await signIn();
    assert.notEqual(first.user.id, second.user.id);
    assert.equal(second.user.email, email);
});
test('locale and safe theme apply to trusted HTML while translated text remains escaped', async (t) => {
    const { request } = await app(t, { uiConfig: { theme: { colors: { accent: '#123456' } } }, copy: { fr: { 'page.signIn': 'Connexion <test>', 'field.email': 'Adresse électronique', 'nav.skip': 'Aller au contenu' } } });
    const page = await request('/account/login?lang=fr');
    const html = await page.text();
    assert.match(html, /lang="fr"/);
    assert.match(html, /Connexion &lt;test&gt;/);
    assert.match(html, /Adresse électronique/);
    assert.match(html, /Aller au contenu/);
    assert.match(html, /--accent:#123456/);
    assert.doesNotMatch(html, /<test>/);
});
test('registration HTTP enforces consent, schema boundaries, honeypot and invitation mode', async (t) => {
    const policy = createRegistrationPolicy({ termsVersion: '2026-09', metadata: { team: { type: 'string', scope: 'public', required: true }, internal: { type: 'string', scope: 'private', default: 'operator-only' } } });
    const { request, service } = await app(t, { serviceOptions: { registrationPolicy: policy } });
    let { csrf } = await (await request('/account/csrf')).json() as {
        csrf: string;
    };
    const data = { csrf, email: 'profile@example.test', password: 'correct horse battery staple', 'meta.team': 'engineering' };
    assert.equal((await request('/account/register', { method: 'POST', data })).status, 400);
    assert.equal((await request('/account/register', { method: 'POST', data: { ...data, termsAccepted: 'true', 'meta.internal': 'attacker' } })).status, 400);
    assert.equal((await request('/account/register', { method: 'POST', data: { ...data, termsAccepted: 'true', website: 'bot' } })).status, 202);
    assert.equal((await service.listUsers()).users.length, 0);
    const registered = await request('/account/register', { method: 'POST', data: { ...data, termsAccepted: 'true', displayName: 'A Reader' } });
    assert.equal(registered.status, 201);
    const value = await registered.json() as {
        csrf: string;
        user: {
            profile: {
                metadata: Record<string, string>;
                terms: {
                    version: string;
                };
            };
        };
    };
    assert.deepEqual(value.user.profile.metadata, { team: 'engineering' });
    assert.equal(value.user.profile.terms.version, '2026-09');
    csrf = value.csrf;
    assert.equal((await request('/account/profile', { method: 'POST', data: { csrf, displayName: 'Updated' } })).status, 200);
});
test('OIDC new-account enrollment collects required consent and metadata before issuing a session', async (t) => {
    const provider = { async start() { const state = randomBytes(32).toString('base64url'); return { url: 'https://provider.test/authorize?state=' + state, flow: { state, nonce: state, verifier: state } }; }, async complete() { return { issuer: 'https://provider.test', subject: 'enrollment-user', email: 'enrollment@example.test', emailVerified: true }; } };
    const policy = createRegistrationPolicy({ termsVersion: 'current', metadata: { team: { type: 'string', scope: 'public', required: true } } });
    const { request, service } = await app(t, { providers: { example: provider }, serviceOptions: { registrationPolicy: policy } });
    async function enroll() {
        const { csrf } = await (await request('/account/csrf')).json() as {
            csrf: string;
        };
        const started = await request('/account/providers/example/start', { method: 'POST', data: { csrf } });
        const state = new URL(started.headers.get('location')!).searchParams.get('state');
        const callback = await request('/account/providers/example/callback?state=' + state);
        assert.equal(callback.status, 200);
        const html = await callback.text();
        assert.match(html, /Complete your account/);
        return { csrf: html.match(/name="csrf" value="([^"]+)"/)![1]!, flowId: html.match(/name="flowId" value="([^"]+)"/)![1]! };
    }
    const invalid = await enroll();
    assert.equal((await request('/account/providers/enroll', { method: 'POST', data: { ...invalid, 'meta.team': 'support' } })).status, 400);
    assert.equal((await service.listUsers()).users.length, 0);
    const valid = await enroll();
    const result = await request('/account/providers/enroll', { method: 'POST', data: { ...valid, 'meta.team': 'support', termsAccepted: 'true' } });
    assert.equal(result.status, 200);
    assert.equal((await service.listUsers()).users.length, 1);
    assert.equal((await request('/private')).status, 200);
});

test('browser sign-in failures retain only the identifier and offer safe recovery routes', async t => {
    const {request} = await app(t, { delivery: true });
    const {csrf} = await (await request('/account/csrf')).json() as {csrf:string};
    const response = await request('/account/login', {method:'POST', html:true, data:{email:'missing@example.test',password:'synthetic incorrect password',csrf}});
    assert.equal(response.status,401);
    const markup=await response.text();
    assert.match(markup,/<h1[^>]*>Enter your password<\/h1>/);
    assert.match(markup,/missing@example.test/);
    assert.match(markup,/role="alert"/);
    assert.match(markup,/\/account\/forgot-password/);
    assert.doesNotMatch(markup,/synthetic incorrect password/);
    const reset=await request('/account/forgot-password',{method:'POST',html:true,data:{email:'missing@example.test',csrf}});
    assert.equal(reset.status,200);
    assert.match(await reset.text(),/<h1[^>]*>Check your email<\/h1>/);
});

test('password retry never advertises unavailable password recovery', async t => {
    const {request} = await app(t);
    const {csrf} = await (await request('/account/csrf')).json() as {csrf:string};
    const response = await request('/account/login', {method:'POST',html:true,data:{email:'missing@example.test',password:'synthetic incorrect password',csrf}});
    assert.equal(response.status,401);
    const markup = await response.text();
    assert.match(markup,/Sign-in failed\. Check your password and any required verification code\./);
    assert.doesNotMatch(markup,/reset your password|\/account\/forgot-password/i);
    assert.match(markup,/href="\/account\/login\?lang=en"/);
});

test('registering an already-used email is indistinguishable from a genuine registration (no enumeration)', async t => {
    const { request, service } = await app(t);
    await service.register({ email: 'taken@example.test', password: 'existing account passphrase 1' });
    const { csrf } = await (await request('/account/csrf')).json() as { csrf: string };
    const fresh = await request('/account/register', { method: 'POST', data: { email: 'new@example.test', password: 'brand new passphrase 1', csrf } });
    const { csrf: csrf2 } = await (await request('/account/csrf')).json() as { csrf: string };
    const duplicate = await request('/account/register', { method: 'POST', data: { email: 'taken@example.test', password: 'guessed passphrase attempt 1', csrf: csrf2 } });
    assert.equal(fresh.status, duplicate.status, 'same status for a new and an already-taken email');
    const freshBody = await fresh.json() as { user: Record<string, unknown>; csrf: string }, duplicateBody = await duplicate.json() as { user: Record<string, unknown>; csrf: string };
    assert.deepEqual(Object.keys(freshBody).sort(), Object.keys(duplicateBody).sort(), 'same top-level shape');
    assert.deepEqual(Object.keys(freshBody.user).sort(), Object.keys(duplicateBody.user).sort(), 'same user shape');
    assert.equal(duplicateBody.user.email, 'taken@example.test');
    // Unlike the genuine registration, the "duplicate" response must not hand out a session
    // cookie at all: one built from a token that was never persisted server-side would look
    // valid while authenticating nothing (#548).
    const freshCookieNames = fresh.headers.getSetCookie().map(header => header.split('=')[0]), duplicateCookieNames = duplicate.headers.getSetCookie().map(header => header.split('=')[0]);
    assert.ok(freshCookieNames.includes('__Host-urlcode-session'), 'genuine registration sets a session cookie');
    assert.ok(!duplicateCookieNames.includes('__Host-urlcode-session'), 'duplicate registration does not set a session cookie');
    // A fresh client (its own cookie jar, so the earlier genuine registration above cannot
    // leave it already signed in) confirms there is nothing left to authenticate with either.
    const other = await app(t);
    await other.service.register({ email: 'taken-2@example.test', password: 'existing account passphrase 2' });
    const { csrf: otherCsrf } = await (await other.request('/account/csrf')).json() as { csrf: string };
    await other.request('/account/register', { method: 'POST', data: { email: 'taken-2@example.test', password: 'guessed passphrase attempt 2', csrf: otherCsrf } });
    const whoAmI = await other.request('/private', { method: 'GET' });
    assert.equal(whoAmI.status, 401);
});

test('forgot-password and send-email-code always attempt delivery, existing account or not', async t => {
    const { request, service, sent } = await app(t, { delivery: true });
    await service.register({ email: 'known@example.test', password: 'existing account passphrase 2' });
    const { csrf } = await (await request('/account/csrf')).json() as { csrf: string };
    const known = await request('/account/forgot-password', { method: 'POST', data: { email: 'known@example.test', csrf } });
    const { csrf: csrf2 } = await (await request('/account/csrf')).json() as { csrf: string };
    const unknown = await request('/account/forgot-password', { method: 'POST', data: { email: 'nobody@example.test', csrf: csrf2 } });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(await known.json(), await unknown.json());
    assert.deepEqual(sent.map(envelope => envelope.to), ['known@example.test', 'nobody@example.test'], 'delivery attempted for both the existing and the unknown address');
});

test('account authenticator controls reflect the current enrollment state', async t => {
    const {request,service,cookies} = await app(t);
    const user = await service.register({email:'reader@example.test',password:'synthetic account settings passphrase'});
    cookies.set('__Host-urlcode-session',user.token);
    const before=await (await request('/account/account',{html:true})).text();
    assert.match(before,/action="[^" ]*\/totp\/begin/);
    assert.doesNotMatch(before,/action="[^" ]*\/totp\/disable/);
    const pending=await service.beginTotp(user.token);
    await service.confirmTotp({token:user.token,code:new TOTP({secret:pending.secret}).generate()});
    const after=await (await request('/account/account',{html:true})).text();
    assert.match(after,/<details class="ui-disclosure"><summary>Disable authenticator<\/summary>/);
    assert.match(after,/action="[^" ]*\/totp\/disable/);
    assert.doesNotMatch(after,/action="[^" ]*\/totp\/begin/);
});
