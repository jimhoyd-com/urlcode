/**
 * Fixture project hook for admin-hooks.test.ts: records calls and returns a
 * controllable verdict.
 *
 * State lives on `globalThis` rather than in module scope: every activation
 * imports this entry module under a fresh cache-busting query (see
 * `loadAdminHooks`), so a module-scoped array would not be the same array the
 * test statically imported.
 */
const state = (globalThis.__urlcodeAdminRoleChangeHook ??= { calls: [], nextVerdict: { allow: true } });
export const calls = state.calls;
export function setNextVerdict(verdict) { state.nextVerdict = verdict; }
export default function beforeRoleChange(input) {
    state.calls.push(input);
    return state.nextVerdict;
}
