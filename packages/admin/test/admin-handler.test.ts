import { cleanup } from './cleanup.ts';
import base from 'node:test';
import type { TestContext } from 'node:test';
import { activatedUi, eachRenderPath, renderOf } from './support/render.ts';
const test = (name: string, fn: (t: TestContext) => Promise<void>) => eachRenderPath(base, name, fn);
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuthHttp, createAuthService } from '@jimhoyd/urlcode-auth';
import { adminExtension } from '../src/admin.ts';
test('admin handlers create with private setup delivery, export audited data and revoke one session', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-admin-handlers-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], admin: ['*'] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' }), csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64), http = new AuthHttp({ csrfKey, origin });
    const deliveries: {
        email: string;
        token: string;
    }[] = [];
    const ui = await activatedUi(t, renderOf(t), root, projectSha256);
    const instance = await adminExtension({ service, csrfKey, projectSha256, ...(ui ? { ui } : {}), sendSetup: async (message) => { deliveries.push(message); } }).activate({}, { origin, target: 'node', projectSha256, mounts: ['/admin'], root: import.meta.dirname });
    async function post(path: string, data: Record<string, string>) { return instance.handle({ method: 'POST', target: '/admin' + path, path: '/admin' + path, query: new URLSearchParams(), headers: new Headers({ cookie: '__Host-urlcode-session=' + owner.token, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: new TextEncoder().encode(JSON.stringify({ ...data, csrf: http.token(owner.token) })), origin, route: '/admin/*', mount: '/admin', client: null }); }
    const created = await post('/users/create', { email: 'created@example.test', reason: 'approved onboarding' });
    assert.equal(created.status, 200);
    assert.equal(deliveries.length, 1);
    assert.doesNotMatch(String(created.body), new RegExp(deliveries[0]!.token));
    const user = (await service.listUsers()).users.find(value => value.email === 'created@example.test')!;
    assert.ok(user);
    assert.equal(user.emailVerified, false);
    assert.deepEqual(user.roles, ['member']);
    await service.resetPassword({ token: deliveries[0]!.token, password: 'another sufficiently long password' });
    const login = await service.login({ email: user.email, password: 'another sufficiently long password' });
    assert.equal((await post('/users/export', { accountId: user.id, reason: 'user requested export' })).status, 200);
    assert.equal((await post('/sessions/revoke-one', { sessionId: login.principal.sessionId, reason: 'compromised device' })).status, 200);
    assert.equal(await service.authenticate(login.token), null);
    assert.ok(await service.authenticate(owner.token));
    const freshUser=await service.login({email:user.email,password:'another sufficiently long password'});await service.updateProfile({token:freshUser.token,profile:{displayName:'=HYPERLINK("https://example.test")'}});
    const exportedPage=await post('/users/export-page',{query:'created@',role:'member',reason:'filtered account report'});assert.equal(exportedPage.status,200);const csv=Buffer.from(exportedPage.body??'').toString();assert.match(csv,/email_masked/);assert.match(csv,/c\*\*\*@example.test/);assert.ok(csv.includes("'=HYPERLINK"));assert.ok(!csv.includes(user.email));assert.ok(exportedPage.headers.some(([key,value])=>key==='content-type'&&value.startsWith('text/csv')));
    const denied=await post('/users/bulk',{accountIds:user.id+','+owner.user.id,action:'lock',confirmation:'LOCK 2',reason:'must be atomic'});assert.notEqual(denied.status,200);assert.equal((await service.getUser(user.id))?.status,'active');
    assert.equal((await post('/users/bulk',{accountIds:user.id,action:'lock',confirmation:'LOCK 2',reason:'wrong confirmation'})).status,400);assert.equal((await service.getUser(user.id))?.status,'active');
    assert.equal((await post('/users/bulk',{accountIds:user.id,action:'lock',confirmation:'LOCK 1',reason:'confirmed action'})).status,200);assert.equal((await service.getUser(user.id))?.status,'locked');
    assert.equal((await post('/users/bulk',{['selected.'+user.id]:'yes',action:'unlock',confirmation:'UNLOCK 1',reason:'native checkbox selection'})).status,200);assert.equal((await service.getUser(user.id))?.status,'active');

});
