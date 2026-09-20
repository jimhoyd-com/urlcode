import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { setImmediate } from 'node:timers/promises';
import { cleanup } from './cleanup.ts';
import { createAuthService } from '../src/auth-core.ts';

test('fixture cleanup unwinds every resource even when a closer fails', async () => {
    let finish!: () => Promise<void>;
    const context = { after(callback: () => Promise<void>) { finish = callback; } };
    const order: string[] = [];
    cleanup(context, () => { order.push('directory'); });
    cleanup(context, async () => { await Promise.resolve(); order.push('database'); });
    cleanup(context, () => { order.push('server'); throw new Error('synthetic close failure'); });
    await assert.rejects(finish(), (error: unknown) => {
        assert(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        return true;
    });
    assert.deepEqual(order, ['server', 'database', 'directory']);
});

test('fixture cleanup closes all SQLite workers before deleting their directory', async t => {
    const root = await mkdtemp(join(tmpdir(), 'cleanup-order-'));
    // Emergency cleanup belongs to the parent, after the child fixture is done.
    t.after(() => rm(root, { recursive: true, force: true }));
    await t.test('two services share the fixture', async child => {
        cleanup(child, () => rm(root, { recursive: true, force: true }));
        for (const name of ['first', 'second']) {
            const service = await createAuthService({ database: join(root, `${name}.sqlite`),
                encryptionKey: Buffer.alloc(32, 7), roles: { member: [] }, defaultRole: 'member' });
            cleanup(child, () => service.close());
            assert(await service.getConfigurationRevision());
        }
    });
    await assert.rejects(stat(root), { code: 'ENOENT' });
});


test('rejected service initialization waits for its SQLite worker to terminate', { timeout: 30000 }, async t => {
    const root = await mkdtemp(join(tmpdir(), 'cleanup-rejected-open-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const options = { database: join(root, 'auth.sqlite'), encryptionKey: Buffer.alloc(32, 7), roles: { member: [] }, defaultRole: 'member' };
    const service = await createAuthService(options);
    await service.close();
    const terminate = Worker.prototype.terminate;
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    t.mock.method(Worker.prototype, 'terminate', async function (this: Worker) {
        entered();
        await blocked;
        return terminate.call(this);
    });
    let settled = false;
    const opening = createAuthService({ ...options, encryptionKey: Buffer.alloc(32, 8) });
    const rejected = assert.rejects(opening, { code: 'auth_configuration_changed' });
    void opening.then(() => { settled = true; }, () => { settled = true; });
    try {
        await started;
        await setImmediate();
        assert.equal(settled, false, 'caller must not observe rejection before worker termination');
    } finally {
        release();
        await rejected;
    }
    await rm(root, { recursive: true, force: true });
});
