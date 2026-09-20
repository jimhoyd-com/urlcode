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

test('beforeRegister denies a registration and surfaces the hook reason', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'before-register.mjs'), 'export default function beforeRegister(input) { return { allow: input.email.endsWith("@acme.com"), reason: "Only @acme.com may register" }; }\n');
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    const instance = await authExtension({ service, csrfKey, projectSha256 }).activate({ registration: 'open', hooks: { beforeRegister: { source: './before-register.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
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
    const instance = await authExtension({ service, csrfKey, projectSha256 }).activate({ registration: 'open', hooks: { beforeRegister: { source: './before-register.mjs' }, onSignUp: { source: './on-signup.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
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
    const instance = await authExtension({ service, csrfKey, projectSha256, sendToken: async (message: { email: string }) => { delivered.push(message); } }).activate({ registration: 'open', hooks: { onDelete: { source: './on-delete.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
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
    await assert.rejects(Promise.resolve(authExtension({ service, csrfKey, projectSha256 }).activate({ registration: 'open', hooks: { beforeRegister: { source: './does-not-exist.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root })), /beforeRegister/);
});

test('a hook module with a broken export fails activation, not the first request', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'broken.mjs'), 'export const notTheDefault = 1;\n');
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    await assert.rejects(Promise.resolve(authExtension({ service, csrfKey, projectSha256 }).activate({ registration: 'open', hooks: { onSignUp: { source: './broken.mjs' } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root })), /onSignUp/);
});

test('sandbox: true on a hook is rejected explicitly at activation, never silently ignored', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'before-register.mjs'), 'export default function beforeRegister() { return { allow: true }; }\n');
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [] }, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const csrfKey = randomBytes(32), origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
    await assert.rejects(Promise.resolve(authExtension({ service, csrfKey, projectSha256 }).activate({ registration: 'open', hooks: { beforeRegister: { source: './before-register.mjs', sandbox: true } } }, { origin, target: 'node', projectSha256, mounts: ['/account'], root })), /sandbox: true is not yet supported.*urlcode-auth#35/);
});
