// Auth's project lifecycle hooks are fired by the auth service, so every caller gets the same set: auth's own pages,
// the administrative operations `auth.administration` calls, and the operator CLI (the second caller, below).
import { cleanup } from './cleanup.ts';
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createAuthService, internal } from '../src/auth-core.ts';
import type { AuthOptions, AuthServiceInternal } from '../src/auth-core.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { authFor } from './support/companions.ts';
import { activatedUi, bodyText } from './support/render.ts';

const password = 'correct horse battery staple', origin = 'https://example.test', projectSha256 = 'a'.repeat(64);
async function setup(t: TestContext, options: Partial<AuthOptions> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-hooks-root-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = internal(await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], admin: ['*'] }, defaultRole: 'member', ...options }));
    cleanup(t, () => service.close());
    return { root, service };
}
/** An activated auth mount with `hooks` configured. `post` signs its CSRF token for the session, or for a fresh flow. */
async function site(t: TestContext, root: string, service: AuthServiceInternal, hooks: Record<string, unknown>) {
    const csrfKey = randomBytes(32), http = new AuthHttp({ origin, csrfKey }), flow = randomBytes(32).toString('base64url');
    const ui = await activatedUi(t, root, projectSha256, origin);
    const instance = await (await authFor(t, root, { service, csrfKey, projectSha256, ui }, origin)).registration.activate({ registration: 'open', hooks }, { origin, target: 'node', projectSha256, mounts: ['/account'], root });
    cleanup(t, () => instance.close?.());
    const post = (path: string, data: Record<string, string>, session?: string) => instance.handle({ method: 'POST', target: '/account' + path, path: '/account' + path, query: new URLSearchParams(), headers: new Headers({ origin, accept: 'application/json', 'content-type': 'application/json', cookie: session ? '__Host-urlcode-session=' + session : '__Host-urlcode-flow=' + flow }), headerCounts: {}, body: new TextEncoder().encode(JSON.stringify({ ...data, csrf: http.token(session ?? flow) })), origin, route: '/account/*', mount: '/account', client: null, requestId: 'hook-request', env: {} });
    return { instance, post };
}
/** A hook module that appends each input (and its context's request id) to calls-<name>.json, then returns `answer`. */
async function recorder(root: string, name: string, answer = 'undefined'): Promise<() => Promise<Record<string, unknown>[]>> {
    const file = join(root, `calls-${name}.json`);
    await writeFile(file, '[]');
    await writeFile(join(root, `${name}.mjs`), `import { readFile, writeFile } from 'node:fs/promises';\nexport default async function hook(input, context) {\n  const calls = JSON.parse(await readFile(${JSON.stringify(file)}, 'utf8'));\n  calls.push({ ...input, requestId: context.requestId });\n  await writeFile(${JSON.stringify(file)}, JSON.stringify(calls));\n  return ${answer};\n}\n`);
    return async () => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>[];
}

test('beforeRegister denies a registration from auth\'s pages and surfaces the hook reason', async (t) => {
    const { root, service } = await setup(t);
    await writeFile(join(root, 'before-register.mjs'), 'export default function beforeRegister(input) { return { allow: input.email.endsWith("@acme.com"), reason: "Only @acme.com may register" }; }\n');
    const { post } = await site(t, root, service, { beforeRegister: { source: './before-register.mjs' } });
    const denied = await post('/register', { email: 'outsider@example.test', password });
    assert.equal(denied.status, 403);
    assert.equal((JSON.parse(bodyText(denied.body)) as { error: string }).error, 'Only @acme.com may register');
    assert.equal((await service.listUsers()).users.length, 0);
});

test('beforeRegister lets an allowed registration through and onAccountCreated fires after it, with the request context', async (t) => {
    const { root, service } = await setup(t);
    const verdicts = await recorder(root, 'before-register', '{ allow: input.email.endsWith("@acme.com") }'), created = await recorder(root, 'created');
    const { post } = await site(t, root, service, { beforeRegister: './before-register.mjs', onAccountCreated: './created.mjs' });
    assert.equal((await post('/register', { email: 'outsider@example.test', password })).status, 403);
    assert.deepEqual(await created(), []);
    assert.equal((await post('/register', { email: 'staff@acme.com', password })).status, 201);
    const user = (await service.listUsers()).users[0]!;
    assert.deepEqual(await created(), [{ accountId: user.id, email: 'staff@acme.com', method: 'password', requestId: 'hook-request' }]);
    assert.deepEqual((await verdicts()).map(input => [input.email, input.method]), [['outsider@example.test', 'password'], ['staff@acme.com', 'password']]);
});

test('onDeletionScheduled fires when the owner schedules deletion, with no actor', async (t) => {
    const { root, service } = await setup(t);
    const calls = await recorder(root, 'deletion');
    const user = await service.register({ email: 'leaving@example.test', password });
    const { post } = await site(t, root, service, { onDeletionScheduled: './deletion.mjs' });
    const response = await post('/delete', { confirmation: 'DELETE', password }, user.token);
    assert.equal(response.status, 200, bodyText(response.body));
    const [input] = await calls();
    assert.deepEqual(Object.keys(input!).sort(), ['accountId', 'deleteAfter', 'email', 'requestId']);
    assert.equal(input!.accountId, user.user.id);
    assert.equal(input!.email, 'leaving@example.test');
});

test('a throwing action hook is counted and never changes the committed result or the response', async (t) => {
    const { root, service } = await setup(t);
    await writeFile(join(root, 'created.mjs'), 'export default function onAccountCreated() { throw new Error("provisioning backend down"); }\n');
    const { post } = await site(t, root, service, { onAccountCreated: './created.mjs' });
    const response = await post('/register', { email: 'staff@acme.com', password });
    assert.equal(response.status, 201);
    assert.equal((await service.listUsers()).users.length, 1);
    assert.ok(!bodyText(response.body).includes('provisioning backend down'));
    assert.equal(service.getHookStats().failed, 1);
});

test('a missing module, a broken export or sandbox: true fails activation, not the first request', async (t) => {
    const { root, service } = await setup(t);
    await writeFile(join(root, 'broken.mjs'), 'export const notTheDefault = 1;\n');
    await writeFile(join(root, 'before-register.mjs'), 'export default function beforeRegister() { return { allow: true }; }\n');
    const ui = await activatedUi(t, root, projectSha256, origin), registration = (await authFor(t, root, { service, csrfKey: randomBytes(32), projectSha256, ui }, origin)).registration;
    const activate = (hooks: Record<string, unknown>) => Promise.resolve(registration.activate({ registration: 'open', hooks }, { origin, target: 'node', projectSha256, mounts: ['/account'], root }));
    await assert.rejects(activate({ beforeRegister: { source: './does-not-exist.mjs' } }), /beforeRegister/);
    await assert.rejects(activate({ onAccountCreated: { source: './broken.mjs' } }), /onAccountCreated/);
    await assert.rejects(activate({ beforeRegister: { source: './before-register.mjs', sandbox: true } }), /sandbox: true is not supported for extension hooks; hooks run trusted by default/);
    // The retired names are not hooks any more.
    await assert.rejects(activate({ onSignUp: { source: './before-register.mjs' } }), /Unknown extension hook: onSignUp/);
});

// jimhoyd-com/urlcode#198: each activation re-imports the hook's entry module under a fresh cache-busting query.
test('re-activating in the same process picks up an edited hook entry module', async (t) => {
    const { root, service } = await setup(t);
    const hook = join(root, 'before-register.mjs');
    async function reason() {
        const { post } = await site(t, root, service, { beforeRegister: { source: './before-register.mjs' } });
        const denied = await post('/register', { email: 'outsider@example.test', password });
        assert.equal(denied.status, 403);
        return (JSON.parse(bodyText(denied.body)) as { error: string }).error;
    }
    await writeFile(hook, 'export default function beforeRegister() { return { allow: false, reason: "v1" }; }\n');
    assert.equal(await reason(), 'v1');
    await writeFile(hook, 'export default function beforeRegister() { return { allow: false, reason: "v2" }; }\n');
    assert.equal(await reason(), 'v2');
    assert.equal((await service.listUsers()).users.length, 0);
});

test('filters deny on a throw, a timeout, a missing or non-boolean verdict, and bound the reason they report', async (t) => {
    const { service } = await setup(t, { registrationMode: 'open' });
    const refusal = (verdict: () => unknown) => { service.attachLifecycleHooks({ beforeRegister: async () => verdict() }); return service.register({ email: 'someone@example.test', password }); };
    await assert.rejects(refusal(() => { throw new Error('secret detail'); }), (error: Error & { code?: string; reason?: string }) => error.code === 'registration_rejected' && error.reason === 'Registration not permitted');
    await assert.rejects(refusal(() => undefined), { code: 'registration_rejected' });
    await assert.rejects(refusal(() => ({ allow: 'yes' })), { code: 'registration_rejected' });
    await assert.rejects(refusal(() => ({ allow: false, reason: 'Closed\u0007 ' + 'x'.repeat(400) })), (error: { reason?: string }) => error.reason === ('Closed ' + 'x'.repeat(400)).slice(0, 256).trim() && !/\u0007/.test(error.reason));
    assert.equal((await service.listUsers()).users.length, 0);
    await refusal(() => ({ allow: true }));
    assert.equal((await service.listUsers()).users.length, 1);
});

test('every account-creating path runs beforeRegister and onAccountCreated with its method', async (t) => {
    const { service } = await setup(t, { registrationMode: 'open' });
    const seen: { hook: string; input: Record<string, unknown> }[] = [];
    let allow = true;
    service.attachLifecycleHooks({
        beforeRegister: async input => { seen.push({ hook: 'before', input: input as Record<string, unknown> }); return { allow }; },
        onAccountCreated: async input => { seen.push({ hook: 'created', input: input as Record<string, unknown> }); },
    });
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password });
    await service.register({ email: 'self@example.test', password });
    await service.createExternalAccount({ email: 'provider@example.test', provider: 'oidc', subject: 'one', emailVerified: true });
    const created = await service.adminCreateUser({ actorToken: admin.token, email: 'made@example.test', reason: 'Onboarding' });
    const { hash } = await import('bcryptjs'), passwordHash = await hash(password, 10);
    await service.importUsers([{ email: 'imported-a@example.test', passwordHash }, { email: 'imported-b@example.test', passwordHash }]);
    assert.deepEqual(seen.filter(item => item.hook === 'before').map(item => [item.input.email, item.input.method]), [['self@example.test', 'password'], ['provider@example.test', 'external'], ['made@example.test', 'administrator'], ['imported-a@example.test', 'import'], ['imported-b@example.test', 'import']]);
    assert.deepEqual(seen.filter(item => item.hook === 'created').map(item => [item.input.email, item.input.method, item.input.actorId]), [['owner@example.test', 'bootstrap', undefined], ['self@example.test', 'password', undefined], ['provider@example.test', 'external', undefined], ['made@example.test', 'administrator', admin.user.id], ['imported-a@example.test', 'import', undefined], ['imported-b@example.test', 'import', undefined]]);
    assert.equal(created.user.email, 'made@example.test');
    // One denied row refuses the whole import, naming its index, and writes nothing.
    allow = true;
    service.attachLifecycleHooks({ beforeRegister: async input => ({ allow: (input as { email: string }).email !== 'blocked@example.test', reason: 'Blocked address' }) });
    await assert.rejects(service.importUsers([{ email: 'fine@example.test', passwordHash }, { email: 'blocked@example.test', passwordHash }]), (error: { code?: string; reason?: string }) => error.code === 'registration_rejected' && error.reason === 'Row 1: Blocked address');
    assert.equal((await service.listUsers({ query: 'fine@' })).users.length, 0);
});

test('administrative role, status and case operations run beforeRoleChange and onAccountStatusChanged; the guards still hold', async (t) => {
    const { service } = await setup(t, { registrationMode: 'open' });
    const admin = await service.bootstrapAdmin({ email: 'owner@example.test', password }), second = await service.register({ email: 'second@example.test', password }), member = await service.register({ email: 'member@example.test', password });
    await service.adminSetRoles({ actorToken: admin.token, accountId: second.user.id, roles: ['admin'] });
    const checker = await service.login({ email: 'second@example.test', password });
    const roleChanges: Record<string, unknown>[] = [], statuses: Record<string, unknown>[] = [];
    let allow = true;
    const detach = service.attachLifecycleHooks({
        beforeRoleChange: async input => { roleChanges.push(input as Record<string, unknown>); return { allow, reason: 'Roles are frozen' }; },
        onAccountStatusChanged: async input => { statuses.push(input as Record<string, unknown>); },
    });
    await service.adminSetRoles({ actorToken: admin.token, accountId: member.user.id, roles: ['admin'], reason: 'Promotion' });
    assert.deepEqual(roleChanges[0], { accountId: member.user.id, currentRoles: ['member'], requestedRoles: ['admin'], actorId: admin.user.id, reason: 'Promotion' });
    allow = false;
    await assert.rejects(service.adminSetRoles({ actorToken: admin.token, accountId: member.user.id, roles: ['member'] }), (error: { code?: string; reason?: string }) => error.code === 'role_change_rejected' && error.reason === 'Roles are frozen');
    await assert.rejects(service.createCase({ actorToken: admin.token, accountId: member.user.id, action: 'roles', roles: ['member'], reason: 'Demote' }), { code: 'role_change_rejected' });
    assert.deepEqual((await service.getUser(member.user.id))!.roles, ['admin']);
    await service.adminSetStatus({ actorToken: admin.token, accountId: member.user.id, status: 'locked', reason: 'Investigation' });
    await service.adminBulk({ actorToken: admin.token, accountIds: [member.user.id], action: 'unlock', reason: 'Cleared' });
    const lock = await service.createCase({ actorToken: admin.token, accountId: member.user.id, action: 'lock', reason: 'Second look' });
    await service.approveCase({ actorToken: checker.token, caseId: lock.id, reason: 'Agreed' });
    assert.deepEqual(statuses.map(item => [item.status, item.actorId, item.reason]), [['locked', admin.user.id, 'Investigation'], ['active', admin.user.id, 'Cleared'], ['locked', second.user.id, 'Agreed']]);
    // A filter can only narrow: an allowing hook never lets the last administrator be demoted.
    allow = true;
    await service.adminSetRoles({ actorToken: checker.token, accountId: member.user.id, roles: ['member'], reason: 'Back' }).catch(() => undefined);
    detach();
    await service.adminSetRoles({ actorToken: admin.token, accountId: second.user.id, roles: ['member'], reason: 'Step down' });
    service.attachLifecycleHooks({ beforeRoleChange: async () => ({ allow: true }) });
    const lone = await service.login({ email: 'owner@example.test', password });
    await assert.rejects(service.adminSetRoles({ actorToken: lone.token, accountId: lone.user.id, roles: ['member'] }), (error: { code?: string }) => ['self_administration_denied', 'last_administrator_required'].includes(error.code ?? ''));
});

test('a detached attachment stops firing, and only the latest attachment runs', async (t) => {
    const { service } = await setup(t, { registrationMode: 'open' });
    const calls: string[] = [];
    const first = service.attachLifecycleHooks({ onAccountCreated: async () => { calls.push('first'); } });
    service.attachLifecycleHooks({ onAccountCreated: async () => { calls.push('second'); } });
    first();
    await service.register({ email: 'a@example.test', password });
    assert.deepEqual(calls, ['second']);
});

// The second caller of the hooks: the operator CLI fires the same set from the project beside its operator file.
test('the CLI fires the project hooks for bootstrap, import and purge, and refuses an unreadable project', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-cli-hooks-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const app = join(root, 'app'), marker = join(root, 'calls.json'), operator = join(root, 'operator.mjs'), database = join(root, 'accounts.sqlite');
    await mkdir(app);
    await writeFile(marker, '[]');
    await writeFile(join(app, 'hook.mjs'), `import { readFile, writeFile } from 'node:fs/promises';\nconst log = async (name, input) => { const calls = JSON.parse(await readFile(${JSON.stringify(marker)}, 'utf8')); calls.push({ name, ...input }); await writeFile(${JSON.stringify(marker)}, JSON.stringify(calls)); };\nexport const created = input => log('created', input);\nexport const deleted = input => log('deleted', input);\nexport const before = async input => { await log('before', input); return { allow: !input.email.startsWith('blocked') }; };\n`);
    await writeFile(join(app, 'urlcode.yaml'), JSON.stringify({ version: '1', extensions: { auth: { version: '1', config: { registration: 'off', hooks: { beforeRegister: { source: 'hook.mjs', export: 'before' }, onAccountCreated: { source: 'hook.mjs', export: 'created' }, onAccountDeleted: { source: 'hook.mjs', export: 'deleted' } } } } }, routes: {} }));
    await writeFile(operator, `import {createAuthService} from ${JSON.stringify(new URL('../src/auth-core.ts', import.meta.url).href)}; export default await createAuthService({database:${JSON.stringify(database)},encryptionKey:new Uint8Array(32).fill(7),roles:{member:[],admin:['*']},defaultRole:'member',registrationMode:'off',now:()=>Date.now()+Number(process.env.URLCODE_AUTH_TEST_CLOCK_OFFSET??0)});`);
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const run = (args: string[], input?: object, env: Record<string, string> = {}) => spawnSync(process.execPath, [cli, ...args, '--operator-file', operator], { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
    const calls = async () => JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>[];
    const bootstrap = run(['bootstrap'], { email: 'owner@example.test', password });
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const owner = JSON.parse(bootstrap.stdout) as { id: string };
    assert.deepEqual(await calls(), [{ name: 'created', accountId: owner.id, email: 'owner@example.test', method: 'bootstrap' }]);
    const { hash } = await import('bcryptjs'), passwordHash = await hash(password, 10);
    assert.equal(run(['import'], { users: [{ email: 'blocked@example.test', passwordHash }] }).status, 1);
    assert.equal(run(['import'], { users: [{ email: 'imported@example.test', passwordHash }] }).status, 0);
    assert.deepEqual((await calls()).slice(1).map(call => [call.name, call.email, call.method]), [['before', 'blocked@example.test', 'import'], ['before', 'imported@example.test', 'import'], ['created', 'imported@example.test', 'import']]);
    // Purge: schedule a deletion in-process with the same service, then purge after the grace period.
    const service = await createAuthService({ database, encryptionKey: new Uint8Array(32).fill(7), roles: { member: [], admin: ['*'] }, defaultRole: 'member', registrationMode: 'off' });
    const imported = (await service.listUsers({ query: 'imported@' })).users[0]!;
    const session = await service.login({ email: 'imported@example.test', password });
    await service.deleteAccount({ token: session.token, password });
    await service.close();
    assert.equal(run(['purge'], undefined, { URLCODE_AUTH_TEST_CLOCK_OFFSET: String(8 * 86400000) }).status, 0);
    assert.deepEqual((await calls()).at(-1), { name: 'deleted', accountId: imported.id });
    // An unreadable project refuses the command unless the operator opts out of project hooks.
    await rm(join(app, 'urlcode.yaml'));
    assert.equal(run(['import'], { users: [{ email: 'later@example.test', passwordHash }] }).status, 1);
    const optedOut = run(['import', '--no-project-hooks'], { users: [{ email: 'later@example.test', passwordHash }] });
    assert.equal(optedOut.status, 0, optedOut.stderr);
    // --project names another project directory.
    const other = join(root, 'other');
    await mkdir(other);
    await writeFile(join(other, 'urlcode.yaml'), JSON.stringify({ version: '1', routes: {} }));
    assert.equal(run(['import', '--project', other], { users: [{ email: 'elsewhere@example.test', passwordHash }] }).status, 0);
});
