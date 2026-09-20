/**
 * Fixture project hook for admin-hooks.test.ts: default export, records calls.
 *
 * State lives on `globalThis` so it is shared with the statically imported
 * copy: each activation imports this entry module under a fresh cache-busting
 * query (see `loadAdminHooks`).
 */
const state = (globalThis.__urlcodeAdminAccountStatusHook ??= { calls: [] });
export const calls = state.calls;
export default function onAccountStatusChanged(input) {
    state.calls.push(input);
}
