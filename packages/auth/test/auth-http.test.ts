import { cleanup } from './cleanup.ts';
import { TOTP } from 'otpauth';
import { createRegistrationPolicy } from '../src/registration.ts';
import { createPresentation } from '../src/presentation.ts';
import { test as base } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createAuthService } from '../src/auth-core.ts';
import { authExtension } from '../src/auth.ts';
import type { TestContext } from 'node:test';
import { eachRenderPath, kitSetup, renderOf } from './support/render.ts';
const test = (name: string, fn: (t: TestContext) => Promise<void>) => eachRenderPath(base, name, fn);
async function app(t: TestContext, sendToken?: Parameters<typeof authExtension>[0]['sendToken'], providers?: Parameters<typeof authExtension>[0]['providers'], presentation?: Parameters<typeof authExtension>[0]['presentation'], sendEmailCode?: Parameters<typeof authExtension>[0]['sendEmailCode'], serviceOptions?: Partial<Parameters<typeof createAuthService>[0]>) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-http-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project);
    const render = renderOf(t), kit = kitSetup(render, project, '', {});
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: { registration: serviceOptions?.registrationMode ?? 'open' } }, ...kit.extensions }, routes: {
            '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
            '/private': { respond: { json: { protected: true } }, methods: ['GET', 'POST'], policies: { extensions: { auth: { permission: 'site.read' } } } },
            ...kit.routes,
        } }));
    const projectSha256 = await inspectExtensionRevision(project), { ui, registrations } = kitSetup(render, project, projectSha256);
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], admin: ['*'] }, defaultRole: 'member', ...serviceOptions });
    const extension = authExtension({ ...(sendToken ? { sendToken } : {}), ...(providers ? { providers } : {}), ...(presentation ? { presentation } : {}), ...(sendEmailCode ? { sendEmailCode } : {}), ...(ui ? { ui } : {}), service, csrfKey: randomBytes(32), projectSha256 });
    const server = await startServer({ project, origin: 'https://example.test', port: 0, extensions: [...registrations, extension], log: () => { } }).catch(async (error) => { await service.close(); throw error; });
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
    return { request, service, cookies, render };
}
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
    const { request, render } = await app(t);
    const page = await request('/account/login');
    const html = await page.text();
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy') || '', /form-action 'self'/);
    assert.match(html, /autocomplete="username"/);
    assert.match(html, /<label for="email-[a-f0-9]+">/);
    assert.match(html, /Skip to content/);
    assert.match(html, /<(?:main|body)[^>]*data-layout="compact"/);
    assert.doesNotMatch(html, /<p class="ui-intro"><\/p>/);
    const scriptNonces = [...html.matchAll(/<script nonce="([^"]+)"/g)].map(match => match[1]);
    const styleNonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
    assert.equal(scriptNonces.length, 1, 'Only the reviewed theme bootstrap runs on identifier entry on either render path');
    if (render === 'kit') { assert.equal(scriptNonces[0], styleNonce); assert.match(html, /<link rel="stylesheet" href="\/assets\/ui\/static\/kit\.[0-9a-f]{12}\.css">/); }
    assert.ok(page.headers.get('content-security-policy')!.includes(`script-src 'nonce-${scriptNonces[0] ?? styleNonce}'`));
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
test('same-origin still requires unambiguous CSRF and no token-bearing query mutation', async (t) => {
    const { request } = await app(t);
    assert.equal((await request('/account/register', { method: 'POST', data: { email: 'new@example.test', password: 'correct horse battery staple' } })).status, 403);
    assert.equal((await request('/account/verify?token=a&token=b')).status, 400);
    assert.equal((await request('/account/reset')).status, 400);
});
test('email links, private export, password change and deletion grace work end to end', async (t) => {
    const delivered: {
        token: string;
    }[] = [], codes: {
        flowId: string;
        code: string;
    }[] = [];
    const { request, cookies } = await app(t, async (message) => { delivered.push(message); }, undefined, undefined, async (message) => { codes.push(message); });
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
    assert.equal(codes.length, 1);
    const logged = await request('/account/email-code', { method: 'POST', data: { csrf, flowId: codes[0]!.flowId, code: codes[0]!.code } });
    assert.equal(logged.status, 200);
    ({ csrf } = await logged.json() as {
        csrf: string;
    });
    assert.equal((await request('/account/delete', { method: 'POST', data: { csrf, confirmation: 'DELETE', password: 'a different long password phrase' } })).status, 200);
    assert.equal((await request('/private')).status, 401);
    assert.equal(delivered.length, 1);
    ({ csrf } = await (await request('/account/csrf')).json() as {
        csrf: string;
    });
    assert.equal((await request('/account/cancel-deletion', { method: 'POST', data: { csrf, token: delivered[0]!.token } })).status, 200);
});
test('OIDC subjects are scoped to verified issuer across operator provider replacement', async (t) => {
    let issuer = 'https://issuer-one.test', email = 'one@example.test';
    const provider = { async start() { const state = randomBytes(32).toString('base64url'); return { url: 'https://provider.test/authorize?state=' + state, flow: { state, nonce: state, verifier: state } }; }, async complete() { return { issuer, subject: 'same-subject', email, emailVerified: true }; } };
    const { request, cookies } = await app(t, undefined, { example: provider });
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
    const presentation = createPresentation({ catalogues: { fr: { 'page.signIn': 'Connexion <test>', 'field.email': 'Adresse électronique', 'nav.skip': 'Aller au contenu' } }, theme: { '--auth-accent': '#123456' } });
    const { request } = await app(t, undefined, undefined, presentation);
    const page = await request('/account/login?lang=fr');
    const html = await page.text();
    assert.match(html, /lang="fr"/);
    assert.match(html, /Connexion &lt;test&gt;/);
    assert.match(html, /Adresse électronique/);
    assert.match(html, /Aller au contenu/);
    assert.match(html, /--ui-accent:#123456/);
    assert.doesNotMatch(html, /<test>/);
});
test('registration HTTP enforces consent, schema boundaries, honeypot and invitation mode', async (t) => {
    const policy = createRegistrationPolicy({ termsVersion: '2026-09', metadata: { team: { type: 'string', scope: 'public', required: true }, internal: { type: 'string', scope: 'private', default: 'operator-only' } } });
    const { request, service } = await app(t, undefined, undefined, undefined, undefined, { registrationPolicy: policy });
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
    const { request, service } = await app(t, undefined, { example: provider }, undefined, undefined, { registrationPolicy: policy });
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
    const {request} = await app(t, async () => {});
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
