import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
 * `function`/`middleware` routes (docs/SPIKE-DEFAULT-TRUST-MODEL.md). This
 * package does not implement sandboxed hook execution yet — that requires a
 * core dispatch primitive extensions do not have (jimhoyd-com/urlcode#151).
 * A hook that declares `sandbox: true` is rejected explicitly at activation
 * time (see `loadAdminHooks` below); it is never silently run trusted.
 */

/** A hook reference: a bare source path (default export), or an explicit `{source, export}`. */
export interface HookDefinition { source: string; export?: string; sandbox?: boolean }
export type HookConfig = string | HookDefinition;

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
const hookDefinitionSchema = {
    oneOf: [
        { type: 'string', minLength: 1, maxLength: 1024 },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                source: { type: 'string', minLength: 1, maxLength: 1024 },
                export: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
                sandbox: { type: 'boolean' },
            },
            required: ['source'],
        },
    ],
} as const;

export const adminHooksSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        beforeRoleChange: hookDefinitionSchema,
        onRegistrationApproved: hookDefinitionSchema,
        onAccountStatusChanged: hookDefinitionSchema,
    },
} as const;

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

const HOOK_NAMES = ['beforeRoleChange', 'onRegistrationApproved', 'onAccountStatusChanged'] as const;

/**
 * Resolves and imports every declared hook module against `root`
 * (`ExtensionActivation.root`), trusted and in-process. Fails fast: a
 * missing module, a missing/non-function export, or `sandbox: true` throws
 * here, during activation, so a broken or unsupported hook never reaches a
 * live request.
 */
export async function loadAdminHooks(config: Readonly<Record<string, unknown>>, root: string): Promise<LoadedAdminHooks> {
    const hooks = (config.hooks ?? {}) as AdminHooksConfig;
    const loaded: Record<string, (input: never) => unknown> = {};
    for (const name of HOOK_NAMES) {
        const raw = hooks[name];
        if (raw === undefined)
            continue;
        const definition: HookDefinition = typeof raw === 'string' ? { source: raw } : raw;
        if (definition.sandbox === true)
            throw new Error(`hook ${name}: sandbox: true is not yet supported for project-level hooks, see jimhoyd-com/urlcode-admin#32`);
        const exportName = definition.export || 'default';
        const modulePath = resolve(root, definition.source);
        let mod: Record<string, unknown>;
        try {
            mod = await import(pathToFileURL(modulePath).href) as Record<string, unknown>;
        }
        catch (error) {
            throw new Error(`hook ${name}: failed to load module "${definition.source}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        const fn = mod[exportName];
        if (typeof fn !== 'function')
            throw new Error(`hook ${name}: export "${exportName}" of "${definition.source}" is not a function`);
        loaded[name] = fn as (input: never) => unknown;
    }
    return loaded as LoadedAdminHooks;
}
