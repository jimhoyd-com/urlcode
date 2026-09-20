import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AuthHttp, createAuthService } from '@jimhoyd/urlcode-auth';
import type { AuthService } from '@jimhoyd/urlcode-auth';
import { prepareExtensions } from '@jimhoyd/urlcode/extensions';
import { adminExtension } from '../src/admin.ts';
import { testUiHost } from './support/render.ts';
const ui = testUiHost();
import * as roleChangeHook from './fixtures/hooks/role-change.mjs';
import * as registrationApprovedHook from './fixtures/hooks/registration-approved.mjs';
import * as accountStatusHook from './fixtures/hooks/account-status.mjs';

const origin = 'https://example.test', projectSha256 = 'a'.repeat(64), csrfKey = randomBytes(32), http = new AuthHttp({ origin, csrfKey });
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'hooks');

/** Activates admin with the given `hooks` config against the fixtures directory as `root`, and returns a JSON POST/GET client. */
function client(service: AuthService, hooksConfig: Record<string, unknown> | undefined, root = fixtureRoot) {
    const activation = Promise.resolve(adminExtension({ service, csrfKey, projectSha256, ui }).activate({ ...(hooksConfig ? { hooks: hooksConfig } : {}) }, { origin, target: 'node', projectSha256, mounts: ['/admin'], root }));
    return { activation, call: async (method: string, path: string, token: string, fields?: Record<string, string>) => {
        const instance = await activation;
        return instance.handle({ method, target: '/admin' + path, path: '/admin' + path, query: new URLSearchParams(), headers: new Headers({ cookie: '__Host-urlcode-session=' + token, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: fields ? new TextEncoder().encode(JSON.stringify({ ...fields, csrf: http.token(token) })) : new Uint8Array(), origin, route: '/admin/*', mount: '/admin', client: null });
    } };
}

async function withService(t: import('node:test').TestContext, registrationMode: 'open' | 'waitlist' = 'open') {
    const root = await mkdtemp(join(tmpdir(), 'admin-hooks-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], reader: ['auth.users.read'], admin: ['*'] }, defaultRole: 'member', registrationMode });
    cleanup(t, () => service.close());
    return service;
}

test('beforeRoleChange fires with the typed input and can allow the change through', async t => {
    const service = await withService(t);
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const target = await service.register({ email: 'target@example.test', password: 'another sufficiently long password' });
    roleChangeHook.calls.length = 0;
    roleChangeHook.setNextVerdict({ allow: true });
    const { call } = client(service, { beforeRoleChange: { source: './role-change.mjs' } });
    const response = await call('POST', '/users/roles', owner.token, { accountId: target.user.id, roles: 'reader', reason: 'grant read access' });
    assert.equal(response.status, 200);
    assert.deepEqual((await service.getUser(target.user.id))!.roles, ['reader']);
    assert.equal(roleChangeHook.calls.length, 1);
    assert.deepEqual(roleChangeHook.calls[0], { accountId: target.user.id, currentRoles: ['member'], requestedRoles: ['reader'], actorId: owner.user.id, reason: 'grant read access' });
});

test('beforeRoleChange can veto: the role change never reaches the auth service', async t => {
    const service = await withService(t);
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const target = await service.register({ email: 'target@example.test', password: 'another sufficiently long password' });
    roleChangeHook.calls.length = 0;
    roleChangeHook.setNextVerdict({ allow: false, reason: 'blocked by project policy' });
    const { call } = client(service, { beforeRoleChange: { source: './role-change.mjs' } });
    const response = await call('POST', '/users/roles', owner.token, { accountId: target.user.id, roles: 'admin', reason: 'attempted escalation' });
    assert.equal(response.status, 403);
    assert.match(Buffer.from(response.body ?? '').toString(), /blocked by project policy/);
    assert.deepEqual((await service.getUser(target.user.id))!.roles, ['member']);
    assert.equal(roleChangeHook.calls.length, 1);
    roleChangeHook.setNextVerdict({ allow: true });
});

test('onRegistrationApproved fires after approval, via a named export, with the typed input', async t => {
    const service = await withService(t, 'waitlist');
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const requested = await service.requestRegistration({ email: 'waiting@example.test', password: 'another sufficiently long password' });
    registrationApprovedHook.calls.length = 0;
    const { call } = client(service, { onRegistrationApproved: { source: './registration-approved.mjs', export: 'onApproved' } });
    const response = await call('POST', '/registrations/approve', owner.token, { requestId: requested.id, reason: 'reviewed and approved' });
    assert.equal(response.status, 200);
    assert.equal(registrationApprovedHook.calls.length, 1);
    const approvedUser = (await service.listUsers()).users.find(user => user.email === 'waiting@example.test')!;
    assert.ok(approvedUser);
    assert.deepEqual(registrationApprovedHook.calls[0], { requestId: requested.id, accountId: approvedUser.id, email: 'waiting@example.test', actorId: owner.user.id, reason: 'reviewed and approved' });
});

test('onAccountStatusChanged fires after a lock/unlock with the typed input', async t => {
    const service = await withService(t);
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const target = await service.register({ email: 'target2@example.test', password: 'another sufficiently long password' });
    accountStatusHook.calls.length = 0;
    const { call } = client(service, { onAccountStatusChanged: './account-status.mjs' });
    const response = await call('POST', '/users/status', owner.token, { accountId: target.user.id, status: 'locked', reason: 'suspicious activity' });
    assert.equal(response.status, 200);
    assert.equal((await service.getUser(target.user.id))!.status, 'locked');
    assert.equal(accountStatusHook.calls.length, 1);
    assert.deepEqual(accountStatusHook.calls[0], { accountId: target.user.id, status: 'locked', actorId: owner.user.id, reason: 'suspicious activity' });
});

test('a missing hook module fails activation, not the first request', async t => {
    const service = await withService(t);
    const { activation } = client(service, { onAccountStatusChanged: { source: './does-not-exist.mjs' } });
    await assert.rejects(activation, /hook onAccountStatusChanged.*failed to load module/s);
});

test('a hook module whose named export is not a function fails activation', async t => {
    const service = await withService(t);
    const { activation } = client(service, { onAccountStatusChanged: { source: './not-a-function.mjs' } });
    await assert.rejects(activation, /hook onAccountStatusChanged.*is not a function/s);
});

test('sandbox: true on a hook is rejected explicitly at activation, never silently ignored', async t => {
    const service = await withService(t);
    const { activation } = client(service, { beforeRoleChange: { source: './role-change.mjs', sandbox: true } });
    await assert.rejects(activation, /hook beforeRoleChange: sandbox: true is not yet supported for project-level hooks, see jimhoyd-com\/urlcode-admin#32/);
});

// jimhoyd-com/urlcode#198: Node's ESM loader caches a resolved module forever
// by URL, so a second activation in the same process used to keep serving the
// hook code that was on disk at the first one. Activation now re-imports the
// hook's entry module under a fresh cache-busting query, the same way core's
// trusted route activation does. Only the entry module is refreshed — modules
// the hook itself imports stay on Node's module cache.
test('re-activating in the same process picks up an edited hook entry module', async t => {
    const service = await withService(t);
    const owner = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const target = await service.register({ email: 'target@example.test', password: 'another sufficiently long password' });
    const root = await mkdtemp(join(tmpdir(), 'admin-hooks-reload-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const hook = join(root, 'role-change.mjs');
    async function activateAndAttemptRoleChange() {
        const { call } = client(service, { beforeRoleChange: { source: './role-change.mjs' } }, root);
        const response = await call('POST', '/users/roles', owner.token, { accountId: target.user.id, roles: 'reader', reason: 'grant read access' });
        assert.equal(response.status, 403);
        return Buffer.from(response.body ?? '').toString();
    }
    await writeFile(hook, 'export default function beforeRoleChange() { return { allow: false, reason: "v1" }; }\n');
    assert.match(await activateAndAttemptRoleChange(), /v1/);
    await writeFile(hook, 'export default function beforeRoleChange() { return { allow: false, reason: "v2" }; }\n');
    assert.match(await activateAndAttemptRoleChange(), /v2/);
    assert.deepEqual((await service.getUser(target.user.id))!.roles, ['member']);
});

/** Exercises core's own `prepareExtensions`, which ajv-validates `config` against the extension's declared `schema` before `activate()` ever runs — the real validation path, not a hand-rolled stand-in. */
function prepared(service: AuthService, hooksConfig: Record<string, unknown>) {
    const registration = adminExtension({ service, csrfKey, projectSha256, ui });
    const document = { extensions: { admin: { version: '1' as const, config: { hooks: hooksConfig } } } };
    const routes = { '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] } };
    return prepareExtensions(document as never, routes as never, [registration], { origin, target: 'node', projectSha256, root: fixtureRoot }).activate();
}

test('the ajv config schema (validated by core before activate()) rejects an unknown hooks key and a malformed hook definition', async t => {
    const service = await withService(t);
    const accepted = await prepared(service, { onAccountStatusChanged: './account-status.mjs' });
    cleanup(t, () => accepted.close());
    // prepareExtensions ajv-validates synchronously before ever returning `.activate()`'s
    // promise, so an invalid config throws immediately: assert.throws, not assert.rejects.
    assert.throws(() => prepared(service, { notARealHook: './x.mjs' }), /Invalid extension configuration: admin/);
    assert.throws(() => prepared(service, { beforeRoleChange: { export: 'default' } }), /Invalid extension configuration: admin/);
});
