/**
 * Fixture project hook: named export (not `default`), records calls.
 *
 * State lives on `globalThis` so it is shared with the statically imported
 * copy: each activation imports this entry module under a fresh cache-busting
 * query (see `loadAdminHooks`).
 */
const state = (globalThis.__urlcodeAdminRegistrationApprovedHook ??= { calls: [] });
export const calls = state.calls;
export function onApproved(input) {
    state.calls.push(input);
}
