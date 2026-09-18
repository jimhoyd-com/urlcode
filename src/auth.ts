import { icon, button as uiButton } from '@jimhoyd/urlcode-ui';
import type { IconName } from '@jimhoyd/urlcode-ui';
import {createAbuseGuard} from './abuse-http.ts';
import type {AuthChallenge} from './challenge.ts';
import {createManualRecoveryFlows} from './manual-recovery.ts';
import {createFactorRecoveryFlows} from './factor-recovery.ts';
import type {FactorRecoveryMessage} from './factor-recovery.ts';
import { createPresentation } from './presentation.ts';
import type { PresentationContext } from './presentation.ts';
import type { RegistrationInput, MetadataValue } from './registration.ts';
import { isHoneypotFilled } from './registration.ts';
import type { Presentation } from './presentation.ts';
import { createSecondFactorFlows } from './second-factor-flows.ts';
import { createSignup } from './auth-signup.ts';
import { createAuthFlows } from './auth-flows.ts';
import type { OidcProvider } from './oidc.ts';
import type { PasskeyProvider } from './passkeys.ts';
import type { RuntimeExtension, ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AuthService, AuthPrincipal, AuthUser } from './auth-core.ts';
import { AuthHttp, AuthHttpError, csrfField, escapeHtml, formField as baseField, httpFailure, jsonResponse, pageResponse as renderPage, readFields, wantsJson, passkeyScript, secondFactorButton } from './auth-ui.ts';
import type { AuthHttpResponse } from './auth-ui.ts';
export interface AuthExtensionOptions {
    challenge?:AuthChallenge;
    sendFactorRecovery?:(message:FactorRecoveryMessage)=>Promise<void>;
    presentation?: Presentation;
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
const defaultPresentation = createPresentation();
function enrollmentRequired(principal: AuthPrincipal): boolean { return Boolean(principal.restrictions?.length); }
export function hasPermission(principal: AuthPrincipal, permission: string): boolean { return !enrollmentRequired(principal) && (principal.permissions.includes('*') || principal.permissions.includes(permission)); }
const schema = { type: 'object', additionalProperties: false, properties: { registration: { enum: ['open', 'invite-only', 'waitlist', 'off'] } } };
const policySchema = { type: 'object', additionalProperties: false, properties: { role: { type: 'string', minLength: 1, maxLength: 64 }, permission: { type: 'string', minLength: 1, maxLength: 128 }, verified: { type: 'boolean' }, freshWithinSeconds: { type: 'integer', minimum: 1, maximum: 3600 }, onDeny: { enum: [401, 403, 404, 'sign-in'] } }, minProperties: 0 };
const actionIcons: Readonly<Record<string, IconName>> = {identify:'arrow-right',login:'arrow-right','step-up':'shield',logout:'log-out',export:'download'};
function renderForm(action: string, csrf: string, fields: string, label: string): string {
    const actionName = action.split('?')[0]!.split('/').at(-1)!;
    return `<form class="ui-stack" method="post" action="${escapeHtml(action)}">${csrfField(csrf)}${fields}${uiButton(label,'submit',actionIcons[actionName])}</form>`;
}
function hidden(name: string, value: string): string { return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`; }
export function authExtension(options: AuthExtensionOptions): RuntimeExtension {
    return { name: 'auth', version: '1', projectSha256: options.projectSha256, targets: ['node'], schema, policySchema, credentialHeaders: ['cookie', 'authorization', 'x-csrf-token'],
        activate(config, context) {
            if (context.mounts.length !== 1)
                throw new Error('Auth requires exactly one mount');
            const mount = context.mounts[0]!, http = new AuthHttp({ origin: context.origin, csrfKey: options.csrfKey }), service = options.service, registrationMode = String(config.registration || 'off'), registration = registrationMode === 'open';
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
            const profileMarkup = (formField: typeof baseField = baseField, presentation?: PresentationContext) => formField('displayName', 'Display name', 'text', 'nickname', false) + formField('locale', 'Preferred language', 'text', 'language', false) + metadataFields.map(([name, field]) => baseField('meta.' + name, name + (field.type === 'boolean' ? ' (' + (presentation?.text('field.booleanHint') ?? 'true or false') + ')' : ''), field.type === 'number' ? 'number' : 'text', 'off', field.required === true)).join('') + (registrationSchema.termsVersion ? `<label><input type="checkbox" name="termsAccepted" value="true" required> ${escapeHtml((presentation ?? defaultPresentation.resolve()).text('message.acceptTerms', { version: registrationSchema.termsVersion }))}</label>` : '');
            const abuseGuard=createAbuseGuard(service,http,mount,options.challenge);
            const secondFactors = createSecondFactorFlows(options, http, mount);
            const trustedCookie = '__Host-urlcode-trusted-device';
            const trusted = (request: ExtensionRequest) => { const token = service.getSecurityPolicy().trustedDeviceTtlMs ? http.cookie(request, trustedCookie) : undefined; return token ? {trustedDevice:token} : {}; };
            const noticeLocale = (request: ExtensionRequest, user: AuthUser) => (options.presentation ?? defaultPresentation).resolve({ ...(user.profile?.locale ? {accountLocale:user.profile.locale} : {}), ...(request.query.get('lang') ? {queryLocale:request.query.get('lang')!} : {}), ...(request.headers.get('accept-language') ? {acceptLanguage:request.headers.get('accept-language')!} : {}) }).locale;
            const flows = createAuthFlows({ ...options, onSession: async (request, result) => {
                    if (result.newDevice)
                        await notice(result.user.email, 'new-device', noticeLocale(request,result.user));
                    return http.device(request).headers;
                }, enrollment: { required: !!registrationSchema.termsVersion || metadataFields.some(([, field]) => field.required), fields: (presentation) => profileMarkup((name, label, ...rest) => baseField(name, presentation?.textSource(label) ?? label, ...rest), presentation), read: profileInput, names: ['displayName', 'locale', 'termsAccepted', ...metadataFields.map(([name]) => 'meta.' + name)] } }, http, mount, registration);
            const factorRecovery=createFactorRecoveryFlows(options,http,mount);
            const manualRecovery=createManualRecoveryFlows(service,http,mount);
            const signup = createSignup(options, http, mount, { fields: p => profileMarkup((name,label,...rest)=>baseField(name,p.textSource(label),...rest),p), read: profileInput, names: ['displayName','locale','termsAccepted',...metadataFields.map(([name])=>'meta.'+name)] });
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
                if (!issued.token)
                    return;
                await deliver(email, issued.token, purpose, false, locale);
            }
            async function notice(email: string, event: 'password-changed' | 'new-device' | 'email-changed' = 'password-changed', locale?: string): Promise<void> {
                if (!options.sendNotice)
                    return;
                const controller = new AbortController();
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([options.sendNotice({ email, event, ...(locale ? {locale} : {}), signal: controller.signal }), new Promise<void>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 5000); })]);
                }
                catch { }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
            }
            return {
                async authorize(requirement, request) {
                    let presentation = (options.presentation ?? defaultPresentation).resolve({ ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) });
                    try {
                        const token = http.session(request), user = token ? await service.authenticate(token) : null;
                        const locale = user && options.presentation ? (await service.getUser(user.id))?.profile?.locale : undefined;
                        if (locale)
                            presentation = (options.presentation ?? defaultPresentation).resolve({ accountLocale: locale });
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
                        return httpFailure(error, request, presentation);
                    }
                },
                async handle(request) {
                    let accountLocale: string | undefined;
                    if (options.presentation) {
                        try {
                            const session = http.session(request), actor = session ? await service.authenticate(session) : null;
                            accountLocale = actor ? (await service.getUser(actor.id))?.profile?.locale : undefined;
                        }
                        catch { }
                    }
                    const presentation = (options.presentation ?? defaultPresentation).resolve({ ...(accountLocale ? { accountLocale } : {}), ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) });
                    const tr = (key: string, values?: Readonly<Record<string, string | number>>) => escapeHtml(presentation.text(key, values));
                    const text = (value: string) => presentation?.textSource(value) ?? value;
                    const navigation = createNavigation(source => presentation?.textSource(source) ?? source, request.path.slice(mount.length));
                    const pageResponse = (...args: Parameters<typeof renderPage>) => renderPage(...[args[0], args[1], args[2], args[3], args[4] ?? (service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys ? mount + '/assets/passkeys.js' : undefined), presentation, options.challenge?.widget && (['/','/login','/identify','/forgot-password'].includes(request.path.slice(mount.length)||'/') || request.path.slice(mount.length)==='/email-code'&&!request.query.has('flowId')) ? options.challenge.widget : undefined, ['/account', '/sessions', '/methods', '/second-factors', '/trusted-devices'].includes(request.path.slice(mount.length)) ? 'default' : 'compact'] as Parameters<typeof renderPage>);
                    const formField = (name: string, label: string, type = 'text', autocomplete = 'off', required = true) => baseField(name, presentation?.textSource(label) ?? label, type, autocomplete, required);
                    const form = (action: string, csrf: string, fields: string, button: string) => renderForm(action + (action.includes('?') ? '&' : '?') + 'lang=' + encodeURIComponent(presentation.locale), csrf, fields, presentation?.textSource(button) ?? button);
                    const profileFields = () => profileMarkup(formField, presentation);
                    const factors = () => `<details class="ui-disclosure"><summary>${tr('ux.twoStep')}</summary><p class="ui-muted">${tr('ux.twoStepHelp')}</p>` + formField('totp', 'Authenticator code (if enabled)', 'text', 'one-time-code', false) + formField('recoveryCode', 'Recovery code (instead of authenticator code)', 'text', 'off', false) + (service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys ? secondFactorButton(mount,text) : '') + '</details>';
                    const passkeyLogin = (csrf: string) => options.passkeys ? `<form method="post" action="${escapeHtml(mount+'/login')}">${csrfField(csrf)}<fieldset><legend>${escapeHtml(text('Passkey sign-in'))}</legend><p>${escapeHtml(text('If your account uses a second factor, confirm it before choosing your sign-in passkey.'))}</p>${factors()}${passkeyButton('login',text)}</fieldset></form>` : '';
                    const completed = (value: unknown, title: string, message: string, headers: [string,string][] = [], destination = '/account') => wantsJson(request) ? jsonResponse(200, value, headers) : pageResponse(title, `<p role="status">${escapeHtml(text(message))}</p><a class="ui-button" href="${escapeHtml(mount + destination + '?lang=' + encodeURIComponent(presentation.locale))}">${tr(destination === '/login' ? 'ux.backSignIn' : 'copy.continueToYourAccount')}</a>`, 200, headers);
                    let submittedEmail: string | undefined;
                    const passwordPage = (email: string, csrf: string, failed = false) => {
                        const selectedEmail = `<div class="ui-selected-identity"><span class="ui-identifier">${escapeHtml(email)}</span><a href="${escapeHtml(mount + '/login?lang=' + encodeURIComponent(presentation.locale))}">${tr('ux.change')}</a></div>`;
                        return pageResponse('Enter your password', `${failed ? `<p class="error" role="alert">${tr('ux.signInFailed')}</p>` : ''}<p class="ui-intro">${tr('ux.passwordIntro')}</p>` + selectedEmail + form(mount + '/login', csrf, hidden('email', email) + formField('password', 'Password', 'password', 'current-password') + (options.sendToken ? `<p class="ui-link-list"><a href="${escapeHtml(mount + '/forgot-password?lang=' + encodeURIComponent(presentation.locale))}">${tr('nav.forgotPassword')}</a></p>` : '') + factors(), 'Sign in'), failed ? 401 : 200, [], options.passkeys ? mount + '/assets/passkeys.js' : undefined);
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
                                return pageResponse('Sign in', `<p class="ui-intro">${tr('copy.signInIntro')}</p>` + form(mount + '/identify', csrf, formField('email', 'Email address', 'email', 'username'), 'Continue') + passkeyLogin(csrf) + flows.buttons(csrf, false, text, presentation.locale, presentation) + `<nav class="ui-link-list" aria-label="${escapeHtml(text('Sign-in methods'))}">${registrationMode !== 'off' ? `<a href="${escapeHtml(mount + '/register')}">${tr("action.register")}</a>` : ''}${factorRecovery.enabled()?` <a href="${escapeHtml(mount+'/recover-factor')}">${tr("recovery.lost")}</a>`:''}${options.sendToken ? ` <a href="${escapeHtml(mount + '/forgot-password')}">${tr("nav.forgotPassword")}</a>` : ''}${options.sendEmailCode ? ` <a href="${escapeHtml(mount + '/email-code')}">${tr("copy.emailSignIn")}</a>` : ''}</nav>`, 200, headers, options.passkeys ? mount + '/assets/passkeys.js' : undefined);
                            if (path === '/register') {
                                const invitations = request.query.getAll('token');
                                if (invitations.length > 1 || invitations.some(token => token.length > 512))
                                    throw new AuthHttpError(400, 'Invalid invitation');
                                if (registrationMode === 'off')
                                    throw new AuthHttpError(404, 'Not found');
                                return pageResponse(registrationMode === 'waitlist' ? 'Request an account' : 'Create account', form(mount + '/register', csrf, formField('email', 'Email address', 'email', 'username') + formField('password', 'Password (at least 15 characters)', 'password', 'new-password') + profileFields() + `<div hidden><label>${tr("copy.leaveEmpty")}<input name="website" tabindex="-1" autocomplete="off"></label></div>` + (registrationMode === 'invite-only' ? (invitations.length ? hidden('invitationToken', invitations[0]!) : formField('invitationToken', 'Invitation token')) : ''), registrationMode === 'waitlist' ? 'Request account' : 'Create account'), 200, headers);
                            }
                            if (path === '/forgot-password') {
                                if (!options.sendToken)
                                    throw new AuthHttpError(404, 'Not found');
                                return pageResponse('Reset password', `<p class="ui-intro">${tr('ux.resetIntro')}</p>` + form(mount + '/forgot-password', csrf, formField('email', 'Email address', 'email', 'username'), 'Send reset link'), 200, headers);
                            }
                            if (path === '/email-code') {
                                if (!options.sendEmailCode)
                                    throw new AuthHttpError(404, 'Not found');
                                const flows = request.query.getAll('flowId');
                                if (flows.length > 1 || flows.some(value => !/^[A-Za-z0-9_-]{43}$/.test(value)))
                                    throw new AuthHttpError(400, 'Invalid email flow');
                                return pageResponse('Sign in by email', flows.length ? form(mount + '/email-code', csrf, hidden('flowId', flows[0]!) + formField('code', 'Six-digit email code', 'text', 'one-time-code') + factors(), 'Sign in') : form(mount + '/send-email-code', csrf, formField('email', 'Email address', 'email', 'username'), 'Send sign-in code'), 200, headers);
                            }
                            if (path === '/verify-email-change' || path === '/cancel-email-change') {
                                const tokens = request.query.getAll('token');
                                if (tokens.length !== 1 || tokens[0]!.length > 512)
                                    throw new AuthHttpError(400, 'A single token is required');
                                return pageResponse(path === '/verify-email-change' ? 'Confirm new email after the 24-hour cooling period' : 'Cancel email change', form(mount + path, csrf, hidden('token', tokens[0]!), 'Confirm'), 200, headers);
                            }
                            if (path === '/cancel-deletion') {
                                const tokens = request.query.getAll('token');
                                if (tokens.length !== 1 || tokens[0]!.length > 512)
                                    throw new AuthHttpError(400, 'A single token is required');
                                return pageResponse('Cancel account deletion', form(mount + path, csrf, hidden('token', tokens[0]!), 'Keep my account'), 200, headers);
                            }
                            if (path === '/verify' || path === '/reset') {
                                const tokens = request.query.getAll('token');
                                if (tokens.length !== 1 || tokens[0]!.length > 512)
                                    throw new AuthHttpError(400, 'A single token is required');
                                return pageResponse(path === '/verify' ? 'Verify email' : 'Choose a new password', form(mount + path, csrf, (path === '/verify' ? `<p>${tr("copy.confirmOnlyAnAccountYouCreatedVerificationConfirmsThisEmailAddressItDoesNotSetOrResetAPassword")}</p>` : '') + hidden('token', tokens[0]!) + (path === '/reset' ? formField('password', 'New password', 'password', 'new-password') : ''), path === '/verify' ? 'Verify email' : 'Reset password'), 200, headers);
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
                                    return pageResponse('Complete account enrollment', `<p role="status">${tr("copy.applicationAccessRemainsBlockedUntilAllRequiredEnrollmentStepsAreComplete")}</p><p>${escapeHtml(user.email)}</p>` + (needsEmail ? `<h2>${tr("copy.verifyYourEmailFirst")}</h2>` + (options.sendToken ? form(mount + '/send-verification', csrf, '', 'Send verification email') : `<p>${tr("copy.emailDeliveryIsUnavailableContactTheSiteOperator")}</p>`) : `<h2>${tr("copy.enrollAnAuthenticator")}</h2>` + form(mount + '/totp/begin', csrf, '', 'Set up authenticator') + (service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys ? `<p><a href="${escapeHtml(mount+'/second-factors')}">${escapeHtml(text('Set up a passkey second factor'))}</a></p>` : '')) + `<p><a href="${escapeHtml(mount + '/step-up')}">${tr("page.stepUp")}</a> ${tr("copy.ifYourRecentSignInHasExpired")}</p>` + form(mount + '/logout', csrf, '', 'Sign out'), 200, headers);
                                }
                                if (current.principal.impersonatorId)
                                    return pageResponse('Support impersonation', navigation + `<p role="alert">${tr("copy.youAreViewingThisAccountAsASupportAdministratorAccountSecurityChangesAreDisabledEndImpersonationToSignInAsYour")}</p>` + form(mount + '/logout', csrf, '', 'End impersonation'), 200, headers);
                                const section = (heading: string, content: string, danger = false) => `<section class="ui-card ui-section${danger ? ' ui-danger-zone' : ''}"><h2>${escapeHtml(text(heading))}</h2>${content}</section>`;
                                const overview = `<section class="ui-card ui-section"><div class="ui-toolbar"><div><p class="ui-muted">${tr('page.account')}</p><p class="ui-identifier">${escapeHtml(user.email)}</p></div>${form(mount + '/logout', csrf, '', 'Sign out')}</div><p>${tr('message.accountState', { email: presentation.text(user.emailVerified ? 'state.verified' : 'state.unverified'), authenticator: presentation.text(user.totpEnabled ? 'state.enabled' : 'state.disabled') })}</p>${options.sendToken && !user.emailVerified ? form(mount + '/send-verification', csrf, '', 'Send verification email') : ''}</section>`;
                                const profile = section('Profile', form(mount + '/profile', csrf, profileFields(), 'Update profile'));
                                const password = section('Password', form(mount + '/change-password', csrf, formField('currentPassword', 'Current password', 'password', 'current-password') + formField('password', 'New password', 'password', 'new-password') + factors(), 'Change password and sign out all sessions'));
                                const authenticator = section('Authenticator', user.totpEnabled ? `<details class="ui-disclosure"><summary>${tr('ux.disableAuthenticator')}</summary>` + form(mount + '/totp/disable', csrf, formField('password', 'Password (if configured)', 'password', 'current-password', false) + formField('code', 'Authenticator code', 'text', 'one-time-code', false) + (service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys ? secondFactorButton(mount,text) : ''), 'Disable authenticator') + '</details>' : form(mount + '/totp/begin', csrf, '', 'Set up authenticator'));
                                const email = options.sendToken ? section('Email address', form(mount + '/change-email', csrf, formField('email', 'New email address', 'email', 'email') + formField('password', 'Current password (if configured)', 'password', 'current-password', false) + factors(), 'Request email change (24-hour cooling period)')) : '';
                                const methods = passkeyButton('register', text) + flows.buttons(csrf, true, text, presentation.locale, presentation);
                                const data = section('Account data', form(mount + '/export', csrf, '', 'Export account data'));
                                const deletion = options.sendToken ? section('Delete account', form(mount + '/delete', csrf, `<p>${tr('message.deletionGrace', { days: service.getSecurityPolicy().deletionGraceMs / 86400000 })}</p>` + formField('confirmation', 'Type DELETE to confirm') + formField('password', 'Password (if configured)', 'password', 'current-password', false) + factors(), 'Schedule account deletion'), true) : '';
                                return pageResponse('Your account', navigation + overview + `<div class="ui-settings-grid">${profile}${password}${authenticator}${email}${methods ? section('Sign-in methods', methods) : ''}${data}${deletion}</div>`, 200, headers, options.passkeys ? mount + '/assets/passkeys.js' : undefined);
                            }
                            if(path==='/second-factors') {
                                if(!service.getSecurityPolicy().allowPasskeySecondFactor || !options.passkeys)throw new AuthHttpError(404,'Not found');
                                const keys=await service.listPasskeys(current.principal.id);
                                const passkeys=keys.map(key=>({id:key.id,secondFactor:key.secondFactor===true}));
                                if(wantsJson(request))return jsonResponse(200,{passkeys,csrf},headers);
                                return pageResponse('Second factors',navigation+csrfField(csrf)+`<p>${escapeHtml(text('A second-factor passkey must be different from the passkey used for primary sign-in.'))}</p>`+passkeyButton('register',text)+passkeys.map(key=>`<section class="ui-card ui-section"><h2>${escapeHtml(key.id)}</h2><p>${escapeHtml(text(key.secondFactor?'Enabled':'Disabled'))}</p>`+form(mount+'/passkeys/second-factor',csrf,hidden('credentialId',key.id)+hidden('enabled',key.secondFactor?'false':'true')+(key.secondFactor?'':secondFactorButton(mount,text)),key.secondFactor?'Disable passkey second factor':'Enable passkey second factor')+'</section>').join(''),200,headers,mount+'/assets/passkeys.js');
                            }
                            if(path==='/trusted-devices') {
                                if(!service.getSecurityPolicy().trustedDeviceTtlMs)throw new AuthHttpError(404,'Not found');
                                const devices=await service.listTrustedDevices(current.token);
                                if(wantsJson(request))return jsonResponse(200,{devices,csrf},headers);
                                return pageResponse('Remembered devices',navigation+`<p>${escapeHtml(text('Remembering a device requires a real second factor. Sensitive actions still require fresh verification.'))}</p>`+form(mount+'/trusted-devices/remember',csrf,formField('label','Device label','text','off',false),'Remember this device')+devices.map(device=>`<section class="ui-card ui-section"><h2>${escapeHtml(device.label)}</h2><p>${escapeHtml(new Date(device.expires).toISOString())}</p>`+form(mount+'/trusted-devices/revoke',csrf,hidden('deviceId',device.id),'Forget device')+'</section>').join(''),200,headers);
                            }
                            if (path === '/sessions') {
                                const sessions = await service.listSessions(current.principal.id);
                                if (wantsJson(request))
                                    return jsonResponse(200, { sessions, csrf }, headers);
                                return pageResponse('Your sessions', navigation + `<ul class="ui-card-list">${sessions.map(session => `<li class="ui-card ui-section">${tr('message.sessionStarted', { created: new Date(session.created).toISOString(), expires: new Date(session.expires).toISOString() })}${form(mount + '/revoke-session', csrf, hidden('sessionId', session.id), 'Revoke this session')}</li>`).join('')}</ul>` + form(mount + '/revoke-sessions', csrf, '', 'Sign out all sessions'), 200, headers);
                            }
                            if (path === '/methods') {
                                const methods = await service.exportAccount(current.token);
                                if (wantsJson(request))
                                    return jsonResponse(200, { passkeys: methods.passkeys, identities: methods.identities, csrf }, headers);
                                return pageResponse('Sign-in methods', navigation + `<h2>${tr("copy.passkeys")}</h2>` + methods.passkeys.map(key => form(mount + '/passkeys/remove', csrf, hidden('credentialId', key.id) + `<p>${escapeHtml(key.id)}</p>`, 'Remove passkey')).join('') + `<h2>${tr("copy.linkedProviders")}</h2>` + methods.identities.map(identity => form(mount + '/providers/unlink', csrf, hidden('provider', identity.provider) + hidden('subject', identity.subject) + `<p>${escapeHtml(identity.provider)}: ${escapeHtml(identity.subject)}</p>`, 'Unlink provider')).join('') + `<p>${tr("copy.theLastSignInMethodCannotBeRemoved")}</p>`, 200, headers);
                            }
                            if (path === '/step-up')
                                return pageResponse('Confirm your identity', navigation + form(mount + '/step-up', csrf, formField('password', 'Password', 'password', 'current-password') + factors(), 'Confirm identity') + passkeyButton('step-up', text), 200, headers, options.passkeys ? mount + '/assets/passkeys.js' : undefined);
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
                            if (path === '/register' && registrationMode === 'waitlist') {
                                await service.requestRegistration({ email: fields.email || '', password: fields.password || '', profile: profileInput(fields) });
                                return jsonResponse(202, { message: presentation.textSource('Registration request received.') });
                            }
                            const device = http.device(request);
                            const result = path === '/register' ? await service.register({ email: fields.email || '', password: fields.password || '', device: { id: device.id, label: device.label }, profile: profileInput(fields), ...(fields.invitationToken ? { invitationToken: fields.invitationToken } : {}) }) : await service.login({ ...trusted(request), email: fields.email || '', password: fields.password || '', device: { id: device.id, label: device.label }, ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...secondFactor });
                            if (result.newDevice)
                                await notice(result.user.email, 'new-device', noticeLocale(request,result.user));
                            return wantsJson(request) ? jsonResponse(path === '/register' ? 201 : 200, { user: result.user, csrf: http.token(result.token), ...(result.principal.restrictions ? { restrictions: result.principal.restrictions } : {}) }, [...http.sessionHeaders(result.token), ...device.headers]) : redirect(mount + '/account', [...http.sessionHeaders(result.token), ...device.headers]);
                        }
                        if (path === '/send-email-code') {
                            if (!options.sendEmailCode)
                                throw new AuthHttpError(404, 'Not found');
                            const email = fields.email || '', issued = await service.issueEmailCode({ email });
                            if (issued.code) {
                                const controller = new AbortController();
                                let timer: ReturnType<typeof setTimeout> | undefined;
                                try {
                                    await Promise.race([options.sendEmailCode({ email, flowId: issued.flowId, code: issued.code, locale:presentation.locale, signal: controller.signal }), new Promise<void>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, 5000); })]);
                                }
                                catch { }
                                finally {
                                    if (timer)
                                        clearTimeout(timer);
                                }
                            }
                            return wantsJson(request) ? jsonResponse(200, { message: presentation.textSource('If this account is eligible, a sign-in code will be sent.'), flowId: issued.flowId }) : pageResponse('Enter your email code', form(mount + '/email-code', fields.csrf || '', hidden('flowId', issued.flowId) + formField('code', 'Six-digit email code', 'text', 'one-time-code') + factors(), 'Sign in'));
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
                            return wantsJson(request) ? jsonResponse(200, { message: presentation.textSource('If this account is eligible, a reset message will be sent.') }) : pageResponse('Check your email', `<p role="status">${tr('ux.resetSent')}</p><p><a href="${escapeHtml(mount + '/login')}">${tr('ux.backSignIn')}</a></p>`);
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
                            await service.consumeVerification(fields.token || '');
                            if (service.getSecurityPolicy().requireEmailVerification)
                                return wantsJson(request) ? jsonResponse(200, { verified: true, signInRequired: true }, http.clearSession()) : redirect(mount + '/login', http.clearSession());
                            return completed({verified:true}, 'Email verified', 'Your email address has been verified.');
                        }
                        if (path === '/reset') {
                            const changed = await service.resetPassword({ token: fields.token || '', password: fields.password || '' });
                            await notice(changed.email, 'password-changed', noticeLocale(request, changed));
                            return wantsJson(request) ? jsonResponse(200, { reset: true }, http.clearSession()) : pageResponse('Password updated', `<p role="status">${tr('ux.passwordUpdated')}</p><a class="ui-button" href="${escapeHtml(mount + '/login')}">${tr('action.signIn')}</a>`, 200, http.clearSession());
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
                            const result = await service.stepUp({ token: current.token, password: fields.password || '', ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...secondFactor });
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
                            return pageResponse('Set up authenticator', `<p>${tr("copy.addThisKeyToYourAuthenticator")} <code>${escapeHtml(enrollment.secret)}</code></p>` + form(mount + '/totp/confirm', http.token(current.token), formField('code', 'Authenticator code', 'text', 'one-time-code'), 'Confirm authenticator'));
                        }
                        if (path === '/totp/confirm') {
                            const enrolled = await service.confirmTotp({ token: current.token, code: fields.code || '' });
                            return wantsJson(request) ? jsonResponse(200, enrolled) : pageResponse('Save your recovery codes', `<p>${tr("copy.storeTheseCodesSecurelyEachCanBeUsedOnce")}</p><ul>${enrolled.recoveryCodes.map(code => `<li><code>${escapeHtml(code)}</code></li>`).join('')}</ul><a href="${escapeHtml(mount + '/account')}">${tr("copy.continueToYourAccount")}</a>`);
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
                        return httpFailure(error, request, presentation, {href:mount + retryPath + '?lang=' + encodeURIComponent(presentation.locale),label:text('Try again')});
                    }
                },
            };
        } };
}
export type { AuthUser };
