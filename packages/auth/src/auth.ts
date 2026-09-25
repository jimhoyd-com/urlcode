import { randomBytes, randomInt } from 'node:crypto';
import { icon, hiddenField, postForm, Markup } from '@jimhoyd/urlcode-ui';
import type { IconName } from '@jimhoyd/urlcode-ui';
import {createAbuseGuard} from './abuse-http.ts';
import type {AuthChallenge} from './challenge.ts';
import {createManualRecoveryFlows} from './manual-recovery.ts';
import {createFactorRecoveryFlows} from './factor-recovery.ts';
import type {FactorRecoveryMessage} from './factor-recovery.ts';
import type { PresentationContext } from './presentation.ts';
import type { RegistrationInput, MetadataValue } from './registration.ts';
import { isHoneypotFilled } from './registration.ts';
import type { Presentation } from './presentation.ts';
import { createSecondFactorFlows } from './second-factor-flows.ts';
import { createSignup } from './auth-signup.ts';
import { createAuthFlows } from './auth-flows.ts';
import type { OidcProvider } from './oidc.ts';
import type { PasskeyProvider } from './passkeys.ts';
import { extensionContextHeaderPrefix, extensionHookContext } from '@jimhoyd/urlcode/extensions';
import type { RuntimeExtension, ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AuthService, AuthPrincipal, AuthUser } from './auth-core.ts';
import { AuthHttp, AuthHttpError, csrfField, escapeHtml, formField as baseField, httpFailure, jsonResponse, readFields, screenResponse, wantsJson, passkeyScript, secondFactorButton } from './auth-ui.ts';
import type { AuthHttpResponse, Screen, UiHost } from './auth-ui.ts';
import { authHookContracts, hooksConfigSchema, loadLifecycleHooks } from './lifecycle-hooks.ts';
import type { LifecycleHooks, LifecycleHooksConfig } from './lifecycle-hooks.ts';
export interface AuthExtensionOptions {
    challenge?:AuthChallenge;
    sendFactorRecovery?:(message:FactorRecoveryMessage)=>Promise<void>;
    presentation?: Presentation;
    /** The `ui` extension from `createUiExtension`, declared before auth in the host file. Every account screen renders through its kit; activation refuses without it. */
    ui: UiHost;
    service: AuthService;
    csrfKey: Uint8Array;
    projectSha256: string;
    providers?: Record<string, OidcProvider>;
    passkeys?: PasskeyProvider;
    sendSignupCode?: (message: { email: string; code: string; locale?: string; signal: AbortSignal }) => Promise<void>;
    sendEmailCode?: (message: {
        email: string;
        flowId: string;
        code: string;
        locale?: string;
        signal: AbortSignal;
    }) => Promise<void>;
    sendNotice?: (message: {
        email: string;
        event: 'password-changed' | 'new-device' | 'registration-attempt' | 'email-changed';
        locale?: string;
        signal: AbortSignal;
    }) => Promise<void>;
    sendToken?: (message: {
        email: string;
        token: string;
        purpose: 'verify-email' | 'reset-password' | 'cancel-deletion' | 'verify-email-change' | 'cancel-email-change';
        locale?: string;
        signal: AbortSignal;
    }) => Promise<void>;
}
function enrollmentRequired(principal: AuthPrincipal): boolean { return Boolean(principal.restrictions?.length); }
export function hasPermission(principal: AuthPrincipal, permission: string): boolean { return !enrollmentRequired(principal) && (principal.permissions.includes('*') || principal.permissions.includes(permission)); }
/** Splits a structured-field list value into its members, respecting quoted strings. */
function listMembers(value: string): string[] {
    const out: string[] = [];
    let start = 0, quoted = false;
    for (let i = 0; i < value.length; i++) {
        const c = value[i];
        if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; }
        else if (c === '"') quoted = true;
        else if (c === ',') { out.push(value.slice(start, i)); start = i + 1; }
    }
    out.push(value.slice(start));
    return out.map(member => member.trim()).filter(Boolean);
}
/**
 * Puts one `credential` member first in each RateLimit list field of `result`, keeping every
 * other producer's member (core throttle's `default`, which its response phase has already
 * added by the time an extension middleware sees the result) and folding repeated field lines
 * into one list. A stale `credential` member is replaced, never duplicated.
 */
function withRateLimitMembers<T extends { headers: [string, string][] }>(result: T, added: [string, string][]): T {
    const names = new Set(added.map(([name]) => name));
    const kept = new Map<string, string[]>();
    for (const [name, value] of result.headers) {
        const lower = name.toLowerCase();
        if (names.has(lower))
            kept.set(lower, [...kept.get(lower) ?? [], ...listMembers(value).filter(member => !/^"credential"(?:;|$)/.test(member))]);
    }
    return { ...result, headers: [...result.headers.filter(([name]) => !names.has(name.toLowerCase())), ...added.map(([name, value]): [string, string] => [name, [value, ...kept.get(name) ?? []].join(', ')])] };
}
/** The `extensions.auth.config` schema: one object, shared by the runtime registration and the extension definition. */
export const authConfigSchema = { type: 'object', additionalProperties: false, properties: { registration: { enum: ['open', 'invite-only', 'waitlist', 'off'] }, hooks: hooksConfigSchema } };
// `bearer` is a distinct, exclusive requirement shape: a route is either session-protected
// (role/permission/verified/freshWithinSeconds/onDeny, checked against the signed-in
// cookie session) or bearer-protected (checked against an operator-issued API key), never
// both — see `authorize()` below and docs/EXTENSIONS.md.
// `quota` (urlcode#572) budgets each credential separately: `requests` per `window`
// seconds, the same units as core's `policies.throttle` (quota/window), counted by
// key id in the auth SQLite store. Bounds match auth-core.ts `validApiKeyQuota`.
// A key issued with its own `quota` (urlcode#703) is counted against that budget
// instead, on every bearer route it authenticates on; the route's applies to keys
// without one.
const apiKeyQuotaSchema = { type: 'object', additionalProperties: false, required: ['requests', 'window'], properties: { requests: { type: 'integer', minimum: 1, maximum: 1000000 }, window: { type: 'integer', minimum: 1, maximum: 2592000 } } };
const bearerSchema = { type: 'object', additionalProperties: false, required: ['scopes'], properties: { scopes: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-z][a-z0-9_.:-]*$' } }, quota: apiKeyQuotaSchema } };
/**
 * Reserved-namespace header (core's `extensionContextHeaderPrefix`,
 * @jimhoyd/urlcode/extensions) a bearer-protected route's own trusted
 * `function`/`middleware` can read directly off its `Request` to learn which
 * API key authenticated it (urlcode#618). Base64-encoded JSON rather than a
 * raw header value: the operator-supplied `name` on an issued key is not
 * restricted to header-safe (Latin-1, no control character) text, and this
 * avoids that value ever needing to satisfy the header-value character set
 * itself. The runtime always strips any client-supplied value in this
 * namespace before this hook runs, so a request cannot spoof it — see
 * `stripReservedContextHeaders` in @jimhoyd/urlcode/extensions.
 */
const authPrincipalHeader = `${extensionContextHeaderPrefix}auth-principal`;
/** The `policies.extensions.auth` schema. */
export const authPolicySchema = { type: 'object', additionalProperties: false, properties: { role: { type: 'string', minLength: 1, maxLength: 64 }, permission: { type: 'string', minLength: 1, maxLength: 128 }, verified: { type: 'boolean' }, freshWithinSeconds: { type: 'integer', minimum: 1, maximum: 3600 }, onDeny: { enum: [401, 403, 404, 'sign-in'] }, bearer: bearerSchema }, minProperties: 0 };
const actionIcons: Readonly<Record<string, IconName>> = {identify:'arrow-right',login:'arrow-right','step-up':'shield',logout:'log-out',export:'download'};
export const authAuthoring = Object.freeze({
    description: 'Auth is part of the application, while this package keeps ownership of identity, session, CSRF and recovery behavior. Customize its project configuration and UI surfaces before replacing package behavior.',
    surfaces: Object.freeze([
        { kind: 'configuration' as const, name: 'registration', description: 'Select the supported registration mode in extensions.auth.config.registration.', path: 'urlcode.yaml#extensions.auth.config.registration' },
        { kind: 'copy' as const, name: 'account copy', description: 'Change account-screen wording through the UI catalogue.', path: 'ui/copy/<locale>.json' },
        { kind: 'template' as const, name: 'account screens', description: 'Override one auth/* screen when its structure must change; keep form actions and security behavior package-owned.', path: 'ui/templates/auth/<screen>.html', command: 'urlcode-ui list --project . --extensions @jimhoyd/urlcode-auth' },
        { kind: 'hook' as const, name: 'registration lifecycle', description: 'Use the declared beforeRegister, onSignUp and onDelete hooks for application behavior at supported lifecycle points.', path: 'extensions.auth.config.hooks' },
    ]),
    fastChecks: Object.freeze(['urlcode-ui doctor --project . --extensions @jimhoyd/urlcode-auth --copy ui/copy --templates ui/templates --stylesheet ui/extra.css', 'urlcode validate --local', 'urlcode test']),
});
const hidden = hiddenField;
const m = (html: string) => new Markup(html);
export function authExtension(options: AuthExtensionOptions): RuntimeExtension {
    return { name: 'auth', version: '1', projectSha256: options.projectSha256, targets: ['node'], schema: authConfigSchema, policySchema: authPolicySchema, hooks: authHookContracts, authoring: authAuthoring, credentialHeaders: ['cookie', 'authorization', 'x-csrf-token'],
        async activate(config, context) {
            if (context.mounts.length !== 1)
                throw new Error('Auth requires exactly one mount');
            // Account screens render only through the kit, so a missing or unactivated `ui`
            // is refused here rather than per request in production.
            if (!options.ui)
                throw new Error('Auth requires the ui extension: pass the object createUiExtension() returns as authExtension({ui, ...}). Every account screen renders through its kit; there is no shared-primitive fallback.');
            if (!options.ui.active)
                throw new Error('Auth requires an activated ui extension: declare `ui` in urlcode.yaml before `auth`, with its asset route (for example /assets/ui/*), and list ui.registration before authExtension in the host. The runtime activates extensions in the order urlcode.yaml declares them.');
            // Fail-fast: a configured hook whose module fails to load or whose
            // named export is missing fails activation here, never the first
            // request that happens to reach it. `sandbox: true` is rejected
            // inside loadLifecycleHooks, explicitly, not silently ignored.
            const hooks: LifecycleHooks = await loadLifecycleHooks(config.hooks as LifecycleHooksConfig | undefined, context.root);
            const mount = context.mounts[0]!, http = new AuthHttp({ origin: context.origin, csrfKey: options.csrfKey }), service = options.service, registrationMode = String(config.registration || 'off'), registration = registrationMode === 'open';
            // The runtime activated `ui` before auth, but its kit is read per request, never captured at activation.
            const source = () => options.presentation ?? options.ui.kit.presentation;
            const lazyPresentation: Presentation = { get locales() { return source().locales; }, get defaultLocale() { return source().defaultLocale; }, get english() { return source().english; }, resolve: preferences => source().resolve(preferences), coverage: locale => source().coverage(locale) };
            if (registrationMode !== service.getRegistrationMode())
                throw new Error('Project registration mode must match operator auth service mode');
            const registrationSchema = service.getRegistrationSchema();
            const metadataFields = Object.entries(registrationSchema.metadata ?? {});
            function profileInput(fields: Record<string, string>): RegistrationInput {
                const metadata: Record<string, MetadataValue> = {};
                for (const [name, field] of metadataFields) {
                    const value = fields['meta.' + name];
                    if (value === undefined || value === '')
                        continue;
                    if (field.type === 'number') {
                        if (!Number.isFinite(Number(value)))
                            throw new AuthHttpError(400, 'Invalid numeric metadata');
                        metadata[name] = Number(value);
                    }
                    else if (field.type === 'boolean') {
                        if (value !== 'true' && value !== 'false')
                            throw new AuthHttpError(400, 'Invalid boolean metadata');
                        metadata[name] = value === 'true';
                    }
                    else
                        metadata[name] = value;
                }
                return { ...(fields.displayName !== undefined ? { displayName: fields.displayName } : {}), ...(fields.locale ? { locale: fields.locale } : {}), ...(Object.keys(metadata).length ? { metadata } : {}), ...(fields.termsAccepted !== undefined ? { termsAccepted: fields.termsAccepted === 'true' } : {}) };
            }
            const profileMarkup = (formField: typeof baseField = baseField, presentation?: PresentationContext) => formField('displayName', 'Display name', 'text', 'nickname', false) + formField('locale', 'Preferred language', 'text', 'language', false) + metadataFields.map(([name, field]) => baseField('meta.' + name, name + (field.type === 'boolean' ? ' (' + (presentation?.text('field.booleanHint') ?? 'true or false') + ')' : ''), field.type === 'number' ? 'number' : 'text', 'off', field.required === true)).join('') + (registrationSchema.termsVersion ? `<label><input type="checkbox" name="termsAccepted" value="true" required> ${escapeHtml((presentation ?? source().resolve()).text('message.acceptTerms', { version: registrationSchema.termsVersion }))}</label>` : '');
            const abuseGuard=createAbuseGuard(service,http,mount,options.challenge,options.ui);
            const secondFactors = createSecondFactorFlows(options, http, mount);
            const trustedCookie = '__Host-urlcode-trusted-device';
            const trusted = (request: ExtensionRequest) => { const token = service.getSecurityPolicy().trustedDeviceTtlMs ? http.cookie(request, trustedCookie) : undefined; return token ? {trustedDevice:token} : {}; };
            const noticeLocale = (request: ExtensionRequest, user: AuthUser) => source().resolve({ ...(user.profile?.locale ? {accountLocale:user.profile.locale} : {}), ...(request.query.get('lang') ? {queryLocale:request.query.get('lang')!} : {}), ...(request.headers.get('accept-language') ? {acceptLanguage:request.headers.get('accept-language')!} : {}) }).locale;
            const flows = createAuthFlows({ ...options, presentation: lazyPresentation, onSession: async (request, result) => {
                    if (result.newDevice)
                        await notice(result.user.email, 'new-device', noticeLocale(request,result.user));
                    return http.device(request).headers;
                }, enrollment: { required: !!registrationSchema.termsVersion || metadataFields.some(([, field]) => field.required), fields: (presentation) => profileMarkup((name, label, ...rest) => baseField(name, presentation?.textSource(label) ?? label, ...rest), presentation), read: profileInput, names: ['displayName', 'locale', 'termsAccepted', ...metadataFields.map(([name]) => 'meta.' + name)] } }, http, mount, registration);
            const factorRecovery=createFactorRecoveryFlows(options,http,mount);
            const manualRecovery=createManualRecoveryFlows(service,http,mount,options.ui);
            const signup = createSignup({ ...options, presentation: lazyPresentation }, http, mount, { fields: p => profileMarkup((name,label,...rest)=>baseField(name,p.textSource(label),...rest),p), read: profileInput, names: ['displayName','locale','termsAccepted',...metadataFields.map(([name])=>'meta.'+name)] }, hooks);
            // `beforeRegister` is project governance over the project's own signup flow
            // (README.md "Project-level lifecycle hooks"): a missing verdict or `allow: false` rejects the
            // attempt with the hook's own reason, surfaced the same way any other
            // registration rejection is (AuthHttpError -> httpFailure).
            async function checkBeforeRegister(request: ExtensionRequest, email: string, profile?: Record<string, unknown>): Promise<void> {
                if (!hooks.beforeRegister)
                    return;
                const verdict = await hooks.beforeRegister({ email, ...(profile ? { profile } : {}) }, extensionHookContext(request));
                if (!verdict || verdict.allow !== true)
                    throw new AuthHttpError(403, verdict?.reason || 'Registration not permitted');
            }
            const passkeyButton = (kind: 'register' | 'login' | 'step-up', text: (value: string) => string = value => value) => options.passkeys ? `<button type="button" data-passkey="${kind}" data-base="${escapeHtml(mount)}" data-unavailable="${escapeHtml(text('Passkeys are unavailable in this browser. Use another sign-in method.'))}" data-failed="${escapeHtml(text('Passkey request failed'))}" data-cancelled="${escapeHtml(text('Passkey ceremony cancelled'))}">${escapeHtml(text(kind === 'register' ? 'Add a passkey' : kind === 'step-up' ? 'Confirm identity with a passkey' : 'Sign in with a passkey'))}</button><p role="status" aria-live="polite" data-passkey-status></p>` : '';
            async function principal(request: ExtensionRequest): Promise<{
                token: string;
                principal: AuthPrincipal;
            }> {
                const token = http.session(request);
                const found = token ? await service.authenticate(token) : null;
                if (!token || !found)
                    throw new AuthHttpError(401, 'Sign in required');
                return { token, principal: found };
            }
            function redirect(path: string, headers: [
                string,
                string
            ][] = []): AuthHttpResponse { return jsonResponse(303, { redirect: path }, [['location', path], ...headers]); }
            const navigationIcons: Readonly<Record<string, IconName>> = {account:'user',sessions:'monitor','step-up':'shield',methods:'key','second-factors':'shield','trusted-devices':'monitor'};
            const createNavigation = (text: (value: string) => string, currentPath: string) => `<nav class="ui-tabs" aria-label="${escapeHtml(text('Account'))}">${[['account', 'Account'], ['sessions', 'Sessions'], ['step-up', 'Confirm identity'], ['methods', 'Sign-in methods'], ...(service.getSecurityPolicy().allowPasskeySecondFactor ? [['second-factors','Second factors']] : []), ...(service.getSecurityPolicy().trustedDeviceTtlMs ? [['trusted-devices','Remembered devices']] : [])].map(([path, label]) => `<a href="${escapeHtml(mount + '/' + path)}"${currentPath === '/' + path ? ' aria-current="page"' : ''}>${icon(navigationIcons[path!]!)}${escapeHtml(text(label!))}</a>`).join('')}</nav>`;
            async function deliver(email: string, token: string, purpose: 'verify-email' | 'reset-password' | 'cancel-deletion' | 'verify-email-change' | 'cancel-email-change', strict = false, locale?: string): Promise<void> {
                if (!options.sendToken)
                    throw new AuthHttpError(503, 'Email delivery is not configured');
                const controller = new AbortController();
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([options.sendToken({ email, token, purpose, ...(locale ? {locale} : {}), signal: controller.signal }), new Promise<void>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Delivery timeout')); }, 5000); })]);
                }
                catch (error) {
                    if (strict)
                        throw error;
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
            }
            async function notify(email: string, purpose: 'verify-email' | 'reset-password', locale?: string): Promise<void> {
                if (!options.sendToken)
                    throw new AuthHttpError(503, 'Email delivery is not configured');
                const issued = await service.issueToken({ email, purpose });
                // Always attempt delivery, even when no account matched (`issued.token` is then
                // null): a well-formed but inert decoy token keeps response timing/behavior from
                // revealing whether the address has an account, per JSON-API.md's no-enumeration
                // guarantee. A decoy is never stored server-side, so it never verifies anything.
                await deliver(email, issued.token ?? randomBytes(32).toString('base64url'), purpose, false, locale);
            }
            async function notice(email: string, event: 'password-changed' | 'new-device' | 'registration-attempt' | 'email-changed' = 'password-changed', locale?: string): Promise<void> {
                if (!options.sendNotice)
                    return;
                const controller = new AbortController();
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([options.sendNotice({ email, event, ...(locale ? {locale} : {}), signal: controller.signal }), new Promise<void>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 5000); })]);
                }
                catch { /* Notification delivery is best-effort: a failed or timed-out notice must not fail the operation that triggered it. */ }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
            }
            // The budget an allowed bearer request was counted against, keyed by the request
            // object core hands both authorize() and middleware(), so middleware() can report
            // it on the response (urlcode#703). A WeakMap: nothing outlives the request.
            const counted = new WeakMap<ExtensionRequest, { quota: { requests: number; window: number }; remaining: number; reset: number }>();
            return {
                async authorize(requirement, request) {
                    // Bearer/API-key requirement: exclusive of the session-cookie checks below
                    // (a route is protected one way or the other, never both). RFC 6750-shaped
                    // responses: 401 with no `error` param for a missing/malformed credential,
                    // 401 `error="invalid_token"` for one that does not verify (unknown, wrong
                    // secret, expired or revoked), 403 `error="insufficient_scope"` for a valid
                    // credential missing a required scope. On success, the verified principal
                    // (id/name/scopes — never the raw key) is written into the reserved
                    // `authPrincipalHeader` namespace on `request.headers` so the route's own
                    // trusted function/middleware can read who authenticated (urlcode#618);
                    // the raw bearer token itself is never forwarded.
                    if (requirement.bearer) {
                        const required = (requirement.bearer as { scopes: string[] }).scopes;
                        const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '');
                        if (!match)
                            return jsonResponse(401, { error: 'authentication_required' }, [['www-authenticate', 'Bearer']]);
                        const principal = await service.authenticateApiKey(match[1]!);
                        if (!principal)
                            return jsonResponse(401, { error: 'invalid_token' }, [['www-authenticate', 'Bearer error="invalid_token"']]);
                        const missing = required.filter(scope => !principal.scopes.includes(scope));
                        if (missing.length)
                            return jsonResponse(403, { error: 'insufficient_scope', requiredScopes: missing }, [['www-authenticate', `Bearer error="insufficient_scope", scope="${missing.join(' ')}"`]]);
                        // Per-credential quota (urlcode#572): counted only once the key has
                        // authenticated and covers the route's scopes, so 401/403 keep their
                        // meaning and an unauthenticated flood stays core throttle's job (by
                        // client). A refusal mirrors core throttle's 429: Retry-After plus the
                        // IETF RateLimit-Policy/RateLimit fields, under the policy name
                        // "credential". A store failure throws (fails closed), as the key
                        // lookup above does. A key's own quota replaces the route's
                        // (urlcode#703): such a key is counted only against its own budget.
                        const quota = principal.quota ?? (requirement.bearer as { quota?: { requests: number; window: number } }).quota;
                        if (quota) {
                            const budget = await service.consumeApiKeyQuota(principal.id, quota);
                            if (!budget.allowed)
                                return jsonResponse(429, { error: 'credential_quota_exceeded' }, [['retry-after', String(budget.reset)], ['ratelimit-policy', `"credential";q=${quota.requests};w=${quota.window}`], ['ratelimit', `"credential";r=0;t=${budget.reset}`]]);
                            counted.set(request, { quota, remaining: budget.remaining, reset: budget.reset });
                        }
                        request.headers.set(authPrincipalHeader, Buffer.from(JSON.stringify({ id: principal.id, name: principal.name, scopes: principal.scopes })).toString('base64'));
                        return undefined;
                    }
                    let presentation = source().resolve({ ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) });
                    try {
                        const token = http.session(request), user = token ? await service.authenticate(token) : null;
                        const locale = user ? (await service.getUser(user.id))?.profile?.locale : undefined;
                        if (locale)
                            presentation = source().resolve({ accountLocale: locale });
                        const allowed = user && !enrollmentRequired(user) && (!requirement.role || user.roles.includes(String(requirement.role))) && (!requirement.permission || hasPermission(user, String(requirement.permission))) && (!requirement.verified || user.emailVerified) && (!requirement.freshWithinSeconds || Date.now() - user.authenticatedAt <= Number(requirement.freshWithinSeconds) * 1000);
                        if (allowed) {
                            if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method))
                                http.verify(request, {});
                            return undefined;
                        }
                        if (requirement.onDeny === 'sign-in' && ['GET', 'HEAD'].includes(request.method))
                            return redirect(mount + (user && enrollmentRequired(user) ? '/account' : '/login'));
                        return jsonResponse(typeof requirement.onDeny === 'number' ? requirement.onDeny : user ? 403 : 401, { error: presentation.text('message.accessDenied') });
                    }
                    catch (error) {
                        return httpFailure(error, request, presentation, undefined, options.ui);
                    }
                },
                // Wraps an authorized bearer request whose credential was counted above, so the
                // allowed response carries the same `credential` RateLimit-Policy/RateLimit
                // members the 429 does (urlcode#703). Every other route passes straight through.
                // The values are per credential; core already forces `Cache-Control: no-store`
                // on every response of a route naming auth (auth declares no `cacheSensitive`),
                // so they are never stored in or served from a cache.
                async middleware(_config, request, next) {
                    const result = await next(), budget = counted.get(request);
                    if (!budget)
                        return result;
                    counted.delete(request);
                    return withRateLimitMembers(result, [['ratelimit-policy', `"credential";q=${budget.quota.requests};w=${budget.quota.window}`], ['ratelimit', `"credential";r=${budget.remaining};t=${budget.reset}`]]);
                },
                async handle(request) {
                    let accountLocale: string | undefined;
                    try {
                        const session = http.session(request), actor = session ? await service.authenticate(session) : null;
                        accountLocale = actor ? (await service.getUser(actor.id))?.profile?.locale : undefined;
                    }
                    catch { /* An unreadable session only means no account locale to prefer; fall back to the request locale. */ }
                    const presentation = source().resolve({ ...(accountLocale ? { accountLocale } : {}), ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) });
                    const tr = (key: string, values?: Readonly<Record<string, string | number>>) => escapeHtml(presentation.text(key, values));
                    const text = (value: string) => presentation?.textSource(value) ?? value;
                    const navigation = createNavigation(source => presentation?.textSource(source) ?? source, request.path.slice(mount.length));
                    const screen = (title: string, name: string, view: Screen['view'], status = 200, headers: [string, string][] = [], scriptPath?: string) => screenResponse(title, { name: 'auth/' + name, view }, { status, headers, scriptPath: scriptPath ?? (service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys ? mount + '/assets/passkeys.js' : undefined), presentation, turnstile: options.challenge?.widget && (['/','/login','/identify','/forgot-password'].includes(request.path.slice(mount.length)||'/') || request.path.slice(mount.length)==='/email-code'&&!request.query.has('flowId')) ? options.challenge.widget : undefined, layout: ['/account', '/sessions', '/methods', '/second-factors', '/trusted-devices'].includes(request.path.slice(mount.length)) ? 'default' : 'compact', ui: options.ui });
                    const lang = (path: string) => mount + path + '?lang=' + encodeURIComponent(presentation.locale);
                    const formField = (name: string, label: string, type = 'text', autocomplete = 'off', required = true) => baseField(name, presentation?.textSource(label) ?? label, type, autocomplete, required);
                    const form = (action: string, csrf: string, fields: string, button: string) => { const actionName = action.split('?')[0]!.split('/').at(-1)!; return postForm({ action: action + (action.includes('?') ? '&' : '?') + 'lang=' + encodeURIComponent(presentation.locale), csrf, fields, label: presentation?.textSource(button) ?? button, ...(actionIcons[actionName] ? { icon: actionIcons[actionName] } : {}) }); };
                    const profileFields = () => profileMarkup(formField, presentation);
                    const factors = () => `<details class="ui-disclosure"><summary>${tr('ux.twoStep')}</summary><p class="ui-muted">${tr('ux.twoStepHelp')}</p>` + formField('totp', 'Authenticator code (if enabled)', 'text', 'one-time-code', false) + formField('recoveryCode', 'Recovery code (instead of authenticator code)', 'text', 'off', false) + (service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys ? secondFactorButton(mount,text) : '') + '</details>';
                    const passkeyLogin = (csrf: string) => options.passkeys ? `<form method="post" action="${escapeHtml(mount+'/login')}">${csrfField(csrf)}<fieldset><legend>${escapeHtml(text('Passkey sign-in'))}</legend><p>${escapeHtml(text('If your account uses a second factor, confirm it before choosing your sign-in passkey.'))}</p>${factors()}${passkeyButton('login',text)}</fieldset></form>` : '';
                    const completed = (value: unknown, title: string, message: string, headers: [string,string][] = [], destination = '/account') => wantsJson(request) ? jsonResponse(200, value, headers) : screen(title, 'status', { alert: false, message: text(message), href: lang(destination), label: presentation.text(destination === '/login' ? 'ux.backSignIn' : 'copy.continueToYourAccount') }, 200, headers);
                    let submittedEmail: string | undefined;
                    const passwordPage = (email: string, csrf: string, failed = false) => {
                        return screen('Enter your password', 'password', { failed: failed ? presentation.text('ux.signInFailed') : null, intro: '', email, changeHref: lang('/login'), changeLabel: presentation.text('ux.change'), form: m(form(mount + '/login', csrf, hidden('email', email) + formField('password', 'Password', 'password', 'current-password') + (options.sendToken ? `<p class="ui-link-list"><a href="${escapeHtml(lang('/forgot-password'))}">${tr('nav.forgotPassword')}</a></p>` : '') + factors(), 'Sign in')) }, failed ? 401 : 200, [], options.passkeys ? mount + '/assets/passkeys.js' : undefined);
                    };
                    try {
                        const path = request.path.slice(mount.length) || '/';
                        const abuseDenied=await abuseGuard(request,presentation);if(abuseDenied)return abuseDenied;
                        const restored=await manualRecovery.handle(request,presentation);if(restored)return restored;
                        const recovered=await factorRecovery.handle(request,presentation);if(recovered)return recovered;
                        const sessionToken = http.session(request), sessionPrincipal = sessionToken ? await service.authenticate(sessionToken) : null;
                        if (sessionPrincipal && enrollmentRequired(sessionPrincipal)) {
                            const enrollmentPaths = new Set(['/account', '/csrf', '/logout', '/verify', '/send-verification', '/totp/begin', '/totp/confirm', '/login', '/identify', '/step-up', '/assets/passkeys.js', '/email-code', '/send-email-code', '/providers/complete', '/second-factors', '/passkeys/second-factor', '/second-factor/options', '/second-factor/verify']);
                            const proofRenewal = /^\/passkeys\/(?:login|step-up|register)\/(?:options|verify)$/.test(path) || /^\/providers\/[a-z][a-z0-9-]{0,31}\/(?:start|callback)$/.test(path);
                            if (!enrollmentPaths.has(path) && !proofRenewal) {
                                if (['GET', 'HEAD'].includes(request.method) && !wantsJson(request))
                                    return redirect(mount + '/account');
                                return jsonResponse(403, { error: 'Complete required account enrollment', restrictions: sessionPrincipal.restrictions });
                            }
                            if (sessionPrincipal.restrictions?.includes('verify-email') && (path === '/totp/begin' || path === '/totp/confirm' || path === '/second-factors' || path === '/passkeys/second-factor' || path.startsWith('/passkeys/register/')))
                                throw new AuthHttpError(403, 'Verify your email before enrolling an authenticator');
                        }
                        if (path === '/register' && request.method !== 'POST' && ['open','invite-only','waitlist'].includes(registrationMode)) {
                            const query = new URLSearchParams();
                            if (request.query.get('lang')) query.set('lang', request.query.get('lang')!);
                            const invitations=request.query.getAll('token');
                            if(invitations.length>1 || (invitations[0] && !/^[A-Za-z0-9_-]{43}$/.test(invitations[0]))) throw new AuthHttpError(400,'Invalid invitation');
                            if(registrationMode==='invite-only' && invitations[0]) query.set('token',invitations[0]);
                            return redirect(mount + '/signup' + (query.size ? '?' + query : ''));
                        }
                        if (path === '/register' && request.method === 'POST' && service.getSecurityPolicy().requireEmailVerification) throw new AuthHttpError(403, 'Complete verified signup first');
                        const secondFactorResult = await secondFactors.handle(request);
                        if (secondFactorResult) return secondFactorResult;
                        const signupResult = await signup(request, presentation);
                        if (signupResult) return signupResult;
                        const flowResult = await flows.handle(request);
                        if (flowResult)
                            return flowResult;
                        if (path === '/assets/passkeys.js' && ['GET', 'HEAD'].includes(request.method) && options.passkeys)
                            return { status: 200, headers: [['content-type', 'text/javascript; charset=utf-8'], ['cache-control', 'no-store'], ['x-content-type-options', 'nosniff']], body: new TextEncoder().encode(passkeyScript) };
                        if (!['GET', 'HEAD', 'POST'].includes(request.method))
                            return jsonResponse(405, { error: 'Method not allowed' }, [['allow', 'GET, HEAD, POST']]);
                        if (request.method !== 'POST') {
                            const { csrf, headers } = http.prepare(request);
                            if (path === '/csrf')
                                return jsonResponse(200, { csrf }, headers);
                            if (path === '/' || path === '/login')
                                return screen('Sign in', 'sign-in', { intro: presentation.text('ux.signInIntro'), form: m(form(mount + '/identify', csrf, formField('email', 'Email address', 'email', 'username'), 'Continue')), alternativeLabel: presentation.text('ux.orContinueWith'), passkey: m(passkeyLogin(csrf)), providers: m(flows.buttons(csrf, false, text, presentation.locale, presentation)), linksLabel: text('Sign-in methods'), links: [...(registrationMode !== 'off' ? [{ href: mount + '/register', label: presentation.text('action.register') }] : []), ...(factorRecovery.enabled() ? [{ href: mount + '/recover-factor', label: presentation.text('recovery.lost') }] : []), ...(options.sendToken ? [{ href: mount + '/forgot-password', label: presentation.text('nav.forgotPassword') }] : []), ...(options.sendEmailCode ? [{ href: mount + '/email-code', label: presentation.text('copy.emailSignIn') }] : [])] }, 200, headers, options.passkeys ? mount + '/assets/passkeys.js' : undefined);
                            if (path === '/register') {
                                const invitations = request.query.getAll('token');
                                if (invitations.length > 1 || invitations.some(token => token.length > 512))
                                    throw new AuthHttpError(400, 'Invalid invitation');
                                if (registrationMode === 'off')
                                    throw new AuthHttpError(404, 'Not found');
                                return screen(registrationMode === 'waitlist' ? 'Request an account' : 'Create account', 'register', { form: m(form(mount + '/register', csrf, formField('email', 'Email address', 'email', 'username') + formField('password', 'Password (at least 15 characters)', 'password', 'new-password') + profileFields() + `<div hidden><label>${tr("copy.leaveEmpty")}<input name="website" tabindex="-1" autocomplete="off"></label></div>` + (registrationMode === 'invite-only' ? (invitations.length ? hidden('invitationToken', invitations[0]!) : formField('invitationToken', 'Invitation token')) : ''), registrationMode === 'waitlist' ? 'Request account' : 'Create account')) }, 200, headers);
                            }
                            if (path === '/forgot-password') {
                                if (!options.sendToken)
                                    throw new AuthHttpError(404, 'Not found');
                                return screen('Reset password', 'forgot-password', { intro: presentation.text('ux.resetIntro'), form: m(form(mount + '/forgot-password', csrf, formField('email', 'Email address', 'email', 'username'), 'Send reset link')) }, 200, headers);
                            }
                            if (path === '/email-code') {
                                if (!options.sendEmailCode)
                                    throw new AuthHttpError(404, 'Not found');
                                const flows = request.query.getAll('flowId');
                                if (flows.length > 1 || flows.some(value => !/^[A-Za-z0-9_-]{43}$/.test(value)))
                                    throw new AuthHttpError(400, 'Invalid email flow');
                                return screen('Sign in by email', 'email-code', { form: m(flows.length ? form(mount + '/email-code', csrf, hidden('flowId', flows[0]!) + formField('code', 'Six-digit email code', 'text', 'one-time-code') + factors(), 'Sign in') : form(mount + '/send-email-code', csrf, formField('email', 'Email address', 'email', 'username'), 'Send sign-in code')) }, 200, headers);
                            }
                            if (path === '/verify-email-change' || path === '/cancel-email-change') {
                                const tokens = request.query.getAll('token');
                                if (tokens.length !== 1 || tokens[0]!.length > 512)
                                    throw new AuthHttpError(400, 'A single token is required');
                                return screen(path === '/verify-email-change' ? 'Confirm new email after the 24-hour cooling period' : 'Cancel email change', 'confirm-token', { form: m(form(mount + path, csrf, hidden('token', tokens[0]!), 'Confirm')) }, 200, headers);
                            }
                            if (path === '/cancel-deletion') {
                                const tokens = request.query.getAll('token');
                                if (tokens.length !== 1 || tokens[0]!.length > 512)
                                    throw new AuthHttpError(400, 'A single token is required');
                                return screen('Cancel account deletion', 'confirm-token', { form: m(form(mount + path, csrf, hidden('token', tokens[0]!), 'Keep my account')) }, 200, headers);
                            }
                            if (path === '/verify' || path === '/reset') {
                                const tokens = request.query.getAll('token');
                                if (tokens.length !== 1 || tokens[0]!.length > 512)
                                    throw new AuthHttpError(400, 'A single token is required');
                                return screen(path === '/verify' ? 'Verify email' : 'Choose a new password', 'confirm-token', { form: m(form(mount + path, csrf, (path === '/verify' ? `<p>${tr("copy.verifyEmailConfirmNotice")}</p>` : '') + hidden('token', tokens[0]!) + (path === '/reset' ? formField('password', 'New password', 'password', 'new-password') : ''), path === '/verify' ? 'Verify email' : 'Reset password')) }, 200, headers);
                            }
                            const current = await principal(request);
                            if (path === '/account') {
                                const user = await service.getUser(current.principal.id);
                                if (!user)
                                    throw new AuthHttpError(401, 'Sign in required');
                                if (wantsJson(request))
                                    return jsonResponse(200, { user, csrf, ...(current.principal.restrictions ? { restrictions: current.principal.restrictions } : {}), ...(current.principal.impersonatorId ? { impersonatorId: current.principal.impersonatorId } : {}) }, headers);
                                if (enrollmentRequired(current.principal)) {
                                    const needsEmail = current.principal.restrictions!.includes('verify-email');
                                    const passkeyOffer = !needsEmail && service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys;
                                    return screen('Complete account enrollment', 'enrollment', { status: presentation.text('copy.applicationAccessRemainsBlockedUntilAllRequiredEnrollmentStepsAreComplete'), email: user.email, heading: presentation.text(needsEmail ? 'copy.verifyYourEmailFirst' : 'copy.enrollAnAuthenticator'), form: needsEmail ? (options.sendToken ? m(form(mount + '/send-verification', csrf, '', 'Send verification email')) : null) : m(form(mount + '/totp/begin', csrf, '', 'Set up authenticator')), unavailable: needsEmail && !options.sendToken ? presentation.text('copy.emailDeliveryIsUnavailableContactTheSiteOperator') : null, passkeyHref: passkeyOffer ? mount + '/second-factors' : null, passkeyLabel: passkeyOffer ? text('Set up a passkey second factor') : null, stepUpHref: mount + '/step-up', stepUpLabel: presentation.text('page.stepUp'), stepUpHelp: presentation.text('copy.ifYourRecentSignInHasExpired'), signOut: m(form(mount + '/logout', csrf, '', 'Sign out')) }, 200, headers);
                                }
                                if (current.principal.impersonatorId)
                                    return screen('Support impersonation', 'impersonation', { navigation: m(navigation), alert: presentation.text('copy.youAreViewingThisAccountAsASupportAdministratorAccountSecurityChangesAreDisabledEndImpersonationToSignInAsYour'), form: m(form(mount + '/logout', csrf, '', 'End impersonation')) }, 200, headers);
                                const section = (heading: string, content: string, danger = false) => ({ heading: text(heading), content: m(content), danger });
                                const profile = section('Profile', form(mount + '/profile', csrf, profileFields(), 'Update profile'));
                                const password = section('Password', form(mount + '/change-password', csrf, formField('currentPassword', 'Current password', 'password', 'current-password') + formField('password', 'New password', 'password', 'new-password') + factors(), 'Change password and sign out all sessions'));
                                const authenticator = section('Authenticator', user.totpEnabled ? `<details class="ui-disclosure"><summary>${tr('ux.disableAuthenticator')}</summary>` + form(mount + '/totp/disable', csrf, formField('password', 'Password (if configured)', 'password', 'current-password', false) + formField('code', 'Authenticator code', 'text', 'one-time-code', false) + (service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys ? secondFactorButton(mount,text) : ''), 'Disable authenticator') + '</details>' : form(mount + '/totp/begin', csrf, '', 'Set up authenticator'));
                                const email = options.sendToken ? section('Email address', form(mount + '/change-email', csrf, formField('email', 'New email address', 'email', 'email') + formField('password', 'Current password (if configured)', 'password', 'current-password', false) + factors(), 'Request email change (24-hour cooling period)')) : undefined;
                                const methods = passkeyButton('register', text) + flows.buttons(csrf, true, text, presentation.locale, presentation);
                                const data = section('Account data', form(mount + '/export', csrf, '', 'Export account data'));
                                const deletion = options.sendToken ? section('Delete account', form(mount + '/delete', csrf, `<p>${tr('message.deletionGrace', { days: service.getSecurityPolicy().deletionGraceMs / 86400000 })}</p>` + formField('confirmation', 'Type DELETE to confirm') + formField('password', 'Password (if configured)', 'password', 'current-password', false) + factors(), 'Schedule account deletion'), true) : undefined;
                                return screen('Your account', 'account', { navigation: m(navigation), overviewLabel: presentation.text('page.account'), email: user.email, signOut: m(form(mount + '/logout', csrf, '', 'Sign out')), state: presentation.text('message.accountState', { email: presentation.text(user.emailVerified ? 'state.verified' : 'state.unverified'), authenticator: presentation.text(user.totpEnabled ? 'state.enabled' : 'state.disabled') }), verification: m(options.sendToken && !user.emailVerified ? form(mount + '/send-verification', csrf, '', 'Send verification email') : ''), sections: [profile, password, authenticator, ...(email ? [email] : []), ...(methods ? [section('Sign-in methods', methods)] : []), data, ...(deletion ? [deletion] : [])] }, 200, headers, options.passkeys ? mount + '/assets/passkeys.js' : undefined);
                            }
                            if(path==='/second-factors') {
                                if(!service.getSecurityPolicy().allowPasskeySecondFactor || !options.passkeys)throw new AuthHttpError(404,'Not found');
                                const keys=await service.listPasskeys(current.principal.id);
                                const passkeys=keys.map(key=>({id:key.id,secondFactor:key.secondFactor===true}));
                                if(wantsJson(request))return jsonResponse(200,{passkeys,csrf},headers);
                                return screen('Second factors','second-factors',{navigation:m(navigation),csrf:m(csrfField(csrf)),intro:text('A second-factor passkey must be different from the passkey used for primary sign-in.'),register:m(passkeyButton('register',text)),passkeys:passkeys.map(key=>({id:key.id,state:text(key.secondFactor?'Enabled':'Disabled'),form:m(form(mount+'/passkeys/second-factor',csrf,hidden('credentialId',key.id)+hidden('enabled',key.secondFactor?'false':'true')+(key.secondFactor?'':secondFactorButton(mount,text)),key.secondFactor?'Disable passkey second factor':'Enable passkey second factor'))}))},200,headers,mount+'/assets/passkeys.js');
                            }
                            if(path==='/trusted-devices') {
                                if(!service.getSecurityPolicy().trustedDeviceTtlMs)throw new AuthHttpError(404,'Not found');
                                const devices=await service.listTrustedDevices(current.token);
                                if(wantsJson(request))return jsonResponse(200,{devices,csrf},headers);
                                return screen('Remembered devices','trusted-devices',{navigation:m(navigation),intro:text('Remembering a device requires a real second factor. Sensitive actions still require fresh verification.'),form:m(form(mount+'/trusted-devices/remember',csrf,formField('label','Device label','text','off',false),'Remember this device')),devices:devices.map(device=>({label:device.label,expires:new Date(device.expires).toISOString(),form:m(form(mount+'/trusted-devices/revoke',csrf,hidden('deviceId',device.id),'Forget device'))}))},200,headers);
                            }
                            if (path === '/sessions') {
                                const sessions = await service.listSessions(current.principal.id);
                                if (wantsJson(request))
                                    return jsonResponse(200, { sessions, csrf }, headers);
                                return screen('Your sessions', 'sessions', { navigation: m(navigation), sessions: sessions.map(session => ({ summary: presentation.text('message.sessionStarted', { created: new Date(session.created).toISOString(), expires: new Date(session.expires).toISOString() }), form: m(form(mount + '/revoke-session', csrf, hidden('sessionId', session.id), 'Revoke this session')) })), form: m(form(mount + '/revoke-sessions', csrf, '', 'Sign out all sessions')) }, 200, headers);
                            }
                            if (path === '/methods') {
                                const methods = await service.exportAccount(current.token);
                                if (wantsJson(request))
                                    return jsonResponse(200, { passkeys: methods.passkeys, identities: methods.identities, csrf }, headers);
                                return screen('Sign-in methods', 'methods', { navigation: m(navigation), passkeysHeading: presentation.text('copy.passkeys'), passkeys: methods.passkeys.map(key => ({ form: m(form(mount + '/passkeys/remove', csrf, hidden('credentialId', key.id) + `<p>${escapeHtml(key.id)}</p>`, 'Remove passkey')) })), providersHeading: presentation.text('copy.linkedProviders'), identities: methods.identities.map(identity => ({ form: m(form(mount + '/providers/unlink', csrf, hidden('provider', identity.provider) + hidden('subject', identity.subject) + `<p>${escapeHtml(identity.provider)}: ${escapeHtml(identity.subject)}</p>`, 'Unlink provider')) })), note: presentation.text('copy.theLastSignInMethodCannotBeRemoved') }, 200, headers);
                            }
                            if (path === '/step-up')
                                return screen('Confirm your identity', 'step-up', { navigation: m(navigation), form: m(form(mount + '/step-up', csrf, formField('password', 'Password', 'password', 'current-password') + factors(), 'Confirm identity')), passkey: m(passkeyButton('step-up', text)) }, 200, headers, options.passkeys ? mount + '/assets/passkeys.js' : undefined);
                            throw new AuthHttpError(404, 'Not found');
                        }
                        const fields = readFields(request, ['email', 'password', 'currentPassword', 'confirmation', 'invitationToken', 'totp', 'recoveryCode', 'token', 'code', 'sessionId', 'credentialId', 'provider', 'subject', 'flowId', 'displayName', 'locale', 'termsAccepted', 'website', 'secondFactorToken', 'enabled', 'deviceId', 'label', ...metadataFields.map(([name]) => 'meta.' + name)]);
                        http.verify(request, fields);
                        submittedEmail = fields.email && fields.email.length <= 320 ? fields.email : undefined;
                        const secondFactor = fields.secondFactorToken ? {secondFactor:secondFactors.proof(request,fields.secondFactorToken)} : {};
                        if (path === '/identify') {
                            const email = fields.email || '';
                            if (email.length > 320 || !email.includes('@'))
                                throw new AuthHttpError(400, 'Enter an email address');
                            return passwordPage(email, fields.csrf || '');
                        }
                        if (path === '/login' || path === '/register') {
                            if (path === '/register' && isHoneypotFilled(fields.website))
                                return jsonResponse(202, { message: presentation.textSource('Registration request received.') });
                            if (path === '/register' && registrationMode === 'off')
                                throw new AuthHttpError(404, 'Not found');
                            if (path === '/register') {
                                const registerProfile = profileInput(fields);
                                await checkBeforeRegister(request, fields.email || '', registerProfile as unknown as Record<string, unknown>);
                            }
                            if (path === '/register' && registrationMode === 'waitlist') {
                                const requested = await service.requestRegistration({ email: fields.email || '', password: fields.password || '', profile: profileInput(fields) });
                                // Not awaited: only a duplicate sends this notice, so waiting for
                                // delivery would make the reply slower exactly when the address
                                // already has an account (#548). notice() is best-effort and never
                                // rejects; the catch only keeps an unexpected fault off the event loop.
                                if (requested.duplicate)
                                    void notice(fields.email || '', 'registration-attempt', presentation.locale).catch(() => undefined);
                                return jsonResponse(202, { message: presentation.textSource('Registration request received.') });
                            }
                            const device = http.device(request);
                            const result = path === '/register' ? await service.register({ email: fields.email || '', password: fields.password || '', device: { id: device.id, label: device.label }, profile: profileInput(fields), ...(fields.invitationToken ? { invitationToken: fields.invitationToken } : {}) }) : await service.login({ ...trusted(request), email: fields.email || '', password: fields.password || '', device: { id: device.id, label: device.label }, ...(typeof request.client === 'string' ? { client: request.client } : {}), ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...secondFactor });
                            // `result.duplicate` (register only) is the synthetic, non-authenticating
                            // response for an email that already has an account: the account was
                            // never touched, so lifecycle hooks and the new-device notice must not
                            // fire for it. Its owner instead gets a registration-attempt notice, kept
                            // consistent with the other identical-response anti-enumeration paths.
                            if (path === '/register' && result.duplicate)
                                await notice(result.user.email, 'registration-attempt', noticeLocale(request, result.user));
                            else if (result.newDevice)
                                await notice(result.user.email, 'new-device', noticeLocale(request,result.user));
                            if (path === '/register' && !result.duplicate && hooks.onSignUp)
                                await hooks.onSignUp({ accountId: result.user.id, email: result.user.email }, extensionHookContext(request));
                            // A duplicate registration keeps the same status/body as a genuine one
                            // (no-enumeration contract, JSON-API.md), but must not hand out a
                            // session cookie: `result.token` was never persisted for it (see
                            // auth-core.ts's `create`), so a cookie built from it would look
                            // well-formed while authenticating nothing. Only clear the anonymous
                            // flow cookie, exactly like the genuine path already does (#548).
                            const outcomeHeaders = result.duplicate ? [['set-cookie', http.setCookie(http.flowCookie, '', 0)] as [string, string], ...device.headers] : [...http.sessionHeaders(result.token), ...device.headers];
                            return wantsJson(request) ? jsonResponse(path === '/register' ? 201 : 200, { user: result.user, csrf: http.token(result.token), ...(result.principal.restrictions ? { restrictions: result.principal.restrictions } : {}) }, outcomeHeaders) : redirect(mount + '/account', outcomeHeaders);
                        }
                        if (path === '/send-email-code') {
                            if (!options.sendEmailCode)
                                throw new AuthHttpError(404, 'Not found');
                            const email = fields.email || '', issued = await service.issueEmailCode({ email, ...(typeof request.client === 'string' ? { client: request.client } : {}) });
                            {
                                // Always attempt delivery, even when no account matched (`issued.code`
                                // is then null): a well-formed but inert decoy code keeps response
                                // timing from revealing account eligibility (JSON-API.md). A decoy is
                                // never stored server-side, so it never verifies anything.
                                const controller = new AbortController();
                                let timer: ReturnType<typeof setTimeout> | undefined;
                                try {
                                    await Promise.race([options.sendEmailCode({ email, flowId: issued.flowId, code: issued.code ?? String(randomInt(1000000)).padStart(6, '0'), locale:presentation.locale, signal: controller.signal }), new Promise<void>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 5000); })]);
                                }
                                catch { /* Delivery is best-effort here too: the code is already issued, and the flow continues on the verification step. */ }
                                finally {
                                    if (timer)
                                        clearTimeout(timer);
                                }
                            }
                            return wantsJson(request) ? jsonResponse(200, { message: presentation.textSource('If this account is eligible, a sign-in code will be sent.'), flowId: issued.flowId }) : screen('Enter your email code', 'email-code', { form: m(form(mount + '/email-code', fields.csrf || '', hidden('flowId', issued.flowId) + formField('code', 'Six-digit email code', 'text', 'one-time-code') + factors(), 'Sign in')) });
                        }
                        if (path === '/email-code') {
                            if (!options.sendEmailCode)
                                throw new AuthHttpError(404, 'Not found');
                            const device = http.device(request);
                            const result = await service.consumeEmailCode({ ...trusted(request), device: { id: device.id, label: device.label }, flowId: fields.flowId || '', code: fields.code || '', ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...secondFactor });
                            if (result.newDevice)
                                await notice(result.user.email, 'new-device', noticeLocale(request,result.user));
                            return wantsJson(request) ? jsonResponse(200, { user: result.user, csrf: http.token(result.token), ...(result.principal.restrictions ? { restrictions: result.principal.restrictions } : {}) }, [...http.sessionHeaders(result.token), ...device.headers]) : redirect(mount + '/account', [...http.sessionHeaders(result.token), ...device.headers]);
                        }
                        if (path === '/forgot-password') {
                            await notify(fields.email || '', 'reset-password',presentation.locale);
                            return wantsJson(request) ? jsonResponse(200, { message: presentation.textSource('If this account is eligible, a reset message will be sent.') }) : screen('Check your email', 'status', { alert: false, message: presentation.text('ux.resetSent'), href: mount + '/login', label: presentation.text('ux.backSignIn') });
                        }
                        if (path === '/verify-email-change') {
                            const changed = await service.confirmEmailChange(fields.token || '');
                            await notice(changed.email, 'email-changed', noticeLocale(request, changed));
                            return wantsJson(request) ? jsonResponse(200, { changed: true }, http.clearSession()) : redirect(mount + '/login', http.clearSession());
                        }
                        if (path === '/cancel-email-change') {
                            await service.cancelEmailChange(fields.token || '');
                            return completed({cancelled:true}, 'Request cancelled', 'Your request has been cancelled.');
                        }
                        if (path === '/cancel-deletion') {
                            await service.cancelDeletion(fields.token || '');
                            return completed({cancelled:true}, 'Request cancelled', 'Your request has been cancelled.');
                        }
                        if (path === '/verify') {
                            const verified = await service.consumeVerification(fields.token || '', sessionToken);
                            if (verified.signInMethodsReset)
                                return wantsJson(request) ? jsonResponse(200, { verified: true, signInRequired: true, passwordResetRequired: true }) : screen('Email verified', 'status', { alert: false, message: presentation.text('ux.emailVerifiedMethodsReset'), href: lang('/forgot-password'), label: presentation.text('nav.forgotPassword') });
                            if (service.getSecurityPolicy().requireEmailVerification)
                                return wantsJson(request) ? jsonResponse(200, { verified: true, signInRequired: true }, http.clearSession()) : redirect(mount + '/login', http.clearSession());
                            return completed({verified:true}, 'Email verified', 'Your email address has been verified.');
                        }
                        if (path === '/reset') {
                            const changed = await service.resetPassword({ token: fields.token || '', password: fields.password || '' });
                            await notice(changed.email, 'password-changed', noticeLocale(request, changed));
                            return wantsJson(request) ? jsonResponse(200, { reset: true }, http.clearSession()) : screen('Password updated', 'status', { alert: false, message: presentation.text('ux.passwordUpdated'), href: mount + '/login', label: presentation.text('action.signIn') }, 200, http.clearSession());
                        }
                        const current = await principal(request);
                        if (current.principal.impersonatorId && path !== '/logout')
                            throw new AuthHttpError(403, 'Security changes are disabled during impersonation');
                        if(path==='/passkeys/second-factor') {
                            if(fields.enabled!=='true'&&fields.enabled!=='false')throw new AuthHttpError(400,'Invalid factor setting');
                            await service.setPasskeySecondFactor({token:current.token,credentialId:fields.credentialId||'',enabled:fields.enabled==='true',...secondFactor});
                            return wantsJson(request)?jsonResponse(200,{updated:true}):redirect(mount+'/second-factors');
                        }
                        if(path==='/trusted-devices/remember') {
                            const device=await service.rememberDevice({token:current.token,...(fields.label?{label:fields.label}:{})});
                            const headers:[string,string][]=[['set-cookie',http.setCookie(trustedCookie,device.token,Math.max(0,Math.min(2592000,Math.floor((device.expires-Date.now())/1000))))]];
                            return wantsJson(request)?jsonResponse(200,{remembered:true,expires:device.expires},headers):redirect(mount+'/trusted-devices',headers);
                        }
                        if(path==='/trusted-devices/revoke') {
                            await service.revokeTrustedDevice({token:current.token,deviceId:fields.deviceId||''});
                            const headers:[string,string][]=[['set-cookie',http.setCookie(trustedCookie,'',0)]];
                            return wantsJson(request)?jsonResponse(200,{revoked:true},headers):redirect(mount+'/trusted-devices',headers);
                        }
                        if (path === '/passkeys/remove') {
                            await service.removePasskey({ token: current.token, credentialId: fields.credentialId || '' });
                            return wantsJson(request) ? jsonResponse(200, { removed: true }) : redirect(mount + '/methods');
                        }
                        if (path === '/providers/unlink') {
                            await service.unlinkExternal({ token: current.token, provider: fields.provider || '', subject: fields.subject || '' });
                            return wantsJson(request) ? jsonResponse(200, { unlinked: true }) : redirect(mount + '/methods');
                        }
                        if (path === '/change-email') {
                            if (!options.sendToken)
                                throw new AuthHttpError(503, 'Email delivery required');
                            const change = await service.requestEmailChange({ token: current.token, email: fields.email || '', ...(fields.password ? { password: fields.password } : {}), ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...secondFactor });
                            try {
                                await deliver(change.oldEmail, change.cancelToken, 'cancel-email-change', true,presentation.locale);
                                await deliver(change.newEmail, change.verificationToken, 'verify-email-change', true,presentation.locale);
                            }
                            catch {
                                await service.cancelEmailChange(change.cancelToken);
                                throw new AuthHttpError(503, 'Email delivery failed; change cancelled');
                            }
                            return completed({requested:true,activateAfter:change.activateAfter}, 'Check your email', 'Check your new email for confirmation instructions. The change can only finish after the 24-hour cooling period.');
                        }
                        if (path === '/revoke-session') {
                            await service.revokeSession({ token: current.token, sessionId: fields.sessionId || '' });
                            return completed({revoked:true}, 'Session signed out', 'The selected session has been signed out.');
                        }
                        if (path === '/profile') {
                            const profile = await service.updateProfile({ token: current.token, profile: profileInput(fields) });
                            return wantsJson(request) ? jsonResponse(200, { profile }) : redirect(mount + '/account');
                        }
                        if (path === '/export')
                            return jsonResponse(200, await service.exportAccount(current.token), [['content-disposition', 'attachment; filename="account.json"']]);
                        if (path === '/change-password') {
                            await service.changePassword({ token: current.token, currentPassword: fields.currentPassword || '', password: fields.password || '', ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...secondFactor });
                            await notice(current.principal.email,'password-changed',presentation.locale);
                            return wantsJson(request) ? jsonResponse(200, { changed: true }, http.clearSession()) : redirect(mount + '/login', http.clearSession());
                        }
                        if (path === '/delete') {
                            if (!options.sendToken)
                                throw new AuthHttpError(503, 'Email delivery is required for deletion recovery');
                            if (fields.confirmation !== 'DELETE')
                                throw new AuthHttpError(400, 'Deletion confirmation required');
                            const result = await service.deleteAccount({ token: current.token, ...(fields.password ? { password: fields.password } : {}), ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...secondFactor });
                            // Fires when the account owner schedules their own deletion (the
                            // grace period still applies and can be cancelled); it does not
                            // yet fire from an administrator-initiated deletion or from the
                            // background purge once the grace period elapses.
                            if (hooks.onDelete)
                                await hooks.onDelete({ accountId: current.principal.id, email: current.principal.email }, extensionHookContext(request));
                            await deliver(current.principal.email, result.cancelToken, 'cancel-deletion',false,presentation.locale);
                            return completed({deletionScheduled:true,deleteAfter:result.deleteAfter,cancellationDays:service.getSecurityPolicy().deletionGraceMs / 86400000}, 'Account deletion scheduled', 'Your account deletion is scheduled. Check your email for cancellation instructions if you change your mind.', http.clearSession(), '/login');
                        }
                        if (path === '/logout') {
                            await service.logout(current.token);
                            return wantsJson(request) ? jsonResponse(200, { signedOut: true }, http.clearSession()) : redirect(mount + '/login', http.clearSession());
                        }
                        if (path === '/revoke-sessions') {
                            await service.revokeSessions(current.principal.id);
                            return wantsJson(request) ? jsonResponse(200, { signedOut: true }, http.clearSession()) : redirect(mount + '/login', http.clearSession());
                        }
                        if (path === '/step-up') {
                            const result = await service.stepUp({ token: current.token, password: fields.password || '', ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...(typeof request.client === 'string' ? { client: request.client } : {}), ...secondFactor });
                            return wantsJson(request) ? jsonResponse(200, { confirmed: true, csrf: http.token(result.token), ...(result.principal.restrictions ? { restrictions: result.principal.restrictions } : {}) }, http.sessionHeaders(result.token)) : redirect(mount + '/account', http.sessionHeaders(result.token));
                        }
                        if (path === '/send-verification') {
                            await notify(current.principal.email, 'verify-email',presentation.locale);
                            return completed({message:presentation.textSource('If this account is eligible, a verification message will be sent.')}, 'Check your email', 'If this account is eligible, a verification message will be sent.');
                        }
                        if (path === '/totp/begin') {
                            const enrollment = await service.beginTotp(current.token);
                            if (wantsJson(request))
                                return jsonResponse(200, enrollment);
                            return screen('Set up authenticator', 'totp-setup', { intro: presentation.text('copy.addThisKeyToYourAuthenticator'), secret: enrollment.secret, form: m(form(mount + '/totp/confirm', http.token(current.token), formField('code', 'Authenticator code', 'text', 'one-time-code'), 'Confirm authenticator')) });
                        }
                        if (path === '/totp/confirm') {
                            const enrolled = await service.confirmTotp({ token: current.token, code: fields.code || '' });
                            return wantsJson(request) ? jsonResponse(200, enrolled) : screen('Save your recovery codes', 'recovery-codes', { intro: presentation.text('copy.storeTheseCodesSecurelyEachCanBeUsedOnce'), codes: enrolled.recoveryCodes, href: mount + '/account', label: presentation.text('copy.continueToYourAccount') });
                        }
                        if (path === '/totp/disable') {
                            await service.disableTotp({ token: current.token, password: fields.password || '', code: fields.code || '', ...secondFactor });
                            return wantsJson(request) ? jsonResponse(200, { disabled: true }) : redirect(mount + '/account');
                        }
                        throw new AuthHttpError(404, 'Not found');
                    }
                    catch (error) {
                        const path = request.path.slice(mount.length);
                        if (!wantsJson(request) && path === '/login' && submittedEmail && error instanceof Error && 'status' in error && error.status === 401) {
                            return passwordPage(submittedEmail, http.prepare(request).csrf, true);
                        }
                        const retryPath = error instanceof Error && 'status' in error && error.status === 401 ? '/login' : path.startsWith('/signup') ? '/signup' : ['/login', '/identify', '/forgot-password', '/recover-factor'].includes(path) ? path === '/identify' ? '/login' : path : '/account';
                        return httpFailure(error, request, presentation, {href:mount + retryPath + '?lang=' + encodeURIComponent(presentation.locale),label:text('Try again')}, options.ui);
                    }
                },
            };
        } };
}
export type { AuthUser };
