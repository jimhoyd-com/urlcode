import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createAuthService } from '../src/auth-core.ts';
import { authExtension } from '../src/auth.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { activatedUi } from './support/render.ts';

test('beforeRegister denies a registration and surfaces the hook reason', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'before-register.mjs'), 'export default function beforeRegister(input) { return { allow: input.email.endsWith("@acme.com"), reason: "Only @acme.com may register" }; }\n');
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, root, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui }).activate({ registration: 'open', hooks: { beforeRegister: { source: './before-register.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
    const csrfResponse = await instance.handle({ method: 'GET', target: '/account/csrf', path: '/account/csrf', query: new URLSearchParams(), headers: new Headers({ origin, accept: 'application/json' }), headerCounts: {}, body: new Uint8Array(), origin, route: '/account/*', mount: '/account', client: null });
    const flowCookie = (csrfResponse.headers || []).find(([name]) => name === 'set-cookie')![1]!.split(';')[0]!;
    const csrf = (JSON.parse(new TextDecoder().decode(csrfResponse.body as Uint8Array)) as { csrf: string }).csrf;
    async function register(email: string) {
        return instance.handle({ method: 'POST', target: '/account/register', path: '/account/register', query: new URLSearchParams(), headers: new Headers({ cookie: flowCookie, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: {}, body: new TextEncoder().encode(JSON.stringify({ email, password: 'correct horse battery staple', csrf })), origin, route: '/account/*', mount: '/account', client: null });
    }
    const denied = await register('outsider@example.test');
    assert.equal(denied.status, 403);
    assert.equal((JSON.parse(new TextDecoder().decode(denied.body as Uint8Array)) as { error: string }).error, 'Only @acme.com may register');
    assert.equal((await service.listUsers()).users.length, 0);
});

test('beforeRegister allows a matching registration through and onSignUp fires only after it succeeds', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'before-register.mjs'), 'export default function beforeRegister(input) { return { allow: input.email.endsWith("@acme.com") }; }\n');
    const marker = join(root, 'calls.json');
    await writeFile(marker, '[]');
    await writeFile(join(root, 'on-signup.mjs'), `
import { readFile, writeFile } from 'node:fs/promises';
export default async function onSignUp(input) {
  const calls = JSON.parse(await readFile(${JSON.stringify(marker)}, 'utf8'));
  calls.push(input);
  await writeFile(${JSON.stringify(marker)}, JSON.stringify(calls));
}
`);
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, root, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui }).activate({ registration: 'open', hooks: { beforeRegister: { source: './before-register.mjs' }, onSignUp: { source: './on-signup.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
    const csrfResponse = await instance.handle({ method: 'GET', target: '/account/csrf', path: '/account/csrf', query: new URLSearchParams(), headers: new Headers({ origin, accept: 'application/json' }), headerCounts: {}, body: new Uint8Array(), origin, route: '/account/*', mount: '/account', client: null });
    const flowCookie = (csrfResponse.headers || []).find(([name]) => name === 'set-cookie')![1]!.split(';')[0]!;
    const csrf = (JSON.parse(new TextDecoder().decode(csrfResponse.body as Uint8Array)) as { csrf: string }).csrf;
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), []);
    // Outside the allowed domain: beforeRegister denies, so onSignUp must not fire.
    const denied = await instance.handle({ method: 'POST', target: '/account/register', path: '/account/register', query: new URLSearchParams(), headers: new Headers({ cookie: flowCookie, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: {}, body: new TextEncoder().encode(JSON.stringify({ email: 'outsider@example.test', password: 'correct horse battery staple', csrf })), origin, route: '/account/*', mount: '/account', client: null });
    assert.equal(denied.status, 403);
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), []);
    const allowed = await instance.handle({ method: 'POST', target: '/account/register', path: '/account/register', query: new URLSearchParams(), headers: new Headers({ cookie: flowCookie, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: {}, body: new TextEncoder().encode(JSON.stringify({ email: 'staff@acme.com', password: 'correct horse battery staple', csrf })), origin, route: '/account/*', mount: '/account', client: null });
    assert.equal(allowed.status, 201);
    assert.equal((await service.listUsers()).users.length, 1);
    const calls = JSON.parse(await readFile(marker, 'utf8')) as { accountId: string; email: string }[];
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.email, 'staff@acme.com');
    assert.equal(calls[0]!.accountId, (await service.listUsers()).users[0]!.id);
});

test('onDelete fires after a self-service account deletion is scheduled', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const markerFile = join(root, 'calls.json');
    await writeFile(markerFile, '[]');
    await writeFile(join(root, 'on-delete.mjs'), `
import { readFile, writeFile } from 'node:fs/promises';
export default async function onDelete(input) {
  const calls = JSON.parse(await readFile(${JSON.stringify(markerFile)}, 'utf8'));
  calls.push(input);
  await writeFile(${JSON.stringify(markerFile)}, JSON.stringify(calls));
}
`);
    const delivered: { email: string }[] = [];
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64), http = new AuthHttp({ csrfKey, origin });
    const ui = await activatedUi(t, root, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui, sendToken: async (message: { email: string }) => { delivered.push(message); } }).activate({ registration: 'open', hooks: { onDelete: { source: './on-delete.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
    const user = await service.register({ email: 'leaving@example.test', password: 'correct horse battery staple' });
    const csrf = http.token(user.token);
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(JSON.parse(await readFile(markerFile, 'utf8')), []);
    const response = await instance.handle({ method: 'POST', target: '/account/delete', path: '/account/delete', query: new URLSearchParams(), headers: new Headers({ cookie: '__Host-urlcode-session=' + user.token, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: {}, body: new TextEncoder().encode(JSON.stringify({ csrf, confirmation: 'DELETE', password: 'correct horse battery staple' })), origin, route: '/account/*', mount: '/account', client: null });
    assert.equal(response.status, 200);
    assert.equal(delivered.length, 1);
    const calls = JSON.parse(await readFile(markerFile, 'utf8')) as { accountId: string; email: string }[];
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.email, 'leaving@example.test');
    assert.equal(calls[0]!.accountId, user.user.id);
});

test('a missing hook module fails activation, not the first request', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, root, projectSha256, origin);
    await assert.rejects(Promise.resolve(authExtension({ service, csrfKey, projectSha256, ui }).activate({ registration: 'open', hooks: { beforeRegister: { source: './does-not-exist.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root })), /beforeRegister/);
});

test('a hook module with a broken export fails activation, not the first request', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'broken.mjs'), 'export const notTheDefault = 1;\n');
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, root, projectSha256, origin);
    await assert.rejects(Promise.resolve(authExtension({ service, csrfKey, projectSha256, ui }).activate({ registration: 'open', hooks: { onSignUp: { source: './broken.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root })), /onSignUp/);
});

test('sandbox: true on a hook is rejected explicitly at activation, never silently ignored', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'before-register.mjs'), 'export default function beforeRegister() { return { allow: true }; }\n');
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, root, projectSha256, origin);
    await assert.rejects(Promise.resolve(authExtension({ service, csrfKey, projectSha256, ui }).activate({ registration: 'open', hooks: { beforeRegister: { source: './before-register.mjs', sandbox: true } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root })), /sandbox: true is not supported for extension hooks; hooks run trusted by default/);
});

// jimhoyd-com/urlcode#198: Node's ESM loader caches a resolved module forever
// by URL, so a second activation in the same process used to keep serving the
// hook code that was on disk at the first one. Activation now re-imports the
// hook's entry module under a fresh cache-busting query, the same way core's
// trusted route activation does. Only the entry module is refreshed here —
// modules the hook itself imports stay on Node's module cache.
test('re-activating in the same process picks up an edited hook entry module', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const hook = join(root, 'before-register.mjs');
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, root, projectSha256, origin);
    async function activateAndRegister() {
        const instance = await authExtension({ service, csrfKey, projectSha256, ui }).activate({ registration: 'open', hooks: { beforeRegister: { source: './before-register.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
        const csrfResponse = await instance.handle({ method: 'GET', target: '/account/csrf', path: '/account/csrf', query: new URLSearchParams(), headers: new Headers({ origin, accept: 'application/json' }), headerCounts: {}, body: new Uint8Array(), origin, route: '/account/*', mount: '/account', client: null });
        const flowCookie = (csrfResponse.headers || []).find(([name]) => name === 'set-cookie')![1]!.split(';')[0]!;
        const csrf = (JSON.parse(new TextDecoder().decode(csrfResponse.body as Uint8Array)) as { csrf: string }).csrf;
        const denied = await instance.handle({ method: 'POST', target: '/account/register', path: '/account/register', query: new URLSearchParams(), headers: new Headers({ cookie: flowCookie, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: {}, body: new TextEncoder().encode(JSON.stringify({ email: 'outsider@example.test', password: 'correct horse battery staple', csrf })), origin, route: '/account/*', mount: '/account', client: null });
        assert.equal(denied.status, 403);
        return (JSON.parse(new TextDecoder().decode(denied.body as Uint8Array)) as { error: string }).error;
    }
    await writeFile(hook, 'export default function beforeRegister() { return { allow: false, reason: "v1" }; }\n');
    assert.equal(await activateAndRegister(), 'v1');
    await writeFile(hook, 'export default function beforeRegister() { return { allow: false, reason: "v2" }; }\n');
    assert.equal(await activateAndRegister(), 'v2');
    assert.equal((await service.listUsers()).users.length, 0);
});

// A post-action hook runs after the operation has already committed, so throwing from one cannot undo
// it; it only replaces the success response. Locked down here so the "keep post-action hooks
// non-throwing" rule in docs/COMPOSING-A-SITE.md is a tested property rather than advice.
test('a throwing onSignUp fails the response after the account has already been created', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'on-signup.mjs'), 'export default function onSignUp() { throw new Error("provisioning backend down"); }\n');
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const ui = await activatedUi(t, root, projectSha256, origin);
    const instance = await authExtension({ service, csrfKey, projectSha256, ui }).activate({ registration: 'open', hooks: { onSignUp: { source: './on-signup.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
    const csrfResponse = await instance.handle({ method: 'GET', target: '/account/csrf', path: '/account/csrf', query: new URLSearchParams(), headers: new Headers({ origin, accept: 'application/json' }), headerCounts: {}, body: new Uint8Array(), origin, route: '/account/*', mount: '/account', client: null });
    const flowCookie = (csrfResponse.headers || []).find(([name]) => name === 'set-cookie')![1]!.split(';')[0]!;
    const csrf = (JSON.parse(new TextDecoder().decode(csrfResponse.body as Uint8Array)) as { csrf: string }).csrf;
    const response = await instance.handle({ method: 'POST', target: '/account/register', path: '/account/register', query: new URLSearchParams(), headers: new Headers({ cookie: flowCookie, origin, 'content-type': 'application/json', accept: 'application/json' }), headerCounts: {}, body: new TextEncoder().encode(JSON.stringify({ email: 'staff@acme.com', password: 'correct horse battery staple', csrf })), origin, route: '/account/*', mount: '/account', client: null });
    assert.notEqual(response.status, 201);
    // The account exists either way: the hook fired after `service.register` had committed it.
    assert.equal((await service.listUsers()).users.length, 1);
    // The hook's own message is not echoed to the browser.
    assert.ok(!new TextDecoder().decode(response.body as Uint8Array).includes('provisioning backend down'));
});
