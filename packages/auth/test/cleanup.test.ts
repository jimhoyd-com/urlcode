import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
