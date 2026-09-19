import type { AuthOptions } from './auth-core.ts';
import type { AuthExtensionOptions } from './auth.ts';
import type { EmailSender } from './senders.ts';
import { createPasskeyProvider } from './passkeys.ts';
export interface AuthPresetOptions {
    preset?: 'standard' | 'hardened';
    origin: string;
    rpName: string;
    sender?: EmailSender;
    checkPassword?: AuthOptions['checkPassword'];
}
export interface AuthPreset {
    service: Pick<AuthOptions, 'sessionTtlMs' | 'sessionIdleMs' | 'requireEmailVerification' | 'requireMfa' | 'deletionGraceMs' | 'checkPassword'>;
    extension: Pick<AuthExtensionOptions, 'passkeys' | 'sendToken' | 'sendEmailCode' | 'sendSignupCode' | 'sendFactorRecovery' | 'sendNotice'>;
    notices: readonly string[];
}
/** Operator defaults, not project capabilities. Spread these defaults before explicit configuration.
 * Hardened requires actual email and password-screening adapters and restricted enrollment. */
export function createAuthPreset(options: AuthPresetOptions): AuthPreset {
    const preset = options.preset ?? 'standard';
    if (preset !== 'standard' && preset !== 'hardened')
        throw new Error('Unknown auth preset');
    const hardened = preset === 'hardened';
    if (options.sender && (typeof options.sender !== 'function' || typeof options.sender.notify !== 'function' || typeof options.sender.sendEmailCode !== 'function' || typeof options.sender.sendSignupCode !== 'function' || typeof options.sender.sendFactorRecovery !== 'function'))
        throw new Error('Invalid email sender');
    if (hardened && (!options.sender || typeof options.checkPassword !== 'function'))
        throw new Error('Hardened auth requires email delivery and password breach screening');
    const passkeys = createPasskeyProvider({ origin: options.origin, rpId: new URL(options.origin).hostname, rpName: options.rpName });
    const service: AuthPreset['service'] = { sessionTtlMs: hardened ? 8 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000, sessionIdleMs: hardened ? 15 * 60 * 1000 : 30 * 60 * 1000, requireEmailVerification: hardened, requireMfa: hardened, deletionGraceMs: (hardened ? 30 : 7) * 86400000, ...(options.checkPassword ? { checkPassword: options.checkPassword } : {}) };
    const sender = options.sender;
    return { service: Object.freeze(service), extension: Object.freeze({ passkeys, ...(sender ? { sendToken: sender, sendFactorRecovery: sender.sendFactorRecovery.bind(sender), sendSignupCode: sender.sendSignupCode.bind(sender), sendEmailCode: sender.sendEmailCode.bind(sender), sendNotice: sender.notify.bind(sender) } : {}) }), notices: Object.freeze(sender ? [] : ['Email verification, recovery and notices are unavailable until an operator sender is configured.']) };
}
