// A support (impersonation) session is visible on every route an auth session policy guards: auth's middleware adds
// the banner and keeps the response out of every cache; auth's own pages show the notice as a flash.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, HandlerResult } from '@jimhoyd/urlcode/extensions';
import { createAuthService, internal } from '../src/auth-core.ts';
import { supportSessionResponse } from '../src/support-session.ts';
import { kitSetup, kitYaml, bodyText } from './support/render.ts';
import { siteCompanions, withCompanions } from './support/companions.ts';

const banner = { message: 'Support <script>', endLabel: 'End & return', href: '/account/account' };
const request = (method = 'GET', headers: Record<string, string> = {}): ExtensionRequest => ({ method, target: '/app', path: '/app', query: new URLSearchParams(), headers: new Headers(headers), headerCounts: {}, body: new Uint8Array(), origin: 'https://example.test', route: '/app', mount: null, client: null, requestId: 'support', env: {} });

test('a support session response carries the escaped banner, no validators and no cache', async () => {
    const incoming = request('GET', { 'if-none-match': 'old', 'accept-encoding': 'gzip', range: 'bytes=0-1' });
    const result = await supportSessionResponse(incoming, async () => ({ status: 200, headers: [['content-type', 'text/html'], ['etag', 'old'], ['cache-control', 'public'], ['content-length', '5']], contentLength: 5, body: '<!doctype html><html><body><p>App</p></body></html>' }), banner);
    assert.equal(incoming.headers.has('if-none-match'), false);
    assert.equal(incoming.headers.has('accept-encoding'), false);
    assert.equal(incoming.headers.has('range'), false);
    const html = bodyText(result.body);
    assert.match(html, /<body><aside role="alert" aria-label="Support session" id="urlcode-support-banner"><strong>Support &lt;script&gt;<\/strong> <a href="\/account\/account">End &amp; return<\/a><\/aside><p>App/);
    assert.ok(!result.headers.some(([name]) => ['etag', 'content-length'].includes(name)));
    assert.equal(result.contentLength, undefined);
    assert.deepEqual(result.headers.filter(([name]) => ['cache-control', 'cdn-cache-control', 'x-urlcode-support-session'].includes(name)), [['cache-control', 'no-store'], ['cdn-cache-control', 'no-store'], ['x-urlcode-support-session', 'active']]);
});

test('a support session never gets HTML it cannot mark: encoded, undecodable or 304 answers become a 409 page', async () => {
    for (const answer of [{ status: 200, headers: [['content-type', 'text/html'], ['content-encoding', 'gzip']], body: new Uint8Array([0xff]) }, { status: 200, headers: [['content-type', 'text/html']], body: new Uint8Array([0xff, 0xfe]) }, { status: 304, headers: [['content-type', 'text/html']], body: '' }] as HandlerResult[]) {
        const guarded = await supportSessionResponse(request(), async () => answer, banner);
        assert.equal(guarded.status, 409);
        assert.match(bodyText(guarded.body), /urlcode-support-banner/);
    }
    // An HTML error page is marked too; JSON and HEAD answers only lose their cacheability.
    assert.match(bodyText((await supportSessionResponse(request(), async () => ({ status: 500, headers: [['content-type', 'text/html']], body: '<body>Error</body>' }), banner)).body), /urlcode-support-banner/);
    const json = await supportSessionResponse(request(), async () => ({ status: 200, headers: [['content-type', 'application/json']], body: '{}' }), banner);
    assert.equal(json.body, '{}');
    assert.ok(json.headers.some(([name, value]) => name === 'x-urlcode-support-session' && value === 'active'));
    const head = await supportSessionResponse(request('HEAD'), async () => ({ status: 200, headers: [['content-type', 'text/html']], body: '' }), banner);
    assert.equal(head.body, '');
});

test('every auth session route shows a support session its banner, auth\'s pages a flash, and an ordinary session nothing', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-support-session-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project);
    const kit = kitYaml();
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ...kit.extensions, auth: { version: '1', config: { registration: 'open' } } }, routes: {
        '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
        '/app': { respond: { text: '<!doctype html><html><body><h1>Application</h1></body></html>' }, response: { headers: { 'content-type': 'text/html; charset=utf-8' } }, auth: true },
        '/public': { respond: { text: '<!doctype html><html><body><h1>Public</h1></body></html>' }, response: { headers: { 'content-type': 'text/html; charset=utf-8' } } },
        ...kit.routes,
    } }));
    const projectSha256 = await inspectExtensionRevision(project), { ui, registrations } = kitSetup(project, projectSha256);
    const service = internal(await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], admin: ['*'] }, defaultRole: 'member', allowImpersonation: true }));
    cleanup(t, () => service.close());
    const hosted = await siteCompanions(t, root, projectSha256), authExtension = withCompanions(hosted);
    const server = await startServer({ project, origin: 'https://example.test', port: 0, extensions: [...registrations, ...hosted.registrations, authExtension({ service, csrfKey: randomBytes(32), projectSha256, ui })], log: () => {} });
    cleanup(t, () => server.close());
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' }), member = await service.register({ email: 'member@example.test', password: 'correct horse battery staple' });
    const support = await service.createImpersonation({ actorToken: admin.token, accountId: member.user.id, reason: 'Ticket 7' });
    const get = (path: string, token: string) => fetch(`http://127.0.0.1:${server.address.port}${path}`, { headers: { accept: 'text/html', cookie: '__Host-urlcode-session=' + token } });
    const supported = await get('/app', support.token), html = await supported.text();
    assert.equal(supported.status, 200);
    assert.match(html, /<body><aside role="alert" aria-label="Support session" id="urlcode-support-banner"><strong>Support impersonation is active\. Security changes are disabled\.<\/strong> <a href="\/account\/account">End support session<\/a><\/aside><h1>Application/);
    assert.equal(supported.headers.get('x-urlcode-support-session'), 'active');
    assert.equal(supported.headers.get('cache-control'), 'no-store');
    const ordinary = await get('/app', member.token);
    assert.doesNotMatch(await ordinary.text(), /urlcode-support-banner/);
    assert.equal(ordinary.headers.get('x-urlcode-support-session'), null);
    // A route without an auth policy never resolves the session, so it has nothing account-specific to mark.
    assert.doesNotMatch(await (await get('/public', support.token)).text(), /urlcode-support-banner/);
    // Auth's own pages show the notice through the kit's flash.
    assert.match(await (await get('/account/sessions', support.token)).text(), /Support impersonation is active\. Security changes are disabled\./);
    assert.doesNotMatch(await (await get('/account/sessions', member.token)).text(), /Support impersonation is active/);
});
