import type { AuthOptions } from './auth-core.ts';
import type { AuthExtensionOptions } from './auth.ts';
import { createPasskeyProvider } from './passkeys.ts';
export interface AuthPresetOptions {
    preset?: 'standard' | 'hardened';
    origin: string;
    rpName: string;
    checkPassword?: AuthOptions['checkPassword'];
}
export interface AuthPreset {
    service: Pick<AuthOptions, 'sessionTtlMs' | 'sessionIdleMs' | 'requireEmailVerification' | 'requireMfa' | 'deletionGraceMs' | 'checkPassword'>;
    extension: Pick<AuthExtensionOptions, 'passkeys'>;
    notices: readonly string[];
}
/** Operator defaults, not project capabilities. Spread these defaults before explicit configuration.
 * Hardened requires a password-screening adapter and restricted enrollment; its mail delivery requirement is checked
 * when auth activates (required email verification cannot work without a mail transport). */
export function createAuthPreset(options: AuthPresetOptions): AuthPreset {
    const preset = options.preset ?? 'standard';
    if (preset !== 'standard' && preset !== 'hardened')
        throw new Error('Unknown auth preset');
    const hardened = preset === 'hardened';
    if (hardened && typeof options.checkPassword !== 'function')
        throw new Error('Hardened auth requires password breach screening');
    const passkeys = createPasskeyProvider({ origin: options.origin, rpId: new URL(options.origin).hostname, rpName: options.rpName });
    const service: AuthPreset['service'] = { sessionTtlMs: hardened ? 8 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000, sessionIdleMs: hardened ? 15 * 60 * 1000 : 30 * 60 * 1000, requireEmailVerification: hardened, requireMfa: hardened, deletionGraceMs: (hardened ? 30 : 7) * 86400000, ...(options.checkPassword ? { checkPassword: options.checkPassword } : {}) };
    return { service: Object.freeze(service), extension: Object.freeze({ passkeys }), notices: Object.freeze([]) };
}
