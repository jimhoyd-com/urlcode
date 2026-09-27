// Project-level lifecycle hooks (README.md "Project-level lifecycle hooks"). A project names its own function per
// lifecycle point in `extensions.auth.config.hooks`, using the same `{source, export}` (or bare string) shape
// `function`/`middleware` routes use. They are first-party project code and run trusted, in-process, like any other
// route's function (docs/FUNCTION-SECURITY.md); `sandbox: true` is refused by core's loader at activation.
//
// The auth service fires them, so every caller gets the same set: auth's own pages, `auth.administration` and the
// operator CLI. Filters (`beforeRegister`, `beforeRoleChange`) run before the store transaction and can only narrow:
// every guard still runs inside the transaction. Actions run after the commit and never change its result.
//
// Each activation re-imports the hook's entry module under a fresh cache-busting query (core's loader), so an edited
// hook takes effect on the next activation; modules the hook itself imports stay on Node's module cache.
import { extensionHookContext, extensionHooksSchema, loadExtensionHooks } from '@jimhoyd/urlcode/extensions';
import type { ExtensionHookContext, ExtensionHookContract, LoadedExtensionHooks } from '@jimhoyd/urlcode/extensions';
import { AuthError } from './auth-store.ts';

const verdict = { type: 'object', additionalProperties: false, required: ['allow'], properties: { allow: { type: 'boolean', description: 'false refuses the change with 403 and the reason.' }, reason: { type: 'string', description: 'Why the change was refused (at most 256 characters, control characters removed); returned with the 403.' } } } as const;
const registrationMethods = ['password', 'signup', 'external', 'waitlist', 'invitation', 'administrator', 'import'] as const;
export const authHookContracts = [
    { name: 'beforeRegister', kind: 'filter', description: 'Runs before any path creates an account (self-service, provider sign-up, waitlist request, administrator creation, import) and may deny it.', inputSchema: { type: 'object', additionalProperties: false, required: ['email', 'method'], properties: { email: { type: 'string', description: 'Normalized email address of the account to be created.' }, method: { enum: registrationMethods, description: 'The path creating the account.' }, profile: { type: 'object', description: 'Registration profile fields, when the path collects them.' } } }, outputSchema: verdict },
    { name: 'beforeRoleChange', kind: 'filter', description: 'Runs before an account\'s roles change (direct, case, case approval, bulk account operation) and may deny it.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId', 'currentRoles', 'requestedRoles', 'actorId', 'reason'], properties: { accountId: { type: 'string', description: 'Id of the account whose roles change.' }, currentRoles: { type: 'array', items: { type: 'string' }, description: 'Roles the account holds now.' }, requestedRoles: { type: 'array', items: { type: 'string' }, description: 'Roles it would hold after the change.' }, actorId: { type: 'string', description: 'Id of the account making the change.' }, reason: { type: 'string', description: 'The reason recorded for the change.' } } }, outputSchema: verdict },
    { name: 'onAccountCreated', kind: 'action', description: 'Runs after an account is created, by any path.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId', 'email', 'method'], properties: { accountId: { type: 'string', description: 'Id of the new account.' }, email: { type: 'string', description: 'Its email address.' }, method: { enum: [...registrationMethods, 'bootstrap'], description: 'The path that created it.' }, actorId: { type: 'string', description: 'The administrator who created it, when one did.' } } } },
    { name: 'onAccountStatusChanged', kind: 'action', description: 'Runs after an administrator locks or unlocks an account.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId', 'status', 'actorId', 'reason'], properties: { accountId: { type: 'string', description: 'Id of the account.' }, status: { enum: ['active', 'locked'], description: 'Its new status.' }, actorId: { type: 'string', description: 'The administrator who changed it.' }, reason: { type: 'string', description: 'The reason recorded for the change.' } } } },
    { name: 'onDeletionScheduled', kind: 'action', description: 'Runs after an account\'s deletion is scheduled, by its owner (no actorId) or an administrator.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId', 'email', 'deleteAfter'], properties: { accountId: { type: 'string', description: 'Id of the account.' }, email: { type: 'string', description: 'Its email address.' }, deleteAfter: { type: 'integer', description: 'When the purge becomes due, in epoch milliseconds.' }, actorId: { type: 'string', description: 'The administrator who scheduled it; absent when the owner did.' } } } },
    { name: 'onAccountDeleted', kind: 'action', description: 'Runs after a scheduled deletion is purged.', inputSchema: { type: 'object', additionalProperties: false, required: ['accountId'], properties: { accountId: { type: 'string', description: 'Id of the purged account.' } } } },
] as const satisfies readonly ExtensionHookContract[];
export const hooksConfigSchema = extensionHooksSchema(authHookContracts);
export type AuthHookName = typeof authHookContracts[number]['name'];
export type LoadedAuthHooks = LoadedExtensionHooks<AuthHookName>;
export type RegistrationMethod = typeof registrationMethods[number];
export interface BeforeRegisterInput { email: string; method: RegistrationMethod; profile?: Record<string, unknown> }
export interface BeforeRoleChangeInput { accountId: string; currentRoles: string[]; requestedRoles: string[]; actorId: string; reason: string }
export interface AccountCreatedInput { accountId: string; email: string; method: RegistrationMethod | 'bootstrap'; actorId?: string }
export interface AccountStatusChangedInput { accountId: string; status: 'active' | 'locked'; actorId: string; reason: string }
export interface DeletionScheduledInput { accountId: string; email: string; deleteAfter: number; actorId?: string }
export interface AccountDeletedInput { accountId: string }
interface ActionInputs { onAccountCreated: AccountCreatedInput; onAccountStatusChanged: AccountStatusChangedInput; onDeletionScheduled: DeletionScheduledInput; onAccountDeleted: AccountDeletedInput }
export interface AuthHookStats { accepted: number; dropped: number; failed: number; timedOut: number }

/** Resolves and imports every configured hook, so a missing module or export fails activation, not a request. */
export async function loadAuthHooks(config: Readonly<Record<string, unknown>> | undefined, root: string): Promise<LoadedAuthHooks> {
    return await loadExtensionHooks<AuthHookName>(config, authHookContracts, { root });
}

const HOOK_DEADLINE_MS = 5000, ACTIONS_IN_FLIGHT = 4;
/** A denied filter's reason, bounded to 256 characters with control characters removed. */
function bounded(reason: unknown, fallback: string): string {
    const text = typeof reason === 'string' ? reason.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256).trim() : '';
    return text || fallback;
}
function deadline<T>(run: () => T | Promise<T>): Promise<{ value: T } | { timedOut: true }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = Promise.resolve().then(run).then(value => ({ value }));
    return Promise.race([pending, new Promise<{ timedOut: true }>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), HOOK_DEADLINE_MS); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

/** The attached project hooks of one auth service: the latest attachment wins, and a detach removes only its own. */
export interface HookRunner {
    attach(hooks: LoadedAuthHooks): () => void;
    has(name: AuthHookName): boolean;
    /** Throws AuthError 403 unless the hook, when attached, answers `{allow: true}` within 5 s. */
    beforeRegister(input: BeforeRegisterInput, context?: ExtensionHookContext): Promise<void>;
    beforeRoleChange(input: BeforeRoleChangeInput, context?: ExtensionHookContext): Promise<void>;
    /** Runs after a commit, at most 4 in flight and 5 s each; failures are counted, never thrown. */
    action<N extends keyof ActionInputs>(name: N, input: ActionInputs[N], context?: ExtensionHookContext): Promise<void>;
    stats(): AuthHookStats;
    close(): void;
}
export function createHookRunner(): HookRunner {
    let current: { hooks: LoadedAuthHooks } | undefined, active = 0, closed = false;
    const attached: { hooks: LoadedAuthHooks }[] = [];
    const stats: AuthHookStats = { accepted: 0, dropped: 0, failed: 0, timedOut: 0 };
    async function filter(name: 'beforeRegister' | 'beforeRoleChange', input: object, context: ExtensionHookContext | undefined, code: string, fallback: string): Promise<void> {
        const hook = current?.hooks[name];
        if (!hook)
            return;
        let answer: unknown;
        try {
            const result = await deadline(() => hook(input, context ?? extensionHookContext()));
            answer = 'value' in result ? result.value : undefined;
        }
        catch { answer = undefined; }
        const record = answer && typeof answer === 'object' ? answer as { allow?: unknown; reason?: unknown } : undefined;
        if (record?.allow !== true)
            throw new AuthError(403, code, undefined, bounded(record?.reason, fallback));
    }
    return {
        attach(hooks) {
            // The newest live attachment runs; detaching one restores the newest still attached, so a failed
            // reload's detach leaves the serving activation's hooks in place (RIM-EXT-HANDOFF-001).
            const attachment = { hooks };
            attached.push(attachment);
            current = attachment;
            return () => { const index = attached.indexOf(attachment); if (index >= 0) attached.splice(index, 1); current = closed ? undefined : attached.at(-1); };
        },
        has: name => typeof current?.hooks[name] === 'function',
        beforeRegister: (input, context) => filter('beforeRegister', input, context, 'registration_rejected', 'Registration not permitted'),
        beforeRoleChange: (input, context) => filter('beforeRoleChange', input, context, 'role_change_rejected', 'Role change rejected by project hook'),
        async action(name, input, context) {
            const hook = current?.hooks[name];
            if (!hook)
                return;
            if (closed || active >= ACTIONS_IN_FLIGHT) {
                stats.dropped++;
                return;
            }
            active++;
            stats.accepted++;
            // The slot stays taken until the hook itself settles, so a hook that ignores its deadline cannot pile up work.
            const pending = Promise.resolve().then(() => hook(input, context ?? extensionHookContext()));
            void pending.finally(() => { active--; }).catch(() => {});
            try {
                if ('timedOut' in await deadline(() => pending))
                    stats.timedOut++;
            }
            catch { stats.failed++; }
        },
        stats: () => ({ ...stats }),
        close() { closed = true; current = undefined; attached.length = 0; },
    };
}
