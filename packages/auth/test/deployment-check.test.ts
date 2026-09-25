import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyDeployment } from '../src/deployment-check.ts';
const options = { origin: 'https://accounts.example.test', authMount: '/account' };
const headers = () => new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'set-cookie': '__Host-urlcode-flow=opaque; Path=/; Secure; HttpOnly; SameSite=Strict' });
test('deployment checks are anonymous read-only requests with no redirects or body disclosure', async () => {
    const calls: string[] = [];
    const result = await verifyDeployment(options, (async (url, init) => {
        calls.push(String(url));
        assert.equal(init!.credentials, 'omit');
        assert.equal(init!.redirect, 'manual');
        assert.equal(init!.method, 'GET');
        return new Response('PRIVATE BODY', { status: String(url).endsWith('/login') ? 200 : 401, headers: headers() });
    }) as typeof fetch);
    assert.equal(result.passed, true);
    assert.equal(result.liveProviders, 'unverified');
    assert.deepEqual(calls, ['https://accounts.example.test/account/login', 'https://accounts.example.test/account/account']);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('deployment checks reject unsafe headers, anonymous sessions, redirects and redact network errors', async () => {
    const result = await verifyDeployment(options, (async () => {
        const values = headers(); values.set('set-cookie', '__Host-urlcode-session=SECRET; Path=/; Secure; HttpOnly; SameSite=Strict'); values.set('content-security-policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'unsafe-inline'");
        return new Response('SECRET', { status: 302, headers: values });
    }) as typeof fetch);
    assert.equal(result.passed, false);
    assert.ok(result.checks.some(check => check.name.endsWith('cookie-policy') && !check.passed));
    assert.ok(result.checks.some(check => check.name.endsWith('content-security-policy') && !check.passed));
    const failure = await verifyDeployment(options, (async () => { throw new Error('SECRET'); }) as typeof fetch);
    assert.equal(failure.passed, false);
    assert.ok(!JSON.stringify(failure).includes('SECRET'));
    for (const origin of ['http://remote.example.test', 'https://accounts.example.test/path', 'https://user:pass@accounts.example.test']) await assert.rejects(verifyDeployment({ ...options, origin }));
});

test('deployment command checks a real mounted runtime without credentials or account creation', async t => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomBytes } = await import('node:crypto');
    const { startServer } = await import('@jimhoyd/urlcode');
    const { inspectExtensionRevision } = await import('@jimhoyd/urlcode/extensions');
    const { createAuthService } = await import('../src/auth-core.ts');
    const { companions, withCompanions } = await import('./support/companions.ts');
    const { activatedUi } = await import('./support/render.ts');
    const root = await mkdtemp(join(tmpdir(), 'urlcode-deployment-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project'); await mkdir(project);
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: { registration: 'off' } } }, routes: { '/account/*': { extension: 'auth', methods: ['GET', 'POST'] } } }));
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member', registrationMode: 'off' });
    const projectSha256 = await inspectExtensionRevision(project), ui = await activatedUi(t, project, projectSha256);
    const authExtension = withCompanions(await companions(t, root, projectSha256));
    const extension = authExtension({ service, csrfKey: randomBytes(32), projectSha256, ui });
    const server = await startServer({ project, origin: 'https://example.test', port: 0, extensions: [extension], log: () => {} });
    cleanup(t, async () => { try { await server.close(); } finally { await service.close(); } });
    const result = await verifyDeployment({ origin: `http://127.0.0.1:${server.address.port}`, authMount: '/account', allowDevelopment: true });
    assert.equal(result.passed, true, JSON.stringify(result.checks));
    // The CLI is spawned asynchronously: a synchronous spawn would block the event loop that serves the in-process test server.
    const { execFile } = await import('node:child_process'), { fileURLToPath } = await import('node:url');
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url)), run = (input: object) => new Promise<{ status: number | null; stdout: string; stderr: string }>(done => { const child = execFile(process.execPath, [cli, 'verify-deployment'], { encoding: 'utf8', timeout: 20000 }, (error, stdout, stderr) => done({ status: error ? child.exitCode : 0, stdout, stderr })); child.stdin!.end(JSON.stringify(input)); });
    const command = await run({ origin: `http://127.0.0.1:${server.address.port}`, authMount: '/account', allowDevelopment: true });
    assert.equal(command.status, 0, command.stderr + command.stdout);
    assert.deepEqual(JSON.parse(command.stdout).checks, result.checks);
    assert.ok(!command.stdout.includes('<'));
    assert.equal((await run({ origin: `http://127.0.0.1:${server.address.port}`, authMount: '/account' })).status, 1);
    assert.equal((await service.listUsers()).users.length, 0);
});

test('deployment CSP accepts only explicitly approved fixed Turnstile origin', async () => {
    const transport = (async (url: string | URL | Request) => { const values=headers(); values.set('content-security-policy', values.get('content-security-policy') + "; script-src 'nonce-12345678901234567890abcd' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com"); return new Response('',{status:String(url).endsWith('/login')?200:401,headers:values}); }) as typeof fetch;
    assert.equal((await verifyDeployment(options,transport)).passed,false);
    assert.equal((await verifyDeployment({...options,allowTurnstile:true},transport)).passed,true);
});
