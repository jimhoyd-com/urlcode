// jimhoyd-com/urlcode#828: the catalog recipe recipes/fixed-contract-adapter serves a fixed JSON contract through the
// operator adapter module its README carries, over AuthExports and StoreExports only. Core cannot import auth or store,
// so the recipe runs here. The adapter is the README's code block, written outside the project with its package
// specifiers pointed at this checkout: the tests exercise the documented module, not a copy of it.
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
import type { AuthService } from '../src/index.ts';

const origin = 'https://api.example.com';
const password = 'correct horse battery staple', other = 'another horse battery staple';
const envelope = (code: string, message: string) => ({ error: { code, message } });

/** The README's adapter module, saved as api-contract.mjs in `directory` (outside any project), with the two package specifiers resolved here. */
async function readmeAdapter(directory: string): Promise<string> {
    const readme = await readFile(new URL('../../../recipes/fixed-contract-adapter/README.md', import.meta.url), 'utf8');
    const module = /## The adapter module[\s\S]*?```js\n([\s\S]*?)```/.exec(readme)?.[1];
    for (const specifier of ['@jimhoyd/urlcode/extensions', '@jimhoyd/urlcode-store'])
        assert.ok(module?.includes(`from '${specifier}'`), `the README adapter imports ${specifier}`);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'api-contract.mjs');
    await writeFile(path, module!.replace(`'@jimhoyd/urlcode/extensions'`, JSON.stringify(import.meta.resolve('@jimhoyd/urlcode/extensions'))).replace(`'@jimhoyd/urlcode-store'`, JSON.stringify(import.meta.resolve('@jimhoyd/urlcode-store'))));
    return path;
}

interface Site { root: string; project: string; service: AuthService; extensions: NonNullable<Awaited<ReturnType<typeof composeHost>>['extensions']> }
/** The README's operator composition: the five extensions plus the adapter, a fresh operator database and keys, the revision pinned. */
async function site(t: TestContext, recipe = 'fixed-contract-adapter', edit?: (yaml: string) => string, shared?: { service: AuthService; csrfKey: Buffer; data: string }): Promise<Site> {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-fixed-contract-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'app'), data = shared?.data ?? join(root, 'data');
    await mkdir(data, { recursive: true });
    await addRecipe(recipe, project);
    if (edit) await writeFile(join(project, 'urlcode.yaml'), edit(await readFile(join(project, 'urlcode.yaml'), 'utf8')));
    const previous = process.env.PROJECT_SHA256;
    process.env.PROJECT_SHA256 = await inspectExtensionRevision(project);
    cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
    const service = shared?.service ?? await createAuthService({ database: join(data, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: { member: [], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open' });
    if (!shared) cleanup(t, () => service.close());
    const entries = [audit({ database: join(data, `audit-${recipe}.sqlite`) }), mail({ transport: null }), ui(), auth({ service, csrfKey: shared?.csrfKey ?? randomBytes(32) }), store({ directory: join(data, `store-${recipe}`) })];
    if (recipe === 'fixed-contract-adapter') entries.push((await import(pathToFileURL(await readmeAdapter(join(root, 'operator'))).href) as { default: () => typeof entries[number] }).default());
    const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), entries);
    cleanup(t, () => host.close?.());
    return { root, project, service, extensions: host.extensions! };
}

/** A parsed JSON body, walked by the keys this test reads; every leaf is compared with assert. */
interface Json { readonly error: Json; readonly id: Json; readonly csrf: Json; readonly title: Json; map<T>(callback: (item: { id: string }) => T): T[]; readonly [key: string]: unknown }
interface Reply { status: number; headers: Headers; body: string; json: Json }
/** One fixed-contract client: its own cookie jar, the token it last saw (a login body or /api/me's header), the site Origin on writes. */
function client(base: string) {
    const cookies = new Map<string, string>(), setCookies: string[] = [];
    let csrf = '';
    async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
        const headers: Record<string, string> = { accept: 'application/json' };
        if (cookies.size) headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        if (method !== 'GET' && method !== 'HEAD') { headers.origin = origin; if (csrf) headers['x-csrf-token'] = csrf; }
        if (body !== undefined) headers['content-type'] = 'application/json';
        Object.assign(headers, extra);
        for (const [name, value] of Object.entries(extra)) if (value === '') delete headers[name];
        const response = await fetch(base + path, { method, redirect: 'manual', headers, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
        for (const header of response.headers.getSetCookie()) {
            setCookies.push(header);
            const first = header.split(';')[0]!, index = first.indexOf('=');
            if (/Max-Age=0/i.test(header)) cookies.delete(first.slice(0, index)); else cookies.set(first.slice(0, index), first.slice(index + 1));
        }
        const text = await response.text();
        const json = (text && (response.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : undefined) as Json;
        if (typeof json?.csrf === 'string') csrf = json.csrf;
        if (response.headers.get('x-csrf-token')) csrf = response.headers.get('x-csrf-token')!;
        return { status: response.status, headers: response.headers, body: text, json };
    }
    async function signIn(email: string, secret: string, register = false): Promise<Reply> {
        assert.equal((await call('GET', '/account/csrf')).status, 200);
        if (register) { assert.equal((await call('POST', '/account/register', { email, password: secret })).status, 201); await call('GET', '/account/csrf'); }
        return call('POST', '/account/login', { email, password: secret });
    }
    return { call, signIn, cookies, setCookies, get csrf() { return csrf; }, set csrf(value: string) { csrf = value; } };
}

test('#828: the fixed contract signs in through auth, answers /api/me and owner-scoped /api/items, and maps every refusal', async t => {
    const { project, extensions } = await site(t);
    const server = await startServer({ project, origin, port: 0, extensions, log: () => {} });
    cleanup(t, () => server.close());
    const base = `http://127.0.0.1:${server.address.port}`, ada = client(base), bob = client(base), anonymous = client(base);

    // Signed out: auth's own 401 on every contract route, in auth's body, before the adapter runs. The contract envelope
    // is the runtime's for an unmatched /api path and an undeclared method, and there is no /api/login to reach.
    for (const [method, path] of [['GET', '/api/me'], ['GET', '/api/items'], ['POST', '/api/items'], ['PATCH', '/api/items/00000000-0000-4000-8000-000000000000']] as const) {
        const reply = await anonymous.call(method, path, method === 'GET' ? undefined : { title: 'x' });
        assert.equal(reply.status, 401, `${method} ${path}`);
        assert.equal(typeof reply.json.error, 'string', 'a denial keeps auth\'s {error: message} body: the documented limit');
    }
    const login = await anonymous.call('POST', '/api/login', { email: 'ada@example.com', password });
    assert.equal(login.status, 404); assert.deepEqual(login.json, envelope('NOT_FOUND', 'Not found'));
    // Authorization comes first: even an undeclared method is auth's 401 until the caller signs in.
    assert.equal((await anonymous.call('DELETE', '/api/items/00000000-0000-4000-8000-000000000000')).status, 401);

    // Sign-in stays auth's: no token is 403, a wrong password 401, then auth issues its own session cookie.
    assert.equal((await ada.call('POST', '/account/login', { email: 'ada@example.com', password })).status, 403, 'sign-in needs auth\'s flow token');
    await ada.call('GET', '/account/csrf');
    assert.equal((await ada.call('POST', '/account/register', { email: 'ada@example.com', password })).status, 201);
    await ada.call('GET', '/account/csrf');
    assert.equal((await ada.call('POST', '/account/login', { email: 'ada@example.com', password: 'wrong horse battery staple' })).status, 401);
    const signedIn = await ada.call('POST', '/account/login', { email: 'ada@example.com', password });
    assert.equal(signedIn.status, 200);
    const session = ada.setCookies.findLast(header => header.startsWith('__Host-urlcode-session='))!;
    assert.match(session, /; Path=\/; Secure; HttpOnly; SameSite=Strict$/, 'the session cookie is auth\'s, with its attributes');
    const loginToken = String(signedIn.json.csrf);

    // /api/me: exactly the contract's fields, and the session-bound token in a header equal to the one sign-in returned.
    ada.csrf = '';
    const me = await ada.call('GET', '/api/me');
    assert.equal(me.status, 200); assert.deepEqual(me.json, { email: 'ada@example.com', role: 'member' });
    assert.equal(me.headers.get('x-csrf-token'), loginToken); assert.equal(me.headers.get('cache-control'), 'no-store');
    assert.equal((await ada.call('HEAD', '/api/me')).body, '');
    assert.deepEqual((await ada.call('GET', '/api/me/extra')).json, envelope('NOT_FOUND', 'Not found'));

    // Items: create, list, read, update, projected to {id, title, done}; the store's createdAt/updatedAt never appear.
    assert.deepEqual((await ada.call('GET', '/api/items')).json, []);
    const created = await ada.call('POST', '/api/items', { title: 'Write the adapter' });
    assert.equal(created.status, 201);
    const id = String(created.json.id);
    assert.deepEqual(created.json, { id, title: 'Write the adapter', done: false });
    assert.equal(created.headers.get('location'), '/api/items/' + id);
    assert.deepEqual((await ada.call('GET', '/api/items/' + id)).json, { id, title: 'Write the adapter', done: false });
    assert.deepEqual((await ada.call('PATCH', '/api/items/' + id, { done: true })).json, { id, title: 'Write the adapter', done: true });
    assert.deepEqual((await ada.call('GET', '/api/items')).json, [{ id, title: 'Write the adapter', done: true }]);

    // Error taxonomy: store and body refusals keep their status and take the contract's code; nothing echoes input.
    const invalid = envelope('VALIDATION_FAILED', 'Request failed validation');
    for (const [method, path, body] of [
        ['PATCH', '/api/items/' + id, { createdAt: '2020-01-01T00:00:00.000Z' }], ['PATCH', '/api/items/' + id, { _owner: 'someone-else' }],
        ['PATCH', '/api/items/' + id, { done: 'yes' }], ['PATCH', '/api/items/' + id, { title: '' }], ['POST', '/api/items', { done: true }],
        ['POST', '/api/items', { title: null }], ['POST', '/api/items', [1]], ['POST', '/api/items', '{"title":'], ['POST', '/api/items', { title: { nested: 1 } }],
    ] as const) {
        const reply = await ada.call(method, path, body);
        assert.equal(reply.status, 400, `${method} ${JSON.stringify(body)}`); assert.deepEqual(reply.json, invalid);
    }
    const plain = await ada.call('POST', '/api/items', 'title=x', { 'content-type': 'text/plain' });
    assert.equal(plain.status, 415); assert.deepEqual(plain.json, envelope('UNSUPPORTED_MEDIA_TYPE', 'Unsupported media type'));
    const large = await ada.call('POST', '/api/items', { title: 'x'.repeat(20000) });
    assert.equal(large.status, 413); assert.deepEqual(large.json, envelope('CONTENT_TOO_LARGE', 'Content too large'));
    for (const path of ['/api/items/00000000-0000-4000-8000-000000000000', '/api/items/not-an-id', '/api/items/' + id + '/more', '/api/items/'])
        assert.deepEqual((await ada.call('GET', path)).json, envelope('NOT_FOUND', 'Not found'), path);
    const wrongMethod = await ada.call('POST', '/api/items/' + id, { title: 'x' });
    assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get('allow'), 'GET, HEAD, PATCH');
    assert.equal((await ada.call('PATCH', '/api/items', { title: 'x' })).headers.get('allow'), 'GET, HEAD, POST');
    const deleted = await ada.call('DELETE', '/api/items/' + id);
    assert.equal(deleted.status, 405); assert.equal(deleted.headers.get('allow'), 'GET, HEAD, POST, PATCH'); assert.deepEqual(deleted.json, envelope('METHOD_NOT_ALLOWED', 'Method not allowed'));

    // CSRF and origin stay auth's on every contract write: no token, a stale token, a foreign or missing Origin.
    const token = ada.csrf;
    for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': '0'.repeat(64) }, { origin: 'https://evil.example' }, { origin: '' }]) {
        const reply = await ada.call('PATCH', '/api/items/' + id, { title: 'refused' }, headers);
        assert.equal(reply.status, 403, JSON.stringify(headers));
    }
    assert.equal(ada.csrf, token);
    assert.equal((await ada.call('GET', '/api/items/' + id)).json.title, 'Write the adapter', 'no refused write changed the item');

    // The native store mount serves the same record under the same ownership, and deletes what the contract cannot.
    const native = await ada.call('GET', '/store/items/' + id);
    assert.equal(native.status, 200); assert.deepEqual(Object.keys(native.json).sort(), ['createdAt', 'done', 'id', 'title', 'updatedAt']);
    const second = await ada.call('POST', '/store/items', { title: 'Created natively' });
    assert.equal(second.status, 201);
    assert.deepEqual((await ada.call('GET', '/api/items')).json.map((item: { id: string }) => item.id), [id, second.json.id]);
    assert.equal((await ada.call('DELETE', '/api/items/' + second.json.id)).status, 405);
    assert.equal((await ada.call('DELETE', '/store/items/' + second.json.id)).status, 204);
    assert.deepEqual((await ada.call('GET', '/api/items/' + second.json.id)).json, envelope('NOT_FOUND', 'Not found'));

    // Another user: an empty list, and Ada's item is indistinguishable from a missing one on both mounts.
    assert.equal((await bob.signIn('bob@example.com', other, true)).status, 200);
    assert.deepEqual((await bob.call('GET', '/api/me')).json, { email: 'bob@example.com', role: 'member' });
    assert.deepEqual((await bob.call('GET', '/api/items')).json, []);
    for (const [method, path] of [['GET', '/api/items/' + id], ['PATCH', '/api/items/' + id], ['GET', '/store/items/' + id], ['DELETE', '/store/items/' + id]] as const) {
        const reply = await bob.call(method, path, method === 'PATCH' ? { title: 'Bob was here' } : undefined);
        assert.equal(reply.status, 404, `${method} ${path}`);
    }
    assert.deepEqual((await bob.call('PATCH', '/api/items/' + id, { done: false })).json, envelope('NOT_FOUND', 'Not found'));
    assert.deepEqual((await ada.call('GET', '/api/items/' + id)).json, { id, title: 'Write the adapter', done: true }, 'Bob changed nothing');

    // Sign-out revokes the session on the server: the old cookie is refused on every contract route afterwards.
    const stale = client(base);
    for (const [name, value] of ada.cookies) stale.cookies.set(name, value);
    stale.csrf = ada.csrf;
    const out = await ada.call('POST', '/account/logout', {});
    assert.equal(out.status, 200); assert.deepEqual(out.json, { signedOut: true });
    assert.ok(!ada.cookies.has('__Host-urlcode-session'));
    for (const [method, path] of [['GET', '/api/me'], ['GET', '/api/items'], ['PATCH', '/api/items/' + id], ['POST', '/api/items']] as const)
        assert.equal((await stale.call(method, path, method === 'GET' ? undefined : { title: 'replayed' })).status, 401, `${method} ${path} after sign-out`);

    // The adapter never sets a cookie: only auth's own endpoints do.
    for (const reply of [ada, bob, anonymous, stale]) assert.ok(reply.setCookies.every(header => /^__Host-urlcode-(session|flow|device)=/.test(header)), 'only auth cookies');
    const probe = await fetch(base + '/api/me', { headers: { accept: 'application/json', cookie: [...bob.cookies].map(([name, value]) => `${name}=${value}`).join('; ') } });
    assert.equal(probe.status, 200); assert.deepEqual(probe.headers.getSetCookie(), []);
});

test('#828: the adapter refuses to activate on a contract route without auth, a shared collection or an undeclared field', async t => {
    const refusals: [string, (yaml: string) => string, RegExp][] = [
        ['no auth policy', yaml => yaml.replace(/( {2}\/api\/items\/\*:[\s\S]*?methods: \[GET, HEAD, POST, PATCH\]\n) {4}auth: true\n/, '$1'), /route \/api\/items\/\* needs auth: true/],
        ['a shared collection', yaml => yaml.replace('          ownership: owner\n          maxRecordsPerOwner: 100\n', ''), /must declare ownership: owner/],
        ['an undeclared field', yaml => yaml.replace('fields: [title, done]', 'fields: [title, done, secret]'), /declares no field secret/],
        ['an unconfigured mount', yaml => yaml.replace('      me: /api/me\n', '      me: /api/whoami\n'), /route \/api\/whoami\/\* with extension: api-contract is not declared/],
    ];
    for (const [name, edit, message] of refusals) {
        const { project, extensions } = await site(t, 'fixed-contract-adapter', edit);
        await assert.rejects(startServer({ project, origin, port: 0, extensions, log: () => {} }), message, name);
    }
});

test('#828: the bundled fixtures run the whole contract twice, and the native headless-auth-profile contract passes beside it', async t => {
    const { project, extensions, service } = await site(t);
    const fixtures = JSON.parse(await readFile(join(project, 'tests/requests.json'), 'utf8')) as { steps?: unknown[] }[];
    assert.ok(fixtures.some(fixture => (fixture.steps?.length ?? 0) > 40));
    const events: object[] = [];
    const tested = await runProjectTests(project, { extensions, origin, log: event => events.push(event) });
    assert.ok(tested.total >= 60, 'every fixture and step ran');
    assert.equal(tested.failed, 0, JSON.stringify(events));
    // The lifecycle signs in after registering and deletes what it made, so it passes again on the same databases.
    assert.deepEqual(await runProjectTests(project, { extensions, origin }), tested);
    // Side by side: the native recipe on the same auth service keeps its own contract (the adapter changed nothing
    // native), and its fixtures sign the same accounts in.
    const native = await site(t, 'headless-auth-profile', undefined, { service, csrfKey: randomBytes(32), data: await mkdtemp(join(tmpdir(), 'urlcode-fixed-contract-native-')) });
    const nativeTested = await runProjectTests(native.project, { extensions: native.extensions, origin });
    assert.ok(nativeTested.total >= 50); assert.equal(nativeTested.failed, 0);
    assert.deepEqual(await runProjectTests(project, { extensions, origin }), tested, 'and the contract still passes after the native run');
});

test('#828: urlcode test and audit pass the contract through --host-file; audit reports the recipe ready', async t => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-fixed-contract-cli space #-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const project = join(root, 'app');
    await addRecipe('fixed-contract-adapter', project);
    await readmeAdapter(root);
    // The README's host.mjs, with the service and keys an operator reads from data/ made here, kept across both commands.
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
        `import apiContract from './api-contract.mjs';`,
        `const data = fileURLToPath(new URL('./data/', import.meta.url));`,
        `const service = await createAuthService({ database: data + 'auth.sqlite', encryptionKey: Buffer.from(${key()}, 'base64'), roles: { member: [], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open' });`,
        `const host = await composeHost(import.meta.url, [audit({ database: data + 'audit.sqlite' }), mail({ transport: null }), ui(), auth({ service, csrfKey: Buffer.from(${key()}, 'base64') }), store({ directory: data + 'store' }), apiContract()]);`,
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
    assert.ok(result.total >= 60); assert.equal(result.failed, 0);
    const audited = await run('audit', '--expect-routes', '5');
    assert.equal(audited.code, 0, audited.stdout + audited.stderr);
    const report = JSON.parse(audited.stdout.trim().split('\n').at(-1)!) as { ready: boolean; failed: number; notReadyReasons: string[]; uncovered: { route: string; method: string }[]; unassertedCases: number[]; extensionAssetRouteMethods: { route: string; method: string; extension: string; coverage: string }[] };
    assert.equal(report.failed, 0, audited.stdout);
    assert.deepEqual(report.uncovered, []);
    assert.deepEqual(report.unassertedCases, []);
    assert.deepEqual(report.extensionAssetRouteMethods.map(entry => `${entry.route} ${entry.method} ${entry.coverage}`), ['/assets/ui/* GET extension-assets', '/assets/ui/* HEAD extension-assets']);
    assert.deepEqual(report.notReadyReasons, []);
    assert.equal(report.ready, true);
    assert.doesNotMatch(tested.stdout + tested.stderr + audited.stdout + audited.stderr, /__Host-urlcode-session=/);
});
