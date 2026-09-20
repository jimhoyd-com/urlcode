import { extensionHooksSchema, loadExtensionHooks } from '@jimhoyd/urlcode/extensions';
import type { ExtensionHookConfig, ExtensionHookContract } from '@jimhoyd/urlcode/extensions';

/**
 * Project-level lifecycle hooks: the shape documented in core's
 * docs/EXTENSIONS.md ("Project-level lifecycle hooks") — a `hooks` block in
 * the extension's own `config` naming a project function per lifecycle
 * point, using the same source shape `function`/`middleware` routes already
 * use (a bare string, or `{source, export}`), resolved relative to
 * `ExtensionActivation.root`.
 *
 * Trust model: these hooks are first-party project code and run trusted,
 * in-process, exactly like the general trusted-by-default rule for
 * `function`/`middleware` routes (docs/SPIKE-DEFAULT-TRUST-MODEL.md). Core's
 * shared extension-hook primitive owns resolution, import and discovery.
 * Contract v1 rejects `sandbox: true` during activation.
 */

/** A hook reference: a bare source path (default export), or an explicit `{source, export}`. */
export type HookConfig = ExtensionHookConfig;

export interface AdminHooksConfig {
    /**
     * Pre-action, veto-capable: called before an administrator's role change
     * is applied. Returning `{allow: false}` blocks the change; the
     * operation never reaches the auth service.
     */
    beforeRoleChange?: HookConfig;
    /** Post-action, side-effect only: called after a registration request is approved. */
    onRegistrationApproved?: HookConfig;
    /** Post-action, side-effect only: called after an account is locked or unlocked. */
    onAccountStatusChanged?: HookConfig;
}

/** JSON Schema fragment for the `hooks` block, merged into the extension's own config schema. */
export const adminHookContracts = [
    { name: 'beforeRoleChange', kind: 'filter', description: 'Runs before an administrator changes account roles and may return an allow/deny verdict.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId', 'currentRoles', 'requestedRoles', 'actorId', 'reason'], properties: { accountId: { type: 'string' }, currentRoles: { type: 'array', items: { type: 'string' } }, requestedRoles: { type: 'array', items: { type: 'string' } }, actorId: { type: 'string' }, reason: { type: 'string' } } }, outputSchema: { type: 'object', additionalProperties: false, required: ['allow'], properties: { allow: { type: 'boolean' }, reason: { type: 'string' } } } },
    { name: 'onRegistrationApproved', kind: 'action', description: 'Runs after a waitlisted registration is approved.', inputSchema: { type: 'object', additionalProperties: false, required: ['requestId', 'accountId', 'email', 'actorId', 'reason'], properties: { requestId: { type: 'string' }, accountId: { type: 'string' }, email: { type: 'string' }, actorId: { type: 'string' }, reason: { type: 'string' } } } },
    { name: 'onAccountStatusChanged', kind: 'action', description: 'Runs after an account is locked or unlocked.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId', 'status', 'actorId', 'reason'], properties: { accountId: { type: 'string' }, status: { type: 'string', enum: ['active', 'locked'] }, actorId: { type: 'string' }, reason: { type: 'string' } } } },
] as const satisfies readonly ExtensionHookContract[];
export const adminHooksSchema = extensionHooksSchema(adminHookContracts);

/** Typed verdict for a pre-action hook that can veto. */
export interface HookVerdict { allow: boolean; reason?: string }

export interface RoleChangeInput {
    accountId: string;
    currentRoles: readonly string[];
    requestedRoles: readonly string[];
    actorId: string;
    reason: string;
}

export interface RegistrationApprovedInput {
    requestId: string;
    accountId: string;
    email: string;
    actorId: string;
    reason: string;
}

export interface AccountStatusChangedInput {
    accountId: string;
    status: 'active' | 'locked';
    actorId: string;
    reason: string;
}

export interface LoadedAdminHooks {
    beforeRoleChange?: (input: RoleChangeInput) => HookVerdict | Promise<HookVerdict>;
    onRegistrationApproved?: (input: RegistrationApprovedInput) => void | Promise<void>;
    onAccountStatusChanged?: (input: AccountStatusChangedInput) => void | Promise<void>;
}

/**
 * Resolves and imports every declared hook module against `root`
 * (`ExtensionActivation.root`), trusted and in-process. Fails fast: a
 * missing module, a missing/non-function export, or `sandbox: true` throws
 * here, during activation, so a broken or unsupported hook never reaches a
 * live request.
 *
 * Each activation re-imports the hook's ENTRY module under a fresh
 * cache-busting query, mirroring core's trusted route activation
 * (`src/trusted-functions.ts`, `urlcode-trusted-epoch`). Node's ESM loader
 * caches a resolved module forever by URL, so without this an edited hook file
 * kept returning its previous decision for the life of the process
 * (jimhoyd-com/urlcode#198). Only the entry module is refreshed — modules the
 * hook itself imports stay on Node's module cache, the same already-documented
 * core limitation the trusted route path has; a change to a hook's own
 * dependency still needs a process restart.
 */
export async function loadAdminHooks(config: Readonly<Record<string, unknown>>, root: string): Promise<LoadedAdminHooks> {
    return await loadExtensionHooks<keyof AdminHooksConfig>(config.hooks as Readonly<Record<string, unknown>> | undefined, adminHookContracts, { root }) as LoadedAdminHooks;
}
