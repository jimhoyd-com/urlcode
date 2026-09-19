/** Fixture project hook for admin-hooks.test.ts: records calls and returns a controllable verdict. */
export const calls = [];
export let nextVerdict = { allow: true };
export function setNextVerdict(verdict) { nextVerdict = verdict; }
export default function beforeRoleChange(input) {
    calls.push(input);
    return nextVerdict;
}
