import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup } from './cleanup.ts';

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

