/** Fixture project hook: named export (not `default`), records calls. */
export const calls = [];
export function onApproved(input) {
    calls.push(input);
}
