// Auth's one delivery path: every message auth sends (self-service pages and administration alike) goes through the
// mail extension with a template auth contributes (mail-templates.ts). Links are built here from auth's canonical
// origin and its own mount, so a raw token never leaves auth. Not exported from the package.
import type { MailExports } from '@jimhoyd/urlcode-mail';
import type { AuthMailTemplate } from './mail-templates.ts';

const opaque = /^[A-Za-z0-9_-]{43}$/, sixDigits = /^\d{6}$/;
/** The page each credential-bearing message links to; `account-setup` is a reset token with the setup wording. */
export const tokenPaths = { 'verify-email': '/verify', 'reset-password': '/reset', 'cancel-deletion': '/cancel-deletion', 'verify-email-change': '/verify-email-change', 'cancel-email-change': '/cancel-email-change', invitation: '/register', 'account-setup': '/reset', 'manual-recovery': '/restore-access' } as const;
export type TokenTemplate = keyof typeof tokenPaths;
export type NoticeTemplate = 'new-device' | 'password-changed' | 'email-changed' | 'registration-attempt';
export interface DeliveryOptions {
    /** Propagate a delivery failure (a MailError, 503) instead of swallowing it. Every administrator delivery is strict. */
    strict?: boolean;
    /** The caller's cancellation (administration's per-message deadline). */
    signal?: AbortSignal;
}
export interface Delivery {
    /** `mail.available`, read per call. */
    readonly available: boolean;
    /** An absolute URL of an auth page on the canonical origin. */
    page(path: string, query?: Readonly<Record<string, string>>): string;
    send(template: AuthMailTemplate, to: string, values: Readonly<Record<string, string>>, locale: string | undefined, options?: DeliveryOptions): Promise<void>;
    /** A credential-bearing link: the token's page with `?token=`. */
    token(template: TokenTemplate, to: string, token: string, locale: string | undefined, options?: DeliveryOptions): Promise<void>;
    /** A security notice that links to the account page; never strict. */
    notice(template: NoticeTemplate, to: string, locale: string | undefined): Promise<void>;
    signInCode(to: string, flowId: string, code: string, locale: string | undefined): Promise<void>;
    signupCode(to: string, code: string, locale: string | undefined): Promise<void>;
    factorRecovery(to: string, verificationToken: string, cancelToken: string, locale: string | undefined): Promise<void>;
}
/** `place` returns the activated canonical origin and auth's mount; it throws before activation. */
export function createDelivery(mail: MailExports, place: () => { origin: string; mount: string }): Delivery {
    const page = (path: string, query: Readonly<Record<string, string>> = {}) => {
        const { origin, mount } = place(), url = new URL(mount + path, origin);
        for (const [name, value] of Object.entries(query))
            url.searchParams.set(name, value);
        return url.href;
    };
    async function send(template: AuthMailTemplate, to: string, values: Readonly<Record<string, string>>, locale: string | undefined, options: DeliveryOptions = {}): Promise<void> {
        try {
            await mail.send({ template: 'auth.' + template, to, values, ...(locale ? { locale } : {}), ...(options.signal ? { signal: options.signal } : {}) });
        }
        catch (error) {
            if (options.strict)
                throw error;
        }
    }
    const shape = (valid: boolean, what: string) => { if (!valid) throw new Error(`Invalid ${what} delivery`); };
    return {
        get available() { return mail.available; },
        page,
        send,
        async token(template, to, token, locale, options) {
            shape(typeof token === 'string' && opaque.test(token), template);
            await send(template, to, { link: page(tokenPaths[template], { token }) }, locale, options);
        },
        notice: (template, to, locale) => send(template, to, { link: page('/account') }, locale),
        async signInCode(to, flowId, code, locale) {
            shape(opaque.test(flowId) && sixDigits.test(code), 'sign-in code');
            await send('sign-in-code', to, { link: page('/email-code', { flowId }), code }, locale);
        },
        async signupCode(to, code, locale) {
            shape(sixDigits.test(code), 'signup code');
            await send('signup-code', to, { link: page('/signup'), code }, locale);
        },
        async factorRecovery(to, verificationToken, cancelToken, locale) {
            shape(opaque.test(verificationToken) && opaque.test(cancelToken), 'factor recovery');
            await send('factor-recovery', to, { link: page('/recover-factor/confirm', { token: verificationToken }), cancelLink: page('/recover-factor/cancel', { token: cancelToken }) }, locale, { strict: true });
        },
    };
}
