import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createKit, createPresentation as createUiPresentation, kitCatalogue, mergeCatalogues, isMarkup } from '@jimhoyd/urlcode-ui';
import type { ViewModel, ViewValue } from '@jimhoyd/urlcode-ui';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createAuthService } from '../src/auth-core.ts';
import { authExtension } from '../src/auth.ts';
import { screenObserver } from '../src/auth-ui.ts';
import type { Screen } from '../src/auth-ui.ts';
import { authTemplates, authTemplateNames, authUiTemplates } from '../src/auth-templates.ts';
import { englishCatalogue, createPresentation } from '../src/presentation.ts';
import { kitSetup } from './support/render.ts';
import type { TestContext } from 'node:test';
/** Compares a real view with a sample the way `urlcode-ui doctor` would: same keys at every level, list items checked against the sample item, Markup and scalars as leaves. */
function mismatch(real: ViewValue, sample: ViewValue, path = ''): string | undefined {
    if (Array.isArray(sample)) {
        if (!Array.isArray(real)) return `${path}: expected a list`;
        for (const [index, item] of real.entries()) { const found = mismatch(item, sample[0]!, `${path}[${index}]`); if (found) return found; }
        return undefined;
    }
    if (sample && typeof sample === 'object' && !isMarkup(sample)) {
        if (!real || typeof real !== 'object' || Array.isArray(real) || isMarkup(real)) return `${path}: expected an object`;
        const wanted = Object.keys(sample).sort(), got = Object.keys(real).sort();
        if (JSON.stringify(wanted) !== JSON.stringify(got)) return `${path}: keys ${JSON.stringify(got)} differ from sample ${JSON.stringify(wanted)}`;
        for (const key of wanted) { const found = mismatch((real as ViewModel)[key], (sample as ViewModel)[key], `${path}.${key}`); if (found) return found; }
        return undefined;
    }
    return undefined;
}
test('every auth template declares its view model, renders its sample through the kit and uses only registered copy', () => {
    const presentation = createUiPresentation({ defaults: mergeCatalogues([kitCatalogue, englishCatalogue]) });
    const kit = createKit({ presentation, extensions: [authUiTemplates] });
    const context = kit.resolveContext();
    assert.ok(authTemplateNames.length >= 20);
    for (const name of authTemplateNames) {
        const info = kit.info(name)!;
        assert.equal(info.origin, 'extension:auth');
        assert.equal(info.viewModel, `${name}@1`, `${name} declares its view model`);
        assert.equal(info.behind, false);
        const html = kit.render(name, authTemplates[name]!.sample, context).html;
        assert.ok(html.length > 0 && !html.includes('{{'), `${name} renders its sample`);
        const page = new TextDecoder().decode(kit.page(name, authTemplates[name]!.sample, { title: 'Sample', context }).body);
        assert.match(page, /<main id="main"/);
    }
    assert.deepEqual(kit.report().behind, []);
    // Copy reaches a template through the view the extension computed, so a project translation cannot desynchronise a template from its flow.
    for (const name of authTemplateNames) assert.deepEqual(kit.template(name)!.copyKeys, [], `${name} places copy through its view`);
});
test('the views the extension computes match the sample view models key for key, on both render paths', async (t) => {
    const observed = new Map<string, { view: ViewModel; paths: Set<string> }>();
    screenObserver.current = (screen: Screen, path) => { const entry = observed.get(screen.name) ?? { view: screen.view, paths: new Set() }; entry.paths.add(path); observed.set(screen.name, entry); };
    t.after(() => { screenObserver.current = undefined; });
    for (const path of ['primitives', 'kit'] as const) {
        const { request, service } = await app(t, path);
        const { csrf } = await (await request('/account/csrf')).json() as { csrf: string };
        for (const page of ['/account/login', '/account/forgot-password', '/account/email-code', '/account/verify?token=x', '/account/reset?token=x', '/account/cancel-deletion?token=x', '/account/verify-email-change?token=x', '/account/recover-factor', '/account/signup', '/account/signup/pending'])
            assert.equal((await request(page, { html: true })).status, 200, page);
        assert.equal((await request('/account/identify', { method: 'POST', html: true, data: { email: 'reader@example.test', csrf } })).status, 200);
        assert.equal((await request('/account/forgot-password', { method: 'POST', html: true, data: { email: 'reader@example.test', csrf } })).status, 200);
        assert.equal((await request('/account/nowhere', { html: true })).status, 401, 'the failure screen renders on this path');
        const registered = await request('/account/register', { method: 'POST', data: { email: 'reader@example.test', password: 'correct horse battery staple', csrf } });
        const session = await registered.json() as { csrf: string };
        for (const page of ['/account/account', '/account/sessions', '/account/methods', '/account/step-up', '/account/second-factors', '/account/trusted-devices'])
            assert.equal((await request(page, { html: true })).status, 200, page);
        const begun = await request('/account/totp/begin', { method: 'POST', html: true, data: { csrf: session.csrf } });
        assert.equal(begun.status, 200);
        const secret = /<code>([^<]+)<\/code>/.exec(await begun.text())![1]!;
        assert.equal((await request('/account/totp/confirm', { method: 'POST', html: true, data: { csrf: session.csrf, code: code(secret) } })).status, 200);
        await service.close();
    }
    const missing = authTemplateNames.filter(name => !observed.has(name));
    // `/register` redirects to the verification-first signup in every registration mode; the OIDC, enrollment, impersonation and manual-recovery screens are driven by their own suites.
    assert.deepEqual(missing.sort(), ['auth/enrollment', 'auth/impersonation', 'auth/provider-enroll', 'auth/provider-second-factor', 'auth/register', 'auth/restore-access'], 'screens the walkthrough does not reach are covered by their own suites');
    for (const [name, entry] of observed) {
        assert.deepEqual([...entry.paths].sort(), ['kit', 'primitives'], `${name} rendered on both paths`);
        assert.equal(mismatch(entry.view, authTemplates[name]!.sample, name), undefined, `${name}: real view matches its sample shape`);
    }
});
test('kit-rendered pages escape user-controlled values, bind one nonce to the extension script and keep the strict headers', async (t) => {
    const { request } = await app(t, 'kit', true);
    const { csrf } = await (await request('/account/csrf')).json() as { csrf: string };
    const email = 'x<script>alert(1)</script>"onload="x@example.test';
    const page = await request('/account/identify', { method: 'POST', html: true, data: { email, csrf } });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /x&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;onload=&quot;x@example.test/);
    const nonce = /<style nonce="([A-Za-z0-9+/=]+)">/.exec(html)![1]!;
    const scripts = [...html.matchAll(/<script nonce="([^"]+)" src="([^"]+)"/g)];
    assert.deepEqual(scripts.map(match => [match[1], match[2]]), [[nonce, '/account/assets/passkeys.js']]);
    const csp = page.headers.get('content-security-policy')!;
    assert.ok(csp.includes(`script-src 'nonce-${nonce}'`) && csp.includes("default-src 'none'") && csp.includes("form-action 'self'") && csp.includes("frame-ancestors 'none'"));
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(html, /<link rel="stylesheet" href="\/assets\/ui\/static\/kit\.[0-9a-f]{12}\.css">/);
    const stylesheet = await request(/href="(\/assets\/ui\/static\/kit\.[0-9a-f]{12}\.css)"/.exec(html)![1]!);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('etag') ?? '', /^"[0-9a-f]+"$/);
    const failure = await request('/account/verify?token=a&token=b', { html: true });
    assert.equal(failure.status, 400);
    assert.match(await failure.text(), /<p role="alert" class="error">A single token is required<\/p>/);
});
function code(secret: string): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, value = 0;
    const bytes: number[] = [];
    for (const char of secret) { value = (value << 5) | alphabet.indexOf(char); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); } }
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = require_hmac(Buffer.from(bytes), counter), offset = digest.at(-1)! & 15;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
import { createHmac } from 'node:crypto';
function require_hmac(key: Buffer, counter: Buffer): Buffer { return createHmac('sha1', key).update(counter).digest(); }
async function app(t: TestContext, path: 'primitives' | 'kit', passkeys = false) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-templates-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project);
    const kit = kitSetup(path, project, '');
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: { registration: 'open' } }, ...kit.extensions }, routes: { '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] }, ...kit.routes } }));
    const projectSha256 = await inspectExtensionRevision(project), { ui, registrations } = kitSetup(path, project, projectSha256);
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'] }, defaultRole: 'member', allowPasskeySecondFactor: true, trustedDeviceTtlMs: 86400000, allowEmailFactorRecovery: true });
    const { createPasskeyProvider } = await import('../src/passkeys.ts');
    const extension = authExtension({ service, csrfKey: randomBytes(32), projectSha256, ...(ui ? { ui } : {}), ...(path === 'primitives' ? { presentation: createPresentation() } : {}), sendToken: async () => { }, sendEmailCode: async () => { }, sendFactorRecovery: async () => { }, passkeys: createPasskeyProvider({ origin: 'https://example.test', rpId: 'example.test', rpName: 'Site' }) });
    const server = await startServer({ project, origin: 'https://example.test', port: 0, extensions: [...registrations, extension], log: () => { } }).catch(async (error) => { await service.close(); throw error; });
    t.after(async () => { await server.close(); await service.close().catch(() => { }); });
    const cookies = new Map<string, string>();
    async function request(path: string, { method = 'GET', data, html = false }: { method?: string; data?: Record<string, string>; html?: boolean } = {}) {
        const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { method, redirect: 'manual', headers: { accept: html ? 'text/html' : 'application/json', ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}), ...(data ? { 'content-type': html ? 'application/x-www-form-urlencoded' : 'application/json', origin: 'https://example.test' } : {}) }, ...(data ? { body: html ? new URLSearchParams(data).toString() : JSON.stringify(data) } : {}) });
        for (const header of response.headers.getSetCookie()) {
            const first = header.split(';')[0]!, index = first.indexOf('=');
            if (header.includes('Max-Age=0')) cookies.delete(first.slice(0, index)); else cookies.set(first.slice(0, index), first.slice(index + 1));
        }
        return response;
    }
    return { request, service };
}
