// The guard in front of auth's entry requests (sign-in, registration, recovery and code requests, provider starts):
// auth's own bounded parse, CSRF and signup honeypot, then, when extensions.auth.config.abuse declares budgets, the
// abuse extension's persistent pseudonymous admission and challenge escalation. Callbacks and code/token redemption
// are not entry requests: they carry their own bound proofs.
import { clientKey, readBody } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AbuseAdmitEntry, AbuseBackoff, AbuseBudget, AbuseChallenge, AbuseChallengeWidget, AbuseNamespace } from '@jimhoyd/urlcode-abuse';
import { normalizeEmail } from './auth-core.ts';
import { AuthError } from './auth-store.ts';
import { jsonResponse, wantsJson } from '@jimhoyd/urlcode/extensions';
import { AuthHttp, AuthHttpError, screenResponse } from './auth-ui.ts';
import type { AuthHttpResponse, UiHost } from './auth-ui.ts';
import type { PresentationContext } from './presentation.ts';
import { isHoneypotFilled } from './registration.ts';

/** What auth built from extensions.auth.config.abuse at activation. */
export interface AuthAbuse {
    namespace: AbuseNamespace;
    client?: AbuseBudget | undefined;
    signupClient?: AbuseBudget | undefined;
    signupDomain?: AbuseBudget | undefined;
    /** Present when `challengeAfter` is configured (activation refused it without a verifier). */
    challenge?: AbuseChallenge | undefined;
    /** The challenge widget auth's entry pages render, when `challenge` is present. */
    widget?: AbuseChallengeWidget | undefined;
    passwordBackoff?: AbuseBackoff | undefined;
}
const entries = ['/login', '/register', '/signup/begin', '/forgot-password', '/send-email-code', '/recover-factor', '/passkeys/login/options'];
const unavailable = () => new AuthError(503, 'abuse_unavailable');

export function createEntryGuard(http: AuthHttp, mount: string, ui: UiHost, abuse: AuthAbuse | undefined) {
    return async (request: ExtensionRequest, presentation?: PresentationContext): Promise<AuthHttpResponse | undefined> => {
        const path = request.path.slice(mount.length), signup = path === '/register' || path === '/signup/begin';
        if (request.method !== 'POST' || !(entries.includes(path) || /^\/providers\/[a-z][a-z0-9-]{0,31}\/start$/.test(path)))
            return undefined;
        let fields: Record<string, unknown>;
        try {
            const body = readBody(request, { accept: ['json', 'form'], maxBytes: 16384 });
            if (body.kind === 'form') {
                if (new Set(body.entries.map(([name]) => name)).size !== body.entries.length)
                    throw new Error('Repeated field');
                fields = Object.fromEntries(body.entries);
            }
            else {
                if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value))
                    throw new Error('Expected an object');
                fields = body.value as Record<string, unknown>;
            }
        }
        catch (error) {
            if (error instanceof Error && 'status' in error && error.status === 413)
                throw new AuthHttpError(413, 'Request body too large');
            throw new AuthHttpError(400, 'Invalid authentication request');
        }
        if (Object.keys(fields).length > 64 || fields.csrf !== undefined && typeof fields.csrf !== 'string' || fields.challengeToken !== undefined && (typeof fields.challengeToken !== 'string' || fields.challengeToken.length > 2048))
            throw new AuthHttpError(400, 'Invalid authentication request');
        http.verify(request, { csrf: typeof fields.csrf === 'string' ? fields.csrf : '' });
        // Auth's own honeypot, always on: a filled `website` field gets the ordinary registration answer and no account.
        if (signup && isHoneypotFilled(fields.website))
            return jsonResponse(202, { message: 'Registration request received.' });
        if (!abuse)
            return undefined;
        const admit: AbuseAdmitEntry[] = [], client = clientKey(request.client);
        if ((abuse.client || signup && abuse.signupClient) && client === undefined)
            throw new AuthError(503, 'trusted_client_required');
        if (abuse.client)
            admit.push({ budget: abuse.client, value: client! });
        if (signup && (abuse.signupClient || abuse.signupDomain)) {
            if (abuse.signupClient)
                admit.push({ budget: abuse.signupClient, value: client! });
            if (abuse.signupDomain) {
                const email = normalizeEmail(typeof fields.email === 'string' ? fields.email : '');
                admit.push({ budget: abuse.signupDomain, value: email.slice(email.lastIndexOf('@') + 1) });
            }
        }
        if (!admit.length)
            return undefined;
        const admission = await abuse.namespace.admit(admit).catch(() => { throw unavailable(); });
        if (!admission.allowed) {
            if (admission.status === 429)
                throw new AuthHttpError(429, 'Too many attempts. Try again later.', [['retry-after', String(admission.retryAfterSeconds)]]);
            throw unavailable();
        }
        if (!admission.challengeRequired)
            return undefined;
        if (abuse.challenge && await abuse.challenge.verify({ token: fields.challengeToken, client: request.client, action: 'auth' }))
            return undefined;
        const source = 'Challenge required. Return to the form and try again.', message = presentation?.textSource(source) ?? source;
        if (wantsJson(request))
            return jsonResponse(403, { error: message, challengeRequired: true });
        const retry = signup ? '/signup' : path === '/forgot-password' || path === '/recover-factor' ? path : path === '/send-email-code' ? '/email-code' : '/login';
        return screenResponse('Verification required', { name: 'auth/status', view: { alert: true, message, href: mount + retry, label: presentation?.textSource('Try again') ?? 'Try again' } }, { status: 403, presentation, ui });
    };
}
/** The password backoff around a sign-in or step-up: a blocked address is refused before any password is checked. */
export function passwordBackoff(backoff: AbuseBackoff | undefined) {
    const key = (email: string) => { try { return normalizeEmail(email); } catch { return undefined; } };
    const guarded = async <T>(run: () => Promise<T>): Promise<T> => { try { return await run(); } catch { throw unavailable(); } };
    return {
        async check(email: string): Promise<void> {
            const value = backoff && key(email);
            if (!value)
                return;
            const state = await guarded(() => backoff!.check(value));
            if (state.blocked)
                throw new AuthHttpError(429, 'Too many attempts. Try again later.', [['retry-after', String(state.retryAfterSeconds)]]);
        },
        async failure(email: string): Promise<void> { const value = backoff && key(email); if (value) await guarded(() => backoff!.failure(value)); },
        async clear(email: string): Promise<void> { const value = backoff && key(email); if (value) await guarded(() => backoff!.clear(value)); },
    };
}
