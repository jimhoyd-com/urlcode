import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createAuthService } from '../src/auth-core.ts';
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url)), core = JSON.stringify(new URL('../src/auth-core.ts', import.meta.url).href);
const roles = { member: [], admin: ['*'] }, password = 'synthetic operations passphrase';
// The operator module mirrors the in-process options so the pinned configuration matches; the clock offset lets purge observe an elapsed grace period.
async function fixture(name: string, keys = 'encryptionKey:new Uint8Array(32).fill(7)') {
    const root = await mkdtemp(join(tmpdir(), name)), operator = join(root, 'operator.mjs'), database = join(root, 'accounts.sqlite');
    await mkdir(join(root, 'app'));
    await writeFile(operator, `import {createAuthService} from ${core}; export default await createAuthService({database:${JSON.stringify(database)},${keys},roles:{member:[],admin:['*']},defaultRole:'member',now:()=>Date.now()+Number(process.env.URLCODE_AUTH_TEST_CLOCK_OFFSET??0)});`);
    const run = (command: string, input?: string | object, env: Record<string, string> = {}) => spawnSync(process.execPath, [cli, command, ...(['backup', 'restore', 'verify-deployment'].includes(command) ? [] : ['--operator-file', operator])], { input: input === undefined ? undefined : typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 20000, env: { ...process.env, ...env } });
    return { root, database, run };
}
test('import accepts only the allow-listed fields and users/audit list without secrets', async (t) => {
    const { root, database, run } = await fixture('urlcode-auth-cli-import-');
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const { hash } = await import('bcryptjs'), passwordHash = await hash(password, 10);
    const imported = run('import', { users: [{ email: 'legacy@example.com', passwordHash, emailVerified: true }] });
    assert.equal(imported.status, 0, imported.stderr);
    assert.deepEqual(JSON.parse(imported.stdout), { imported: 1 });
    for (const bad of [{ users: [{ email: 'x@example.com', passwordHash, roles: ['admin'] }] }, { users: [{ email: 'y@example.com', passwordHash, emailVerified: 'yes' }] }, { users: { email: 'z@example.com', passwordHash } }, '{"users":[', '[]', JSON.stringify({ users: [], pad: 'x'.repeat(1048576) })]) {
        const rejected = run('import', bad);
        assert.equal(rejected.status, 1);
        assert.ok(!rejected.stderr.includes(passwordHash));
    }
    const users = run('users');
    assert.equal(users.status, 0, users.stderr);
    const listed = JSON.parse(users.stdout) as { users: { email: string; roles: string[] }[] };
    assert.deepEqual(listed.users.map(user => user.email), ['legacy@example.com']);
    assert.deepEqual(listed.users[0]!.roles, ['member']);
    assert.ok(!users.stdout.includes('passwordHash') && !users.stdout.includes(passwordHash));
    const audit = run('audit');
    assert.equal(audit.status, 0, audit.stderr);
    assert.ok(Array.isArray(JSON.parse(audit.stdout).events));
    assert.ok(!audit.stdout.includes(passwordHash));
    const service = await createAuthService({ database, encryptionKey: new Uint8Array(32).fill(7), roles, defaultRole: 'member' });
    cleanup(t, () => service.close());
    const login = await service.login({ email: 'legacy@example.com', password });
    assert.equal(login.user.emailVerified, true);
});
test('rotate-key keeps accounts usable and restore reopens a backup taken afterwards', async (t) => {
    const legacy = new Uint8Array(32).fill(7), next = new Uint8Array(32).fill(9);
    const { root, database, run } = await fixture('urlcode-auth-cli-rotate-', 'encryptionKeys:{legacy:new Uint8Array(32).fill(7),next:new Uint8Array(32).fill(9)},activeEncryptionKey:"next"');
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const original = await createAuthService({ database, encryptionKey: legacy, roles, defaultRole: 'member' });
    const user = await original.register({ email: 'rotate@example.com', password });
    await original.beginTotp(user.token);
    await original.close();
    const rotated = run('rotate-key');
    assert.equal(rotated.status, 0, rotated.stderr);
    const report = JSON.parse(rotated.stdout) as { changed: number; remaining: number };
    assert.ok(report.changed >= 1);
    assert.equal(report.remaining, 0);
    const retired = await createAuthService({ database, encryptionKeys: { next }, activeEncryptionKey: 'next', roles, defaultRole: 'member' });
    assert.equal((await retired.login({ email: 'rotate@example.com', password })).user.id, user.user.id);
    await retired.close();
    const snapshot = join(root, 'snapshot.sqlite'), restored = join(root, 'restored.sqlite'), projectRoot = join(root, 'app');
    const backup = run('backup', { database, destination: snapshot, projectRoot });
    assert.equal(backup.status, 0, backup.stderr);
    assert.equal(JSON.parse(backup.stdout).format, 'urlcode-auth-sqlite-v1');
    const restore = run('restore', { backup: snapshot, destination: restored, projectRoot });
    assert.equal(restore.status, 0, restore.stderr);
    assert.equal(run('restore', { backup: snapshot, destination: restored, projectRoot }).status, 1);
    const recovered = await createAuthService({ database: restored, encryptionKeys: { next }, activeEncryptionKey: 'next', roles, defaultRole: 'member' });
    cleanup(t, () => recovered.close());
    assert.equal((await recovered.login({ email: 'rotate@example.com', password })).user.id, user.user.id);
});
test('purge removes only accounts whose deletion grace has elapsed', async (t) => {
    const { root, database, run } = await fixture('urlcode-auth-cli-purge-');
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const options = { database, encryptionKey: new Uint8Array(32).fill(7), roles, defaultRole: 'member' };
    const service = await createAuthService(options);
    await service.bootstrapAdmin({ email: 'owner@example.com', password });
    const user = await service.register({ email: 'leaving@example.com', password });
    await service.deleteAccount({ token: user.token, password });
    await service.close();
    const early = run('purge');
    assert.equal(early.status, 0, early.stderr);
    assert.deepEqual(JSON.parse(early.stdout), { purged: 0 });
    const late = run('purge', undefined, { URLCODE_AUTH_TEST_CLOCK_OFFSET: String(8 * 86400000) });
    assert.equal(late.status, 0, late.stderr);
    assert.deepEqual(JSON.parse(late.stdout), { purged: 1 });
    const reopened = await createAuthService(options);
    cleanup(t, () => reopened.close());
    assert.equal(await reopened.getUser(user.user.id), null);
    assert.equal((await reopened.dashboard()).users, 1);
});
test('api-key-issue accepts a key quota on stdin, refuses an invalid one, and api-key-list reports it (urlcode#703)', async (t) => {
    const { root, database, run } = await fixture('urlcode-auth-cli-api-key-quota-');
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const planned = run('api-key-issue', { name: 'plan-gold', scopes: ['items.read'], quota: { requests: 5000, window: 3600 } });
    assert.equal(planned.status, 0, planned.stderr);
    const issued = JSON.parse(planned.stdout) as { id: string; key: string; quota: unknown };
    assert.deepEqual(issued.quota, { requests: 5000, window: 3600 });
    const plain = run('api-key-issue', { name: 'plain', scopes: ['items.read'] });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(JSON.parse(plain.stdout).quota, null);
    for (const quota of [{ requests: 0, window: 60 }, { requests: 10, window: 2592001 }, { requests: 10 }, { requests: 10, window: 60, burst: 1 }, [10, 60], 'ten', null]) {
        const refused = run('api-key-issue', { name: 'bad', scopes: ['items.read'], quota });
        assert.equal(refused.status, 1, JSON.stringify(quota));
        assert.equal(refused.stdout, '');
    }
    const listed = run('api-key-list');
    assert.equal(listed.status, 0, listed.stderr);
    const keys = JSON.parse(listed.stdout) as { id: string; name: string; quota: unknown }[];
    assert.deepEqual(keys.map(key => key.name).sort(), ['plain', 'plan-gold']);
    assert.deepEqual(keys.find(key => key.id === issued.id)!.quota, { requests: 5000, window: 3600 });
    assert.ok(!listed.stdout.includes(issued.key));
    const service = await createAuthService({ database, encryptionKey: new Uint8Array(32).fill(7), roles, defaultRole: 'member' });
    cleanup(t, () => service.close());
    assert.deepEqual((await service.authenticateApiKey(issued.key))?.quota, { requests: 5000, window: 3600 });
});
test('api-key-issue links a key to an existing user with userId, refuses an unknown one, and api-key-list reports it (urlcode#732)', async (t) => {
    const { root, database, run } = await fixture('urlcode-auth-cli-api-key-user-');
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const service = await createAuthService({ database, encryptionKey: new Uint8Array(32).fill(7), roles, defaultRole: 'member' });
    const user = await service.register({ email: 'agent-owner@example.com', password });
    await service.close();
    const linked = run('api-key-issue', { name: 'agent', scopes: ['items.read'], userId: user.user.id });
    assert.equal(linked.status, 0, linked.stderr);
    const issued = JSON.parse(linked.stdout) as { id: string; key: string; userId: unknown };
    assert.equal(issued.userId, user.user.id);
    const plain = run('api-key-issue', { name: 'service', scopes: ['items.read'] });
    assert.equal(JSON.parse(plain.stdout).userId, null);
    for (const userId of ['00000000-0000-4000-8000-000000000000', 7, null, '']) {
        const refused = run('api-key-issue', { name: 'bad', scopes: ['items.read'], userId });
        assert.equal(refused.status, 1, JSON.stringify(userId));
        assert.equal(refused.stdout, '');
    }
    const listed = JSON.parse(run('api-key-list').stdout) as { id: string; userId: unknown; userDisabled: boolean }[];
    assert.deepEqual(listed.map(key => key.userId).sort(), [null, user.user.id].sort());
    assert.equal(listed.find(key => key.id === issued.id)!.userDisabled, false);
    const reopened = await createAuthService({ database, encryptionKey: new Uint8Array(32).fill(7), roles, defaultRole: 'member' });
    cleanup(t, () => reopened.close());
    assert.equal((await reopened.authenticateApiKey(issued.key))?.userId, user.user.id);
});
