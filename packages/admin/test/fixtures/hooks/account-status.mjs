/** Fixture project hook for admin-hooks.test.ts: default export, records calls. */
export const calls = [];
export default function onAccountStatusChanged(input) {
    calls.push(input);
}
