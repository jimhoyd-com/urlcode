import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { cleanup } from './cleanup.ts';
import { createAuthService, internal } from '../src/auth-core.ts';
import { createAuth } from '../src/auth.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { sessionUserId, sessionIdentityHeader } from '../src/session-identity.ts';
import { kitSetup, kitYaml } from './support/render.ts';
import { siteCompanions } from './support/companions.ts';

test('sessionUserId accepts only the bounded opaque id shape, without authenticating arbitrary requests', () => {
    for (const value of [null, '', 'a,b', 'a b', '/user', 'é', 'alice\n', 'alice\r', 'a'.repeat(129), '{"id":"alice"}']) {
        assert.equal(sessionUserId({ headers: { get: () => value } }), null);
    }
    for (const value of ['a', 'user_123-abc.def:1', 'a'.repeat(128)]) {
        assert.equal(sessionUserId({ headers: { get: name => name === sessionIdentityHeader ? value : null } }), value);
    }
});

for (const sandbox of [false, true]) {
    test(`session identity reaches ordinary ${sandbox ? 'sandboxed' : 'trusted'} functions only after native authorization`, async t => {
        const root = await mkdtemp(join(tmpdir(), 'urlcode-session-identity-'));
        cleanup(t, () => rm(root, { recursive: true, force: true }));
        const project = join(root, 'project');
        await mkdir(project);
        // Exercise the exact pure accessor in both guests without granting a sandbox package import.
        await writeFile(join(project, 'identity.mjs'), stripTypeScriptTypes(await readFile(new URL('../src/session-identity.ts', import.meta.url), 'utf8')));
        await writeFile(join(project, 'handler.mjs'), `import {sessionUserId} from './identity.mjs';
export default (request) => Response.json({handled:true,userId:sessionUserId(request),cookie:request.headers.get('cookie'),authorization:request.headers.get('authorization'),csrf:request.headers.get('x-csrf-token'),bearer:request.headers.get('x-urlcode-context-auth-principal')});`);
        const handler = { function: { source: 'handler.mjs' }, sandbox, methods: ['GET', 'POST'] };
        const kit = kitYaml();
        await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ...kit.extensions, auth: { version: '1', config: { registration: 'open' } } }, routes: {
            ...kit.routes,
            '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
            '/session': { ...handler, auth: true },
            '/admin': { ...handler, auth: { role: 'admin' } },
            '/permission': { ...handler, auth: { permission: 'admin.read' } },
            '/verified': { ...handler, auth: { verified: true } },
            '/open': handler,
            '/bearer': { ...handler, auth: { bearer: { scopes: ['read'] } } },
        } }));
        const projectSha256 = await inspectExtensionRevision(project);
        const { ui, registrations } = kitSetup(project, projectSha256);
        const hosted = await siteCompanions(t, root, projectSha256, { transport: false });
        const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member' });
        const csrfKey = randomBytes(32), origin = 'https://example.test';
        const http = new AuthHttp({ csrfKey, origin });
        const extension = createAuth({ ui, service, csrfKey, projectSha256, audit: hosted.audit, mail: hosted.mail }).registration;
        const server = await startServer({ project, origin, port: 0, extensions: [...registrations, ...hosted.registrations, extension], log: () => {} }).catch(async error => { await service.close(); throw error; });
        cleanup(t, async () => { try { await server.close(); } finally { await service.close(); } });
        const password = 'correct horse battery staple';
        const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password });
        const alice = await service.register({ email: 'alice@example.test', password });
        const bob = await service.register({ email: 'bob@example.test', password });
        const call = async (path: string, token?: string, method = 'GET', extra: Record<string, string> = {}) => {
            const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { method, headers: {
                accept: 'application/json', [sessionIdentityHeader]: 'forged-user',
                ...(token ? { cookie: '__Host-urlcode-session=' + token } : {}), ...extra,
            } });
            const body = await response.json() as Record<string, unknown>;
            assert.equal(response.headers.get(sessionIdentityHeader), null);
            assert.ok(!JSON.stringify(body).includes(password));
            for (const secret of [alice.token, bob.token]) assert.ok(!JSON.stringify(body).includes(secret));
            return { status: response.status, body };
        };
        const allowed = async (path: string, token: string | undefined, expected: string | null, method = 'GET', extra: Record<string, string> = {}) => {
            const result = await call(path, token, method, extra);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            if (path !== '/bearer') assert.equal(result.body.bearer, null);
            assert.deepEqual({ ...result.body, bearer: null }, { handled: true, userId: expected, cookie: null, authorization: null, csrf: null, bearer: null });
            return result.body;
        };
        const denied = async (path: string, token: string | undefined, status: number, method = 'GET', extra: Record<string, string> = {}) => {
            const result = await call(path, token, method, extra);
            assert.equal(result.status, status, JSON.stringify(result.body));
            assert.equal(result.body.handled, undefined);
            assert.equal(result.body.userId, undefined);
            assert.ok(!JSON.stringify(result.body).includes(alice.user.id));
            assert.ok(!JSON.stringify(result.body).includes(bob.user.id));
        };
        await allowed('/open', undefined, null);
        await denied('/session', undefined, 401);
        await denied('/session', 'invalid-session', 401);
        for (const user of [alice, bob, alice]) await allowed('/session', user.token, user.user.id);
        await allowed('/open', bob.token, null); // No identity inheritance on the same runtime.
        await denied('/admin', alice.token, 403);
        await denied('/permission', alice.token, 403);
        await denied('/verified', alice.token, 403);
        await denied('/session', alice.token, 403, 'POST', { origin });
        await denied('/session', alice.token, 403, 'POST', { origin, 'x-csrf-token': http.token(bob.token) });
        await denied('/session', alice.token, 403, 'POST', { origin: 'https://foreign.test', 'x-csrf-token': http.token(alice.token) });
        await allowed('/session', alice.token, alice.user.id, 'POST', { origin, 'x-csrf-token': http.token(alice.token) });
        for (const userId of [undefined, alice.user.id]) {
            const key = await service.issueApiKey({ name: 'reader', scopes: ['read'], ...(userId ? { userId } : {}) });
            const body = await allowed('/bearer', alice.token, null, 'GET', { authorization: 'Bearer ' + key.key });
            assert.equal(JSON.parse(Buffer.from(body.bearer as string, 'base64').toString()).id, key.id);
            assert.ok(!JSON.stringify(body).includes(key.key));
        }
        await service.revokeSessions(alice.user.id);
        await denied('/session', alice.token, 401);
        await internal(service).adminSetStatus({ actorToken: admin.token, accountId: bob.user.id, status: 'locked' });
        await denied('/session', bob.token, 401);
        await allowed('/open', undefined, null);
    });
}
