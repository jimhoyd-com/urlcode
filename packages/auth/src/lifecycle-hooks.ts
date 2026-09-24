// Project-level lifecycle hooks (README.md, urlcode-auth#35). A
// project names its own function per lifecycle point in `extensions.auth.config.hooks`,
// using the same `{source, export}` (or bare string) shape `function`/`middleware`
// routes already use. These hooks are first-party project code and run
// trusted, in-process, exactly like any other route's `function`/`middleware`
// (urlcode's docs/FUNCTION-SECURITY.md, docs/EXTENSIONS.md "Project-level
// lifecycle hooks"): no special case, no hardwired sandbox.
//
// Core's shared extension-hook primitive owns resolution, import and
// discovery. Contract v1 is trusted-only; `sandbox: true` is rejected at
// activation and never silently run trusted.
//
// Each activation re-imports the hook's ENTRY module under a fresh
// cache-busting query, mirroring core's trusted route activation
// (src/trusted-functions.ts, `urlcode-trusted-epoch`): Node's ESM loader
// caches a resolved module forever by URL, so without this an edited hook
// file kept returning its previous decision for the life of the process
// (jimhoyd-com/urlcode#198). Only the entry module is refreshed — modules the
// hook itself imports stay on Node's module cache, the same already-documented
// core limitation the trusted route path has; a change to a hook's own
// dependency still needs a process restart.
import { extensionHooksSchema, loadExtensionHooks } from '@jimhoyd/urlcode/extensions';
import type { ExtensionHookConfig, ExtensionHookContract } from '@jimhoyd/urlcode/extensions';
export type HookConfig = ExtensionHookConfig;
export interface LifecycleHooksConfig {
    beforeRegister?: HookConfig;
    onSignUp?: HookConfig;
    onDelete?: HookConfig;
}
interface BeforeRegisterInput {
    email: string;
    profile?: Record<string, unknown>;
}
interface BeforeRegisterVerdict {
    allow: boolean;
    reason?: string;
}
interface OnSignUpInput {
    accountId: string;
    email: string;
}
interface OnDeleteInput {
    accountId: string;
    email: string;
}
export interface LifecycleHooks {
    beforeRegister?(input: BeforeRegisterInput): BeforeRegisterVerdict | Promise<BeforeRegisterVerdict>;
    onSignUp?(input: OnSignUpInput): void | Promise<void>;
    onDelete?(input: OnDeleteInput): void | Promise<void>;
}
export const authHookContracts = [
    { name: 'beforeRegister', kind: 'filter', description: 'Runs before account creation and may return an allow/deny verdict.', inputSchema: { type: 'object', additionalProperties: false, required: ['email'], properties: { email: { type: 'string' }, profile: { type: 'object' } } }, outputSchema: { type: 'object', additionalProperties: false, required: ['allow'], properties: { allow: { type: 'boolean' }, reason: { type: 'string' } } } },
    { name: 'onSignUp', kind: 'action', description: 'Runs after a new account is created.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId', 'email'], properties: { accountId: { type: 'string' }, email: { type: 'string' } } } },
    { name: 'onDelete', kind: 'action', description: 'Runs after an account owner schedules deletion.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId', 'email'], properties: { accountId: { type: 'string' }, email: { type: 'string' } } } },
] as const satisfies readonly ExtensionHookContract[];
export const hooksConfigSchema = extensionHooksSchema(authHookContracts);
/**
 * Resolves and eagerly imports every declared hook, so a missing module, a
 * syntax error or a missing export fails activation (fail-fast), never the
 * first request that happens to reach the hook. `sandbox: true` is rejected
 * here, immediately and explicitly, rather than accepted and silently run
 * trusted.
 */
export async function loadLifecycleHooks(config: LifecycleHooksConfig | undefined, root: string): Promise<LifecycleHooks> {
    return await loadExtensionHooks<keyof LifecycleHooksConfig>(config as Readonly<Record<string, unknown>> | undefined, authHookContracts, { root }) as LifecycleHooks;
}
