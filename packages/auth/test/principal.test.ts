import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { installPrincipalSlot } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import { createAuthService } from '../src/auth-core.ts';
import { apiKeyPrincipalId, authExtension } from '../src/auth.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { activatedUi } from './support/render.ts';
// urlcode#331: auth declares providesPrincipal and, from authorize(), hands core's opaque request principal the
// session's stable user id, or `apikey:<key id>` for a bearer key, only on a request it allows.
test('auth sets the core principal to the user id for a session and apikey:<id> for a bearer key, and only when it allows', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-principal-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64), http = new AuthHttp({ csrfKey, origin });
    const ui = await activatedUi(t, import.meta.dirname, projectSha256, origin);
    const registration = authExtension({ service, csrfKey, projectSha256, ui });
    assert.equal(registration.providesPrincipal, true);
    const instance = await registration.activate({ registration: 'open' }, { origin, target: 'node', projectSha256, mounts: ['/account'], root: import.meta.dirname });
    const request = (method: string, headers: Record<string, string>): ExtensionRequest => ({ method, target: '/api/notes', path: '/api/notes', query: new URLSearchParams(), headers: new Headers(headers), headerCounts: Object.fromEntries(Object.keys(headers).map(name => [name, 1])), body: new Uint8Array(), origin, route: '/api/notes/*', mount: '/api/notes', client: null, requestId: 'test-request', env: {} });
    const principalOf = async (requirement: Record<string, unknown>, value: ExtensionRequest) => {
        const slot = installPrincipalSlot(value);
        const result = await slot.authorize('auth', true, () => instance.authorize!(requirement, value));
        return { status: result?.status, principal: value.principal };
    };
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password: 'correct horse battery staple' });
    const alice = await service.register({ email: 'alice@example.test', password: 'correct horse battery staple' });
    const cookie = '__Host-urlcode-session=' + alice.token;
    // Session: the stable user id, never the email, and frozen with core's provider stamp.
    const read = await principalOf({}, request('GET', { cookie }));
    assert.equal(read.status, undefined);
    assert.deepEqual(read.principal, { id: alice.user.id, provider: 'auth' });
    assert.ok(!JSON.stringify(read.principal).includes('alice@'));
    // A write needs the CSRF check to pass before any principal is set.
    assert.deepEqual((await principalOf({}, request('POST', { cookie, origin, 'x-csrf-token': http.token(alice.token) }))).principal, { id: alice.user.id, provider: 'auth' });
    const forged = await principalOf({}, request('POST', { cookie, origin }));
    assert.equal(forged.status, 403); assert.equal(forged.principal, null);
    // No session, a bogus one, or a requirement the user does not meet: denied, no principal.
    for (const headers of [{}, { cookie: '__Host-urlcode-session=' + 'x'.repeat(43) }]) {
        const denied = await principalOf({}, request('GET', headers));
        assert.equal(denied.status, 401); assert.equal(denied.principal, null);
    }
    const wrongRole = await principalOf({ role: 'admin' }, request('GET', { cookie }));
    assert.equal(wrongRole.status, 403); assert.equal(wrongRole.principal, null);
    // Bearer: the key is the principal (operator-issued keys have no owning user), namespaced apart from user ids.
    const key = await service.issueApiKey({ name: 'agent', scopes: ['notes.read'] });
    const bearer = await principalOf({ bearer: { scopes: ['notes.read'] } }, request('GET', { authorization: 'Bearer ' + key.key }));
    assert.equal(bearer.status, undefined);
    assert.deepEqual(bearer.principal, { id: apiKeyPrincipalId(key.id), provider: 'auth' });
    assert.equal(apiKeyPrincipalId(key.id), 'apikey:' + key.id);
    const scoped = await principalOf({ bearer: { scopes: ['notes.write'] } }, request('GET', { authorization: 'Bearer ' + key.key }));
    assert.equal(scoped.status, 403); assert.equal(scoped.principal, null);
    // A cookie on a bearer route does not give a principal either.
    const cookieOnBearer = await principalOf({ bearer: { scopes: ['notes.read'] } }, request('GET', { cookie }));
    assert.equal(cookieOnBearer.status, 401); assert.equal(cookieOnBearer.principal, null);
    // urlcode#732: a key issued for a user acts for that user, so records survive rotating the key, but only within the
    // key's own scopes: alice's session role does not widen it. Locking alice disables it.
    const linked = await service.issueApiKey({ name: 'alice-agent', scopes: ['notes.read'], userId: alice.user.id });
    const acting = await principalOf({ bearer: { scopes: ['notes.read'] } }, request('GET', { authorization: 'Bearer ' + linked.key }));
    assert.equal(acting.status, undefined);
    assert.deepEqual(acting.principal, { id: alice.user.id, provider: 'auth' });
    const linkedRequest = request('GET', { authorization: 'Bearer ' + linked.key });
    await principalOf({ bearer: { scopes: ['notes.read'] } }, linkedRequest);
    assert.deepEqual(JSON.parse(Buffer.from(linkedRequest.headers.get('x-urlcode-context-auth-principal')!, 'base64').toString()), { id: linked.id, name: 'alice-agent', scopes: ['notes.read'], userId: alice.user.id });
    const rotated = await service.issueApiKey({ name: 'alice-agent-2', scopes: ['notes.read'], userId: alice.user.id });
    await service.revokeApiKey(linked.id);
    assert.deepEqual((await principalOf({ bearer: { scopes: ['notes.read'] } }, request('GET', { authorization: 'Bearer ' + rotated.key }))).principal, { id: alice.user.id, provider: 'auth' });
    const beyondScopes = await principalOf({ bearer: { scopes: ['notes.write'] } }, request('GET', { authorization: 'Bearer ' + rotated.key }));
    assert.equal(beyondScopes.status, 403); assert.equal(beyondScopes.principal, null);
    // Service keys are unchanged: the unlinked key's header carries no userId.
    const serviceRequest = request('GET', { authorization: 'Bearer ' + key.key });
    await principalOf({ bearer: { scopes: ['notes.read'] } }, serviceRequest);
    assert.ok(!('userId' in JSON.parse(Buffer.from(serviceRequest.headers.get('x-urlcode-context-auth-principal')!, 'base64').toString())));
    await service.adminSetStatus({ actorToken: admin.token, accountId: alice.user.id, status: 'locked' });
    const locked = await principalOf({ bearer: { scopes: ['notes.read'] } }, request('GET', { authorization: 'Bearer ' + rotated.key }));
    assert.equal(locked.status, 401); assert.equal(locked.principal, null);
    // A revoked key stops producing a principal on the next request.
    await service.revokeApiKey(key.id);
    assert.equal((await principalOf({ bearer: { scopes: ['notes.read'] } }, request('GET', { authorization: 'Bearer ' + key.key }))).principal, null);
});
