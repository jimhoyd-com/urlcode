import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { createAuthService, authExtension } from '@jimhoyd/urlcode-auth';
import { adminExtension } from '../src/admin.ts';
import { kitSetup } from './support/render.ts';
test('admin console uses explicit permissions, masks identifiers and rejects forged or self-changing mutations', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-admin-http-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project);
    const blocks = kitSetup(project, '');
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ...blocks.extensions, auth: { version: '1', config: { registration: 'open' } }, admin: { version: '1', config: {} } }, routes: { ...blocks.routes, '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] }, '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] } } }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], support: ['auth.users.read'], admin: ['*'] }, defaultRole: 'member', allowImpersonation: true });
    const bootstrap = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const member = await service.register({ email: 'member@example.test', password: 'correct horse battery staple' });
    const csrfKey = randomBytes(32), projectSha256 = await inspectExtensionRevision(project), { ui, registrations } = kitSetup(project, projectSha256);
    const server = await startServer({ project, origin: 'https://example.test', port: 0, extensions: [...registrations, authExtension({ service, csrfKey, projectSha256, ui: ui! }), adminExtension({ service, csrfKey, projectSha256, ui: ui!, notifyImpersonation: async () => { } })], log: () => { } }).catch(async (error) => { await service.close(); throw error; });
    cleanup(t, async () => { try { await server.close(); } finally { await service.close(); } });
    async function request(path: string, token?: string, body?: Record<string, string>, origin = 'https://example.test') {
        return fetch(`http://127.0.0.1:${server.address.port}${path}`, { method: body ? 'POST' : 'GET', headers: { accept: 'application/json', ...(token ? { cookie: `__Host-urlcode-session=${token}` } : {}), ...(body ? { 'content-type': 'application/json', origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual' });
    }
    assert.equal((await request('/admin')).status, 404);
    assert.equal((await request('/admin', member.token)).status, 404);
    const owner = await service.login({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const listing = await request('/admin/users', owner.token);
    assert.equal(listing.status, 200);
    const list = await listing.json() as {
        users: {
            email: string;
        }[];
        csrf: string;
    };
    assert.ok(list.users.every(user => user.email.includes('***')));
    const forged = await request('/admin/users/status', owner.token, { accountId: member.user.id, status: 'locked', reason: 'test', csrf: list.csrf }, 'https://evil.test');
    assert.equal(forged.status, 403);
    const self = await request('/admin/users/status', owner.token, { accountId: owner.user.id, status: 'locked', reason: 'test', csrf: list.csrf });
    assert.equal(self.status, 403);
    const locked = await request('/admin/users/status', owner.token, { accountId: member.user.id, status: 'locked', reason: 'test', csrf: list.csrf });
    assert.equal(locked.status, 200);
    assert.equal((await service.getUser(member.user.id))?.status, 'locked');
    assert.equal((await request('/admin/audit', owner.token)).status, 200);
    const checker = await service.register({ email: 'checker@example.test', password: 'correct horse battery staple' });
    await service.adminSetRoles({ actorToken: owner.token, accountId: checker.user.id, roles: ['admin'] });
    const reviewer = await service.login({ email: 'checker@example.test', password: 'correct horse battery staple' });
    const created = await request('/admin/cases/create', owner.token, { accountId: member.user.id, action: 'unlock', reason: 'restore access with review', csrf: list.csrf });
    assert.equal(created.status, 200);
    const cases = await (await request('/admin/cases', owner.token)).json() as {
        cases: {
            id: string;
        }[];
    };
    const caseId = cases.cases[0]!.id;
    assert.equal((await request('/admin/cases/approve', owner.token, { caseId, reason: 'self approval forbidden', csrf: list.csrf })).status, 403);
    const review = await (await request('/admin', reviewer.token)).json() as {
        csrf: string;
    };
    assert.equal((await request('/admin/cases/approve', reviewer.token, { caseId, reason: 'independent reviewed approval', csrf: review.csrf })).status, 200);
    assert.equal((await service.getUser(member.user.id))?.status, 'active');
    const impersonation = await request('/admin/impersonate', owner.token, { accountId: member.user.id, reason: 'support requested by customer', csrf: list.csrf });
    assert.equal(impersonation.status, 303);
    const impersonationToken = impersonation.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-urlcode-session='))!.split(';')[0]!.split('=')[1]!;
    const account = await (await request('/account/account', impersonationToken)).json() as {
        csrf: string;
        impersonatorId: string;
    };
    assert.equal(account.impersonatorId, owner.user.id);
    assert.equal((await request('/admin', impersonationToken)).status, 404);
    assert.equal((await request('/account/revoke-sessions', impersonationToken, { csrf: account.csrf })).status, 403);
    assert.equal((await request('/account/logout', impersonationToken, { csrf: account.csrf })).status, 200);
    assert.ok(bootstrap);
});
