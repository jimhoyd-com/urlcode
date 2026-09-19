// Project-level lifecycle hooks (docs/SPIKE-AUTH.md, urlcode-auth#35). A
// project names its own function per lifecycle point in `extensions.auth.config.hooks`,
// using the same `{source, export}` (or bare string) shape `function`/`middleware`
// routes already use. These hooks are first-party project code and run
// trusted, in-process, exactly like any other route's `function`/`middleware`
// (docs/SPIKE-DEFAULT-TRUST-MODEL.md, urlcode's docs/EXTENSIONS.md "Project-level
// lifecycle hooks"): no special case, no hardwired sandbox.
//
// `sandbox: true` is explicitly rejected at activation, never silently
// ignored: core's trusted/sandboxed dispatch (TrustedFunctions/FunctionPool)
// is wired to route dispatch, not exposed to extensions, so this package has
// no way to actually isolate a hook call yet (tracked in
// jimhoyd-com/urlcode#151). Accepting `sandbox: true` and running it trusted
// anyway would misrepresent the isolation the project believes it configured.
import { isAbsolute, relative, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export interface HookReference {
    source: string;
    export?: string;
    sandbox?: boolean;
}
export type HookConfig = string | HookReference;
export interface LifecycleHooksConfig {
    beforeRegister?: HookConfig;
    onSignUp?: HookConfig;
    onDelete?: HookConfig;
}
export interface BeforeRegisterInput {
    email: string;
    profile?: Record<string, unknown>;
}
export interface BeforeRegisterVerdict {
    allow: boolean;
    reason?: string;
}
export interface OnSignUpInput {
    accountId: string;
    email: string;
}
export interface OnDeleteInput {
    accountId: string;
    email: string;
}
export interface LifecycleHooks {
    beforeRegister?(input: BeforeRegisterInput): BeforeRegisterVerdict | Promise<BeforeRegisterVerdict>;
    onSignUp?(input: OnSignUpInput): void | Promise<void>;
    onDelete?(input: OnDeleteInput): void | Promise<void>;
}
const hookNames = ['beforeRegister', 'onSignUp', 'onDelete'] as const;
export const hooksConfigSchema = {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(hookNames.map(name => [name, {
        oneOf: [
            { type: 'string', minLength: 1, maxLength: 1024 },
            {
                type: 'object',
                additionalProperties: false,
                required: ['source'],
                properties: {
                    source: { type: 'string', minLength: 1, maxLength: 1024 },
                    export: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
                    sandbox: { type: 'boolean' },
                },
            },
        ],
    }])),
};
function normalize(ref: HookConfig): { source: string; export: string; sandbox: boolean } {
    return typeof ref === 'string'
        ? { source: ref, export: 'default', sandbox: false }
        : { source: ref.source, export: ref.export ?? 'default', sandbox: ref.sandbox === true };
}
// Same project-relative-file discipline core's own `safeFile` applies to a
// route's `function.source`: resolved against the project root, refused if
// it escapes it. Not a security boundary against the module's own code
// (trusted hooks get full Node access like any other project code), just the
// same "the YAML cannot point outside the project" hygiene.
async function projectFile(root: string, file: string, hookName: string): Promise<string> {
    if (isAbsolute(file))
        throw new Error(`hook ${hookName}: source must be a project-relative path`);
    const base = await realpath(root);
    let actual: string;
    try {
        actual = await realpath(resolve(base, file));
    }
    catch {
        throw new Error(`hook ${hookName}: source module "${file}" was not found`);
    }
    const rel = relative(base, actual);
    if (!rel || rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel))
        throw new Error(`hook ${hookName}: source escapes the project`);
    if (!(await stat(actual)).isFile())
        throw new Error(`hook ${hookName}: source must be a file`);
    return actual;
}
/**
 * Resolves and eagerly imports every declared hook, so a missing module, a
 * syntax error or a missing export fails activation (fail-fast), never the
 * first request that happens to reach the hook. `sandbox: true` is rejected
 * here, immediately and explicitly, rather than accepted and silently run
 * trusted.
 */
export async function loadLifecycleHooks(config: LifecycleHooksConfig | undefined, root: string): Promise<LifecycleHooks> {
    const hooks: Record<string, (...args: never[]) => unknown> = {};
    if (!config)
        return hooks;
    for (const name of hookNames) {
        const ref = config[name];
        if (ref === undefined)
            continue;
        const definition = normalize(ref);
        if (definition.sandbox)
            throw new Error(`hook ${name}: sandbox: true is not yet supported for project-level hooks, see jimhoyd-com/urlcode-auth#35`);
        const file = await projectFile(root, definition.source, name);
        let mod: Record<string, unknown>;
        try {
            mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
        }
        catch {
            throw new Error(`hook ${name}: failed to load module "${definition.source}"`);
        }
        const fn = mod[definition.export];
        if (typeof fn !== 'function')
            throw new Error(`hook ${name}: export "${definition.export}" in "${definition.source}" is not a function`);
        hooks[name] = fn as (...args: never[]) => unknown;
    }
    return hooks as LifecycleHooks;
}
