export interface Verdict { allow: boolean; reason?: string }
export const calls: unknown[];
export let nextVerdict: Verdict;
export function setNextVerdict(verdict: Verdict): void;
declare function beforeRoleChange(input: unknown): Verdict;
export default beforeRoleChange;
