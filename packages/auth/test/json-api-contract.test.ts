import { cleanup } from './cleanup.ts';
/**
 * Drift check for docs/JSON-API.md @1. This does not re-verify every endpoint (the HTTP
 * suites already exercise the JSON bodies functionally); it asserts that the *shape*
 * (exact key set, one level deep) of a handful of load-bearing endpoints still matches
 * what docs/JSON-API.md documents, so a field added, renamed or removed there is caught
 * here instead of silently reaching an undocumented state. Bump the doc's `@1` marker
 * (and this test) together when a shape changes on purpose.
 */
import test from 'node:test';
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
async function app(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-json-api-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: { registration: 'open' } } }, routes: { '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] } } }));
    const projectSha256 = await inspectExtensionRevision(project);
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'] }, defaultRole: 'member' });
    const extension = authExtension({ service, csrfKey: randomBytes(32), projectSha256 });
    const server = await startServer({ project, origin: 'https://example.test', port: 0, extensions: [extension], log: () => { } }).catch(async (error) => { await service.close(); throw error; });
    cleanup(t, async () => { try { await server.close(); } finally { await service.close(); } });
    const cookies = new Map<string, string>();
    async function request(path: string, { method = 'GET', data }: { method?: string; data?: Record<string, string> } = {}) {
        const response = await fetch(`http://127.0.0.1:${server.address.port}${path}`, { method, redirect: 'manual', headers: { accept: 'application/json', ...(cookies.size ? { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}), ...(data ? { 'content-type': 'application/json', origin: 'https://example.test' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
        for (const header of response.headers.getSetCookie()) {
            const first = header.split(';')[0]!, index = first.indexOf('=');
            if (header.includes('Max-Age=0')) cookies.delete(first.slice(0, index)); else cookies.set(first.slice(0, index), first.slice(index + 1));
        }
        return response;
    }
    return { request };
}
function keys(value: unknown): string[] { return Object.keys(value as object).sort(); }
test('JSON contract @1: csrf, registration, account, sessions, methods and logout keep their documented shape', async (t) => {
    const { request } = await app(t);
    const csrfBody = await (await request('/account/csrf')).json();
    assert.deepEqual(keys(csrfBody), ['csrf'], 'GET /account/csrf@1');
    const registered = await request('/account/register', { method: 'POST', data: { email: 'reader@example.test', password: 'correct horse battery staple', csrf: (csrfBody as { csrf: string }).csrf } });
    assert.equal(registered.status, 201);
    const registeredBody = await registered.json() as { user: Record<string, unknown>; csrf: string };
    assert.deepEqual(keys(registeredBody), ['csrf', 'user'], 'POST /account/register@1');
    assert.deepEqual(keys(registeredBody.user), ['created', 'email', 'emailVerified', 'id', 'profile', 'roles', 'status', 'totpEnabled'], 'registered user@1 (base AuthUser fields plus the always-present profile object; optional passkeyMfaEnabled/observedLastSeen omitted here)');
    const accountBody = await (await request('/account/account')).json();
    assert.deepEqual(keys(accountBody), ['csrf', 'user'], 'GET /account/account@1');
    const sessionsBody = await (await request('/account/sessions')).json();
    assert.deepEqual(keys(sessionsBody), ['csrf', 'sessions'], 'GET /account/sessions@1');
    const methodsBody = await (await request('/account/methods')).json();
    assert.deepEqual(keys(methodsBody), ['csrf', 'identities', 'passkeys'], 'GET /account/methods@1');
    const loggedOut = await request('/account/logout', { method: 'POST', data: { csrf: registeredBody.csrf } });
    assert.deepEqual(keys(await loggedOut.json()), ['signedOut'], 'POST /account/logout@1');
});
