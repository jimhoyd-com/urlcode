// Kept inside each package so isolated published-peer tests are self-contained.
// node:test after hooks run in registration order, not resource-unwind order.
type Cleanup = () => unknown | Promise<unknown>;
type Context = { after(callback: () => Promise<void>): void };
const stacks = new WeakMap<Context, Cleanup[]>();

export function cleanup(context: Context, callback: Cleanup): void {
    let stack = stacks.get(context);
    if (!stack) {
        stack = [];
        stacks.set(context, stack);
        const callbacks = stack;
        context.after(async () => {
            const errors: unknown[] = [];
            while (callbacks.length) {
                try { await callbacks.pop()!(); }
                catch (error) { errors.push(error); }
            }
            stacks.delete(context);
            if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
        });
    }
    stack.push(callback);
}
