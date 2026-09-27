// jimhoyd-com/urlcode#810: the catalog recipe recipes/headless-auth-profile composes this extension's JSON API with the
// store's owned collection. Core cannot import either package, so the recipe runs here, composed through composeHost
// from the same public definitions its README's host.mjs lists; the service and CSRF key are passed in with the
// public auth({service, csrfKey}) options instead of being read from operator files.
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { addRecipe, runProjectTests, startServer } from '@jimhoyd/urlcode';
import { inspectExtensionRevision } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import ui from '@jimhoyd/urlcode-ui/extension';
import store from '@jimhoyd/urlcode-store/extension';
import auth from '../src/extension.ts';
import { createAuthService } from '../src/index.ts';

const origin = 'https://api.example.com';

async function site(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-headless-recipe-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'app'), data = join(root, 'data');
    await mkdir(data);
    await addRecipe('headless-auth-profile', project);
    // The operator reviews the copied project and pins its revision; the test stands in for that review.
    const previous = process.env.PROJECT_SHA256;
    process.env.PROJECT_SHA256 = await inspectExtensionRevision(project);
    cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
    // Operator-owned key material and database, outside the project; the README's operator-service.mjs, with registration open.
    const service = await createAuthService({ database: join(data, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open' });
    cleanup(t, () => service.close());
    const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [audit({ database: join(data, 'audit.sqlite') }), mail({ transport: null }), ui(), auth({ service, csrfKey: randomBytes(32) }), store({ directory: join(data, 'store') })]);
    cleanup(t, () => host.close?.());
    return { project, extensions: host.extensions! };
}

/** Parsed JSON walked by key; every leaf is compared with assert. The objects this test walks through are named. */
interface Json { readonly user: Json; readonly profile: Json; readonly items: Json; readonly error: Json; readonly 0: Json; readonly [key: string]: Json | undefined }
interface Reply { status: number; headers: Headers; json: Json }

/** One API client: its own cookie jar, the csrf token auth last handed it, and every write sent with the site's Origin. */
function client(base: string) {
    const cookies = new Map<string, string>();
    let csrf = '';
    async function call(method: string, path: string, body?: unknown): Promise<Reply> {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        if (method !== 'GET' && method !== 'HEAD') { headers.origin = origin; if (csrf) headers['x-csrf-token'] = csrf; }
        if (body !== undefined) headers['content-type'] = 'application/json';
        const response = await fetch(base + path, { method, redirect: 'manual', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        for (const header of response.headers.getSetCookie()) {
            const first = header.split(';')[0]!, index = first.indexOf('=');
            if (/Max-Age=0/i.test(header)) cookies.delete(first.slice(0, index)); else cookies.set(first.slice(0, index), first.slice(index + 1));
        }
        const text = await response.text();
        const json = text && (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) as Json : {} as Json;
        if (typeof json.csrf === 'string') csrf = json.csrf;
        return { status: response.status, headers: response.headers, json };
    }
    return { call, cookies, get csrf() { return csrf; }, set csrf(value: string) { csrf = value; } };
}

const password = 'correct horse battery staple', other = 'another horse battery staple';
const keys = (value: unknown) => Object.keys(value as object).sort();

test('#810: register, sign in, read and update both profiles, sign out, and never reach another user\'s profile', async t => {
    const { project, extensions } = await site(t);
    const server = await startServer({ project, origin, port: 0, extensions, log: () => {} });
    cleanup(t, () => server.close());
    const base = `http://127.0.0.1:${server.address.port}`, ada = client(base), bob = client(base);

    // Registration: a csrf token bound to the anonymous flow cookie, then the account and its first session.
    assert.equal((await ada.call('GET', '/account/csrf')).status, 200);
    assert.equal((await ada.call('POST', '/account/register', { email: 'ada@example.com', password: 'too short' })).status, 400);
    assert.equal((await ada.call('POST', '/account/register', { email: 'not-an-address', password })).status, 400);
    const registered = await ada.call('POST', '/account/register', { email: 'ada@example.com', password, displayName: 'Ada' });
    assert.equal(registered.status, 201);
    assert.deepEqual(keys(registered.json), ['csrf', 'user']);
    assert.equal(registered.headers.get('cache-control'), 'no-store');
    assert.ok(ada.cookies.has('__Host-urlcode-session'), 'registration issues the session cookie');
    const adaId = String(registered.json.user.id);
    assert.equal(registered.json.user.profile.displayName, 'Ada');

    // Auth-owned profile: read with the account, updated through auth's own endpoint.
    const account = await ada.call('GET', '/account/account');
    assert.equal(account.status, 200); assert.equal(account.json.user.id, adaId); assert.equal(account.json.user.email, 'ada@example.com');
    const renamed = await ada.call('POST', '/account/profile', { displayName: 'Ada Lovelace', locale: 'en' });
    assert.equal(renamed.status, 200); assert.deepEqual(renamed.json, { profile: { metadata: {}, displayName: 'Ada Lovelace', locale: 'en' } });

    // Application profile: one owned store record per user, scoped to the session's principal.
    assert.deepEqual((await ada.call('GET', '/api/profile')).json, { items: [], total: 0 });
    const created = await ada.call('POST', '/api/profile', { bio: 'Mathematician', website: 'https://ada.example.com' });
    assert.equal(created.status, 201);
    const id = String(created.json.id);
    assert.equal(created.headers.get('location'), '/api/profile/' + id);
    assert.deepEqual(keys(created.json), ['bio', 'createdAt', 'id', 'updatedAt', 'website'], 'the owner is never in a response');
    const read = await ada.call('GET', '/api/profile/' + id);
    assert.equal(read.status, 200); assert.equal(read.json.bio, 'Mathematician');
    const listed = await ada.call('GET', '/api/profile');
    assert.equal(listed.json.total, 1); assert.equal(listed.json.items[0].id, id);
    const patched = await ada.call('PATCH', '/api/profile/' + id, { bio: 'Analyst' });
    assert.equal(patched.status, 200); assert.equal(patched.json.bio, 'Analyst'); assert.equal(patched.json.website, 'https://ada.example.com');
    const second = await ada.call('POST', '/api/profile', { bio: 'second' });
    assert.equal(second.status, 409); assert.equal(second.json.error.code, 'owner_quota_exceeded');
    assert.equal((await ada.call('PATCH', '/api/profile/' + id, { website: 'not a url' })).status, 400);
    assert.equal((await ada.call('PATCH', '/api/profile/' + id, { role: 'admin' })).status, 400, 'an undeclared field is refused');

    // The boundaries the composition keeps: the session-bound token and same-origin provenance on every signed-in write.
    const token = ada.csrf;
    ada.csrf = '';
    assert.equal((await ada.call('PATCH', '/api/profile/' + id, { bio: 'no token' })).status, 403);
    assert.equal((await ada.call('POST', '/account/profile', { displayName: 'no token' })).status, 403);
    ada.csrf = token;
    const crossSite = await fetch(base + '/api/profile/' + id, { method: 'PATCH', headers: { cookie: [...ada.cookies].map(([name, value]) => `${name}=${value}`).join('; '), 'x-csrf-token': token, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"bio":"x"}' });
    assert.equal(crossSite.status, 403);

    // Another user: their own empty profile, and Ada's record is indistinguishable from a missing one.
    await bob.call('GET', '/account/csrf');
    const bobRegistered = await bob.call('POST', '/account/register', { email: 'bob@example.com', password: other });
    assert.equal(bobRegistered.status, 201); assert.notEqual(bobRegistered.json.user.id, adaId);
    assert.deepEqual((await bob.call('GET', '/api/profile')).json, { items: [], total: 0 });
    for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) {
        const reply = await bob.call(method, '/api/profile/' + id, method === 'PATCH' || method === 'PUT' ? { bio: 'Bob was here' } : undefined);
        assert.equal(reply.status, 404, `${method} of another user's profile`); assert.equal(reply.json.error.code, 'not_found');
    }
    assert.equal((await bob.call('GET', '/account/account')).json.user.id, bobRegistered.json.user.id, 'the account endpoint answers only for the session');
    assert.equal((await ada.call('GET', '/api/profile/' + id)).json.bio, 'Analyst', 'Bob changed nothing');

    // Sign-out revokes the session on the server: the old cookie and token are refused afterwards.
    const stale = client(base);
    for (const [name, value] of ada.cookies) stale.cookies.set(name, value);
    stale.csrf = ada.csrf;
    const loggedOut = await ada.call('POST', '/account/logout', {});
    assert.equal(loggedOut.status, 200); assert.deepEqual(loggedOut.json, { signedOut: true });
    assert.ok(!ada.cookies.has('__Host-urlcode-session'), 'the session cookie is cleared');
    assert.equal((await stale.call('GET', '/account/account')).status, 401);
    assert.equal((await stale.call('GET', '/api/profile')).status, 401);
    assert.equal((await stale.call('PATCH', '/api/profile/' + id, { bio: 'replayed' })).status, 401);
    assert.equal((await stale.call('POST', '/account/profile', { displayName: 'replayed' })).status, 401);
    assert.equal((await stale.call('POST', '/account/logout', {})).status, 401);

    // Registering an address that already has an account answers the same shape, with no session and no change.
    const again = client(base);
    await again.call('GET', '/account/csrf');
    const duplicate = await again.call('POST', '/account/register', { email: 'ada@example.com', password: other });
    assert.equal(duplicate.status, 201); assert.deepEqual(keys(duplicate.json), ['csrf', 'user']);
    assert.ok(!again.cookies.has('__Host-urlcode-session'), 'no session for an existing address');

    // Sign-in issues a new session that sees the same records; a wrong password is refused.
    await ada.call('GET', '/account/csrf');
    assert.equal((await ada.call('POST', '/account/login', { email: 'ada@example.com', password: 'wrong horse battery staple' })).status, 401);
    const login = await ada.call('POST', '/account/login', { email: 'ada@example.com', password });
    assert.equal(login.status, 200); assert.deepEqual(keys(login.json), ['csrf', 'user']);
    assert.equal(login.json.user.profile.displayName, 'Ada Lovelace');
    assert.notEqual(ada.cookies.get('__Host-urlcode-session'), stale.cookies.get('__Host-urlcode-session'), 'a new session, not the revoked one');
    assert.equal((await ada.call('GET', '/api/profile/' + id)).json.bio, 'Analyst');
    assert.equal((await ada.call('DELETE', '/api/profile/' + id)).status, 204);
    assert.deepEqual((await ada.call('GET', '/api/profile')).json, { items: [], total: 0 });
});

test('#810/#811: the recipe\'s bundled fixtures run the signed-in lifecycle and run again against the same database', async t => {
    const { project, extensions } = await site(t);
    const fixtures = JSON.parse(await readFile(join(project, 'tests/requests.json'), 'utf8')) as { steps?: { capture?: Record<string, { cookie?: string }> }[] }[];
    assert.ok(fixtures.some(fixture => fixture.steps?.some(step => Object.values(step.capture ?? {}).some(spec => spec.cookie === '__Host-urlcode-session'))), 'the lifecycle keeps the session cookie to replay it after sign-out');
    const events: object[] = [];
    const tested = await runProjectTests(project, { extensions, origin, log: event => events.push(event) });
    assert.ok(tested.total >= 50, 'every fixture and step ran');
    assert.equal(tested.failed, 0, JSON.stringify(events));
    // The lifecycle signs in after registering and deletes the record it made, so a second run on the same operator database passes too.
    assert.deepEqual(await runProjectTests(project, { extensions, origin }), tested);
});

test('#811, #816: urlcode test passes the lifecycle through --host-file; audit reports the recipe ready', async t => {
    // Exercise file-URL decoding on every OS as well as Windows drive-letter handling in CI.
    const root = await mkdtemp(join(tmpdir(), 'urlcode-headless-cli space #-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'app');
    await addRecipe('headless-auth-profile', project);
    // The operator's host.mjs, as the README lists it, with the service and keys it would read from data/ made here.
    // The keys stay the same across the two commands, as an operator's do: the second run reopens the same database.
    const href = (specifier: string) => JSON.stringify(import.meta.resolve(specifier));
    const key = () => JSON.stringify(randomBytes(32).toString('base64'));
    await writeFile(join(root, 'host.mjs'), [
        `import { fileURLToPath } from 'node:url';`,
        `import { composeHost } from ${href('@jimhoyd/urlcode/host')};`,
        `import audit from ${href('@jimhoyd/urlcode-audit/extension')};`,
        `import mail from ${href('@jimhoyd/urlcode-mail/extension')};`,
        `import ui from ${href('@jimhoyd/urlcode-ui/extension')};`,
        `import store from ${href('@jimhoyd/urlcode-store/extension')};`,
        `import auth from ${JSON.stringify(new URL('../src/extension.ts', import.meta.url).href)};`,
        `import { createAuthService } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};`,
        `const data = fileURLToPath(new URL('./data/', import.meta.url));`,
        `const service = await createAuthService({ database: data + 'auth.sqlite', encryptionKey: Buffer.from(${key()}, 'base64'), roles: { member: [], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open' });`,
        `const host = await composeHost(import.meta.url, [audit({ database: data + 'audit.sqlite' }), mail({ transport: null }), ui(), auth({ service, csrfKey: Buffer.from(${key()}, 'base64') }), store({ directory: data + 'store' })]);`,
        `export default { ...host, async close() { try { await host.close?.(); } finally { service.close(); } } };`,
    ].join('\n') + '\n');
    await mkdir(join(root, 'data'));
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@jimhoyd/urlcode')));
    const env = { ...process.env, PROJECT_SHA256: await inspectExtensionRevision(project) };
    const run = (command: string, ...extra: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>(done => {
        execFile(process.execPath, [cli, command, '--project', project, ...extra, '--host-file', join(root, 'host.mjs'), '--origin', origin], { encoding: 'utf8', timeout: 120000, env }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
    });
    const tested = await run('test');
    assert.equal(tested.code, 0, tested.stdout + tested.stderr);
    const result = JSON.parse(tested.stdout.trim().split('\n').at(-1)!) as { total: number; failed: number };
    assert.ok(result.total >= 50); assert.equal(result.failed, 0);
    // The jar made every /account and /api/profile method provable. The ui mount serves only content-hashed file names,
    // which no fixture can name; ui declares it an asset mount, so audit probes an unknown name there (404, no cookie)
    // and lists its GET/HEAD under extensionAssetRouteMethods instead of uncovered.
    const audited = await run('audit', '--expect-routes', '3');
    assert.equal(audited.code, 0, audited.stdout + audited.stderr);
    const report = JSON.parse(audited.stdout.trim().split('\n').at(-1)!) as { ready: boolean; failed: number; notReadyReasons: string[]; uncovered: { route: string; method: string }[]; unassertedCases: number[]; extensionAssetRouteMethods: { route: string; method: string; extension: string; coverage: string }[] };
    assert.equal(report.failed, 0, audited.stdout);
    assert.deepEqual(report.unassertedCases, []);
    assert.deepEqual(report.uncovered, []);
    assert.deepEqual(report.extensionAssetRouteMethods, [{ route: '/assets/ui/*', method: 'GET', extension: 'ui', coverage: 'extension-assets' }, { route: '/assets/ui/*', method: 'HEAD', extension: 'ui', coverage: 'extension-assets' }]);
    assert.deepEqual(report.notReadyReasons, []);
    assert.equal(report.ready, true);
    // Nothing the jar held is printed: no session cookie value, in either command's output.
    assert.doesNotMatch(tested.stdout + tested.stderr + audited.stdout + audited.stderr, /__Host-urlcode-session=/);
});
