// jimhoyd-com/urlcode#745: an HTML form POST (or a same-origin kit script write) to a route protected by the real auth
// extension was refused with 403 because authorize() read the CSRF token from the x-csrf-token header only. A route now
// takes the session-bound token from the header or from the body `csrf` field, and a mount that verifies its own token
// (forms, form-records) or accepts JSON only may declare `auth: {csrf: origin}` for Origin/Sec-Fetch admission alone.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import { AuthHttp } from '../src/auth-ui.ts';
import { siteHost } from './support/site.ts';

const origin = 'https://example.test';

async function site(t: TestContext, routes: Record<string, unknown>) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-csrf-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'app');
    await mkdir(project);
    await writeFile(join(project, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { ui: { version: '1', config: {} }, auth: { version: '1', config: { registration: 'open' } } }, routes: {
        '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] },
        '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
        ...routes,
    } }));
    const sha = await inspectExtensionRevision(project), csrfKey = randomBytes(32);
    const previous = process.env.PROJECT_SHA256;
    process.env.PROJECT_SHA256 = sha;
    cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
    const { entries, service } = await siteHost(t, root, csrfKey);
    const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), entries);
    cleanup(t, () => host.close?.());
    const server = await startServer({ project, origin, port: 0, extensions: host.extensions!, log: () => {} });
    cleanup(t, () => server.close());
    const alice = await service.register({ email: 'alice@example.test', password: 'correct horse battery staple' });
    const http = new AuthHttp({ csrfKey, origin });
    const post = (path: string, { headers = {}, body }: { headers?: Record<string, string>; body: string }) => fetch(`http://127.0.0.1:${server.address.port}${path}`, { method: 'POST', redirect: 'manual', headers: { cookie: '__Host-urlcode-session=' + alice.token, ...headers }, body });
    return { post, csrf: http.token(alice.token) };
}

const form = { 'content-type': 'application/x-www-form-urlencoded' }, json = { 'content-type': 'application/json' };

test('#745: a same-origin HTML form POST to an auth route is admitted with the session token in the csrf body field', async t => {
    const { post, csrf } = await site(t, { '/notes': { respond: { json: { saved: true } }, methods: ['POST'], auth: true } });
    // The page's form carries auth's own session-bound token as `csrf`; no script adds a header.
    assert.equal((await post('/notes', { headers: { ...form, origin }, body: new URLSearchParams({ csrf, title: 'x' }).toString() })).status, 200);
    assert.equal((await post('/notes', { headers: { ...json, origin }, body: JSON.stringify({ csrf, title: 'x' }) })).status, 200);
    assert.equal((await post('/notes', { headers: { ...form, origin, 'x-csrf-token': csrf }, body: 'title=x' })).status, 200);
    // Still refused: no token, another key's token, two tokens, a cross-site or absent provenance, a body over 16 KiB.
    assert.equal((await post('/notes', { headers: { ...form, origin }, body: 'title=x' })).status, 403);
    assert.equal((await post('/notes', { headers: { ...form, origin }, body: new URLSearchParams({ csrf: 'b'.repeat(64) }).toString() })).status, 403);
    assert.equal((await post('/notes', { headers: { ...form, origin }, body: `csrf=${csrf}&csrf=${csrf}` })).status, 403);
    assert.equal((await post('/notes', { headers: { ...form, origin: 'https://evil.test' }, body: new URLSearchParams({ csrf }).toString() })).status, 403);
    assert.equal((await post('/notes', { headers: { ...form }, body: new URLSearchParams({ csrf }).toString() })).status, 403);
    const large = await post('/notes', { headers: { ...form, origin }, body: new URLSearchParams({ csrf, pad: 'x'.repeat(17000) }).toString() });
    assert.equal(large.status, 403);
    assert.match(await large.text(), /x-csrf-token/);
});

test('#745: auth: {csrf: origin} admits a same-origin write with no session token and refuses cross-site or unprovenanced ones', async t => {
    const { post } = await site(t, { '/api/todos': { respond: { json: { saved: true } }, methods: ['POST'], auth: { csrf: 'origin' } } });
    assert.equal((await post('/api/todos', { headers: { ...json, origin }, body: '{"title":"x"}' })).status, 200);
    assert.equal((await post('/api/todos', { headers: { ...form, 'sec-fetch-site': 'same-origin' }, body: 'title=x' })).status, 200);
    assert.equal((await post('/api/todos', { headers: { ...json, origin: 'https://evil.test' }, body: '{}' })).status, 403);
    assert.equal((await post('/api/todos', { headers: { ...json, origin, 'sec-fetch-site': 'cross-site' }, body: '{}' })).status, 403);
    assert.equal((await post('/api/todos', { headers: { ...json }, body: '{}' })).status, 403);
});

test('csrf is refused next to bearer in the policy schema', async () => {
    const { authPolicySchema } = await import('../src/auth.ts');
    const { Ajv } = await import('ajv');
    const validate = new Ajv({ strict: true }).compile(authPolicySchema);
    assert.equal(validate({ csrf: 'origin' }), true);
    assert.equal(validate({ csrf: 'token', role: 'member' }), true);
    assert.equal(validate({ csrf: 'origin', bearer: { scopes: ['a'] } }), false);
    assert.equal(validate({ csrf: 'none' }), false);
});
