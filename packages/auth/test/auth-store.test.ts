import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { awaitStoreStartup, patched, startupPhase } from '../src/auth-store.ts';
import { createAuthService } from '../src/auth-core.ts';
const detail = (error: unknown): string => String((error as { cause?: unknown }).cause instanceof Error ? ((error as { cause: Error }).cause).message : '');
const options = { encryptionKey: Buffer.alloc(32, 7), roles: { member: [], admin: ['*'] }, defaultRole: 'member' };
test('SQLite gate accepts only patched release lines', () => {
    for (const version of ['3.51.3', '3.51.10', '3.52.0', '3.53.4', '4.0.0', '3.50.7', '3.50.9', '3.44.6', '3.44.9']) assert.equal(patched(version), true, version);
    for (const version of ['', '3', '3.51', '3.51.2', '3.50.6', '3.49.2', '3.45.0', '3.44.5', '3.43.9', '2.9.9', 'x.y.z']) assert.equal(patched(version), false, version);
});
test('an elapsed startup bound names the phase the worker reached', async () => {
    const scheduling = new EventEmitter();
    await assert.rejects(awaitStoreStartup(scheduling, 25), (error: Error) => {
        assert.equal((error as Error & { code: string }).code, 'auth_store_unavailable');
        assert.match(detail(error), /^worker thread did not begin executing within \d+ms$/);
        return true;
    });
    const initializing = new EventEmitter();
    const pending = assert.rejects(awaitStoreStartup(initializing, 60), (error: Error) => {
        assert.equal((error as Error & { code: string }).code, 'auth_store_unavailable');
        assert.match(detail(error), /^worker thread began executing after \d+ms, then did not report readiness for a further \d+ms \(no startup stage reached: the database open itself had not returned\)$/);
        return true;
    });
    initializing.emit('online');
    await pending;
    const staged = new EventEmitter();
    const stagedPending = assert.rejects(awaitStoreStartup(staged, 60), (error: Error) => {
        assert.match(detail(error), /\(last startup stage reached: journal mode set\)$/);
        return true;
    });
    staged.emit('online');
    staged.emit('message', { stage: 'database opened' });
    staged.emit('message', { stage: 'journal mode set' });
    await stagedPending;
    assert.equal(staged.listenerCount('message'), 0, 'an elapsed bound leaves no listener behind');
    // The phase text is derived, not reconstructed by the reader.
    assert.equal(startupPhase(undefined, 15000), 'worker thread did not begin executing within 15000ms');
    assert.equal(startupPhase(40, 15000), 'worker thread began executing after 40ms, then did not report readiness for a further 14960ms (no startup stage reached: the database open itself had not returned)');
    assert.equal(startupPhase(40, 15000, 'journal mode set'), 'worker thread began executing after 40ms, then did not report readiness for a further 14960ms (last startup stage reached: journal mode set)');
});
test('startup reports a worker that fails or exits instead of waiting out its bound', async () => {
    const exiting = new EventEmitter(), started = Date.now();
    const pending = assert.rejects(awaitStoreStartup(exiting, 15000), (error: Error) => {
        assert.equal((error as Error & { code: string }).code, 'auth_store_unavailable');
        assert.match(detail(error), /^worker exited with code 7 after \d+ms without reporting readiness$/);
        return true;
    });
    exiting.emit('exit', 7);
    await pending;
    assert.ok(Date.now() - started < 5000, 'an exited worker must not be held until the bound elapses');
    const failing = new EventEmitter();
    const failure = assert.rejects(awaitStoreStartup(failing, 15000), (error: Error) => {
        assert.match(detail(error), /^worker failed after \d+ms: thread died$/);
        return true;
    });
    failing.emit('error', new Error('thread died'));
    await failure;
});
test('startup keeps the worker-reported configuration codes and accepts readiness', async () => {
    const ready = new EventEmitter(), accepted = awaitStoreStartup(ready, 15000);
    ready.emit('message', { ready: true });
    await accepted;
    const changed = new EventEmitter(), rejected = assert.rejects(awaitStoreStartup(changed, 15000), { code: 'auth_configuration_changed', status: 503 });
    changed.emit('message', { error: 'auth_configuration_changed' });
    await rejected;
    const unknown = new EventEmitter();
    const opaque = assert.rejects(awaitStoreStartup(unknown, 15000), (error: Error) => {
        assert.equal((error as Error & { code: string }).code, 'auth_store_unavailable');
        assert.match(detail(error), /^worker reported database_missing after \d+ms$/);
        return true;
    });
    unknown.emit('message', { error: 'database_missing' });
    await opaque;
});
test('store refuses an unpatched host SQLite before touching the database path', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-store-gate-')), descriptor = Object.getOwnPropertyDescriptor(process.versions, 'sqlite')!;
    cleanup(t, async () => { Object.defineProperty(process.versions, 'sqlite', descriptor); await rm(root, { recursive: true, force: true }); });
    Object.defineProperty(process.versions, 'sqlite', { ...descriptor, value: '3.51.2' });
    await assert.rejects(createAuthService({ ...options, database: join(root, 'accounts.sqlite') }), { code: 'patched_sqlite_required' });
    Object.defineProperty(process.versions, 'sqlite', descriptor);
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(root), []);
});
test('store refuses symlinked, hard-linked, group/world-readable or non-file database paths', { skip: process.platform === 'win32' }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-store-path-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'target.sqlite'), '', { mode: 0o600 });
    await symlink(join(root, 'target.sqlite'), join(root, 'alias.sqlite'));
    await assert.rejects(createAuthService({ ...options, database: join(root, 'alias.sqlite') }), { code: 'invalid_auth_database' });
    await link(join(root, 'target.sqlite'), join(root, 'twin.sqlite'));
    await assert.rejects(createAuthService({ ...options, database: join(root, 'target.sqlite') }), { code: 'invalid_auth_database' });
    await writeFile(join(root, 'shared.sqlite'), '', { mode: 0o644 });
    await assert.rejects(createAuthService({ ...options, database: join(root, 'shared.sqlite') }), { code: 'invalid_auth_database' });
    await mkdir(join(root, 'directory.sqlite'));
    await assert.rejects(createAuthService({ ...options, database: join(root, 'directory.sqlite') }), { code: 'invalid_auth_database' });
    await assert.rejects(createAuthService({ ...options, database: join(root, 'missing', 'accounts.sqlite') }), { code: 'ENOENT' });
    const service = await createAuthService({ ...options, database: join(root, 'private.sqlite') });
    await service.close();
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(join(root, 'private.sqlite'))).mode & 0o077, 0);
});
