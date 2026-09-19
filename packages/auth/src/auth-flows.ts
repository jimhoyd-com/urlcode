import { createSecondFactorFlows } from './second-factor-flows.ts';
import { createPresentation } from './presentation.ts';
import type { PresentationContext } from './presentation.ts';
import type { Presentation } from './presentation.ts';
import type { RegistrationInput } from './registration.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AuthService, AuthSessionResult } from './auth-core.ts';
import type { OidcProvider, OidcFlow } from './oidc.ts';
import type { PasskeyProvider } from './passkeys.ts';
import { AuthHttp, AuthHttpError, csrfField, escapeHtml, formField as baseField, jsonResponse, readFields, screenResponse, wantsJson, secondFactorButton } from './auth-ui.ts';
import type { AuthHttpResponse, UiHost } from './auth-ui.ts';
import { Markup } from '@jimhoyd/urlcode-ui';
export interface AuthFlowOptions {
    service: AuthService;
    presentation?: Presentation;
    ui?: UiHost;
    onSession?: (request: ExtensionRequest, result: AuthSessionResult) => Promise<[
        string,
        string
    ][]>;
    providers?: Record<string, OidcProvider>;
    passkeys?: PasskeyProvider;
    enrollment?: {
        required: boolean;
        fields: (presentation?: PresentationContext) => string;
        read: (fields: Record<string, string>) => RegistrationInput;
        names: string[];
    };
}
const trustedCookie = '__Host-urlcode-trusted-device';
const defaultPresentation = createPresentation();
const id = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AuthHttpError(400, 'Invalid authentication flow');
    return value as Record<string, unknown>;
}
function checkBinding(data: Record<string, unknown>, binding: string | undefined): void {
    const expected = typeof data.browserHash === 'string' ? data.browserHash : '';
    if (!binding || !/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash(binding), 'hex')))
        throw new AuthHttpError(403, 'Authentication flow belongs to another browser');
}
function complex(request: ExtensionRequest): Record<string, unknown> {
    if (request.body.byteLength > 16384)
        throw new AuthHttpError(413, 'Request body too large');
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
        throw new AuthHttpError(415, 'JSON required');
    try {
        return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)));
    }
    catch {
        throw new AuthHttpError(400, 'Invalid authentication payload');
    }
}
function fresh(authenticatedAt: number): void {
    if (Date.now() - authenticatedAt > 300000)
        throw new AuthHttpError(403, 'Confirm your identity first');
}
export function createAuthFlows(options: AuthFlowOptions, http: AuthHttp, mount: string, registration: boolean) {
    const service = options.service, providers = options.providers || {}, flowCookie = '__Host-urlcode-oidc';
    const secondFactors = createSecondFactorFlows(options, http, mount);
    const trusted = (request: ExtensionRequest) => { const token = service.getSecurityPolicy().trustedDeviceTtlMs ? http.cookie(request, trustedCookie) : undefined; return token ? { trustedDevice: token } : {}; };
    if (Object.keys(providers).length > 16 || Object.keys(providers).some(name => !/^[a-z][a-z0-9-]{0,31}$/.test(name)))
        throw new Error('Invalid provider names');
    const cookie = (value: string, maxAge = 600): [
        string,
        string
    ] => ['set-cookie', `${flowCookie}=${value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${maxAge}`];
    const finish = async (request: ExtensionRequest, result: AuthSessionResult): Promise<AuthHttpResponse> => { const headers = options.onSession ? await options.onSession(request, result) : []; return wantsJson(request) ? jsonResponse(200, { user: result.user, csrf: http.token(result.token), ...(result.principal.restrictions ? { restrictions: result.principal.restrictions } : {}) }, [...http.sessionHeaders(result.token), cookie('', 0), ...headers]) : jsonResponse(303, { redirect: mount + '/account' }, [['location', mount + '/account'], ...http.sessionHeaders(result.token), cookie('', 0), ...headers]); };
    return {
        buttons(csrf: string, link = false, _text: (value: string) => string = value => value, locale?: string, presentation?: PresentationContext): string { return Object.keys(providers).map(name => `<form method="post" action="${escapeHtml(mount + '/providers/' + name + (link ? '/link' : '/start') + (locale ? '?lang=' + encodeURIComponent(locale) : ''))}">${csrfField(csrf)}<button type="submit">${escapeHtml((presentation ?? defaultPresentation.resolve()).text(link ? 'provider.link' : 'provider.signIn', { provider: name }))}</button></form>`).join(''); },
        async handle(request: ExtensionRequest): Promise<AuthHttpResponse | undefined> {
            let presentation = (options.presentation ?? defaultPresentation).resolve({ ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(request.headers.get('accept-language') ? { acceptLanguage: request.headers.get('accept-language')! } : {}) });
            const tr = (key: string, values?: Readonly<Record<string, string | number>>) => escapeHtml(presentation.text(key, values));
            const formScreen = (title: string, name: string, form: string, headers: [string, string][], scriptPath?: string) => screenResponse(title, { name: 'auth/' + name, view: { form: new Markup(form) } }, { status: 200, headers, scriptPath, presentation, layout: 'compact', ui: options.ui });
            const formField = (name: string, label: string, type = 'text', autocomplete = 'off', required = true) => baseField(name, presentation?.textSource(label) ?? label, type, autocomplete, required);
            const path = request.path.slice(mount.length), match = /^\/providers\/([a-z][a-z0-9-]{0,31})\/(start|link|callback)$/.exec(path);
            if (match) {
                const name = match[1]!, operation = match[2]!, provider = providers[name];
                if (!provider)
                    throw new AuthHttpError(404, 'Not found');
                if (operation !== 'callback') {
                    if (request.method !== 'POST')
                        throw new AuthHttpError(405, 'POST required');
                    const fields = readFields(request, []);
                    http.verify(request, fields);
                    let actorToken: string | undefined;
                    if (operation === 'link') {
                        actorToken = http.session(request);
                        const actor = actorToken ? await service.authenticate(actorToken) : null;
                        if (!actor)
                            throw new AuthHttpError(401, 'Sign in required');
                        fresh(actor.authenticatedAt);
                    }
                    const started = await provider.start(), browser = id(), destination = new URL(started.url);
                    if (destination.protocol !== 'https:' || destination.username || destination.password)
                        throw new AuthHttpError(502, 'Invalid provider response');
                    await service.putFlow({ id: started.flow.state, kind: 'oidc', expires: Date.now() + 600000, data: { name, locale: presentation.locale, flow: started.flow, browserHash: hash(browser), ...(actorToken ? { actorToken } : {}) } });
                    return jsonResponse(303, { redirect: destination.href }, [['location', destination.href], cookie(browser)]);
                }
                if (!['GET', 'POST'].includes(request.method))
                    throw new AuthHttpError(405, 'GET or POST required');
                if (request.body.byteLength > 16384)
                    throw new AuthHttpError(413, 'Request body too large');
                const callback = new URL(request.target, http.origin), parameters = request.method === 'POST' ? new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(request.body)) : callback.searchParams;
                if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded')
                    throw new AuthHttpError(415, 'Form callback required');
                const states = parameters.getAll('state');
                if (states.length !== 1 || states[0]!.length > 256)
                    throw new AuthHttpError(400, 'Invalid provider state');
                const data = record(await service.consumeFlow(states[0]!, 'oidc'));
                if (typeof data.locale === 'string')
                    presentation = (options.presentation ?? defaultPresentation).resolve({ queryLocale: data.locale });
                checkBinding(data, http.cookie(request, flowCookie));
                if (data.name !== name)
                    throw new AuthHttpError(400, 'Provider flow mismatch');
                const identity = await provider.complete(request.method === 'POST' ? new Request(callback, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new Uint8Array(request.body).buffer }) : callback, data.flow as OidcFlow);
                let issuer: URL;
                try {
                    issuer = new URL(identity.issuer);
                }
                catch {
                    throw new AuthHttpError(401, 'Invalid identity issuer');
                }
                if (issuer.protocol !== 'https:' || issuer.username || issuer.password || identity.issuer.length > 2048)
                    throw new AuthHttpError(401, 'Invalid identity issuer');
                const identityProvider = 'oidc-' + createHash('sha256').update(identity.issuer).digest('hex').slice(0, 56);
                if (typeof data.actorToken === 'string') {
                    await service.linkExternal({ actorToken: data.actorToken, provider: identityProvider, subject: identity.subject });
                    return jsonResponse(303, { linked: true }, [['location', mount + '/account'], cookie('', 0), ...http.sessionHeaders(data.actorToken)]);
                }
                let externalProof = await service.getExternalProof(identityProvider, identity.subject), user = externalProof?.user;
                if (user?.profile?.locale)
                    presentation = (options.presentation ?? defaultPresentation).resolve({ accountLocale: user.profile.locale, queryLocale: presentation.locale });
                if (!user) {
                    if (!registration || !identity.email || !identity.emailVerified)
                        throw new AuthHttpError(403, 'An existing linked account is required');
                    if (options.enrollment?.required) {
                        const enrollment = id();
                        await service.putFlow({ id: enrollment, kind: 'oidc-enrollment', expires: Date.now() + 600000, data: { email: identity.email, provider: identityProvider, subject: identity.subject, browserHash: data.browserHash, locale: presentation.locale } });
                        const browser = http.prepare(request);
                        return formScreen('Complete your account', 'provider-enroll', `<form method="post" action="${escapeHtml(mount + '/providers/enroll?lang=' + encodeURIComponent(presentation.locale))}">${csrfField(browser.csrf)}<input type="hidden" name="flowId" value="${escapeHtml(enrollment)}">${options.enrollment.fields(presentation)}<button type="submit">${tr("action.register")}</button></form>`, browser.headers);
                    }
                    user = await service.createExternalAccount({ email: identity.email, emailVerified: true, provider: identityProvider, subject: identity.subject });
                    externalProof = await service.getExternalProof(identityProvider, identity.subject);
                }
                if (!externalProof || externalProof.user.id !== user.id)
                    throw new AuthHttpError(401, 'Identity changed during sign in');
                if (user.totpEnabled || user.passkeyMfaEnabled) {
                    const extraHeaders: [string,string][] = [];
                    if(trusted(request).trustedDevice) {
                        try { return finish(request, await service.issueSession(user.id, {device:http.device(request),...trusted(request),method:'oidc',proof:externalProof.proof})); }
                        catch(error) {
                            if(!(error instanceof Error) || !('code' in error) || error.code!=='invalid_trusted_device')throw error;
                            extraHeaders.push(['set-cookie',http.setCookie(trustedCookie,'',0)]);
                        }
                    }
                    const pending = id();
                    await service.putFlow({ id: pending, kind: 'oidc-mfa', expires: Date.now() + 300000, data: { accountId: user.id, proof: externalProof.proof, browserHash: data.browserHash, locale: presentation.locale } });
                    const browser = http.prepare(request);
                    return formScreen('Confirm second factor', 'provider-second-factor', `<form method="post" action="${escapeHtml(mount + '/providers/complete?lang=' + encodeURIComponent(presentation.locale))}">${csrfField(browser.csrf)}<input type="hidden" name="flowId" value="${escapeHtml(pending)}">${formField('totp', 'Authenticator code', 'text', 'one-time-code', false)}${formField('recoveryCode', 'Recovery code (instead of authenticator code)', 'text', 'off', false)}${service.getSecurityPolicy().allowPasskeySecondFactor && options.passkeys ? secondFactorButton(mount, value => presentation.textSource(value)) : ''}<button type="submit">${tr("action.completeSignIn")}</button></form>`, [...browser.headers,...extraHeaders], options.passkeys ? mount + '/assets/passkeys.js' : undefined);
                }
                return finish(request, await service.issueSession(user.id, { device: http.device(request), ...trusted(request), method: 'oidc', proof: externalProof.proof }));
            }
            if (path === '/providers/enroll') {
                if (request.method !== 'POST' || !registration || !options.enrollment)
                    throw new AuthHttpError(404, 'Not found');
                const fields = readFields(request, ['flowId', ...options.enrollment.names]);
                http.verify(request, fields);
                const data = record(await service.consumeFlow(fields.flowId || '', 'oidc-enrollment'));
                checkBinding(data, http.cookie(request, flowCookie));
                if (typeof data.email !== 'string' || typeof data.provider !== 'string' || typeof data.subject !== 'string')
                    throw new AuthHttpError(400, 'Invalid enrollment');
                const user = await service.createExternalAccount({ email: data.email, emailVerified: true, provider: data.provider, subject: data.subject, profile: options.enrollment.read(fields) });
                const externalProof = await service.getExternalProof(data.provider, data.subject);
                if (!externalProof || externalProof.user.id !== user.id)
                    throw new AuthHttpError(401, 'Identity changed during enrollment');
                return finish(request, await service.issueSession(user.id, { device: http.device(request), ...trusted(request), method: 'oidc', proof: externalProof.proof }));
            }
            if (path === '/providers/complete') {
                if (request.method !== 'POST')
                    throw new AuthHttpError(405, 'POST required');
                const fields = readFields(request, ['flowId', 'totp', 'recoveryCode', 'secondFactorToken']);
                http.verify(request, fields);
                const data = record(await service.consumeFlow(fields.flowId || '', 'oidc-mfa'));
                checkBinding(data, http.cookie(request, flowCookie));
                if (typeof data.accountId !== 'string')
                    throw new AuthHttpError(400, 'Invalid authentication flow');
                return finish(request, await service.issueSession(data.accountId, { device: http.device(request), method: 'oidc', proof: record(data.proof) as unknown as NonNullable<Parameters<AuthService['issueSession']>[1]['proof']>, ...(fields.totp ? { totp: fields.totp } : {}), ...(fields.recoveryCode ? { recoveryCode: fields.recoveryCode } : {}), ...(fields.secondFactorToken ? { secondFactor: secondFactors.proof(request, fields.secondFactorToken) } : {}), ...trusted(request) }));
            }
            const ceremony = /^\/passkeys\/(register|login|step-up)\/(options|verify)$/.exec(path);
            if (!ceremony)
                return undefined;
            if (!options.passkeys)
                throw new AuthHttpError(404, 'Not found');
            if (request.method !== 'POST')
                throw new AuthHttpError(405, 'POST required');
            const body = complex(request);
            if (Object.keys(body).some(key => !['csrf', 'flowId', 'response', 'totp', 'recoveryCode', 'secondFactorToken'].includes(key)))
                throw new AuthHttpError(400, 'Unknown authentication field');
            http.verify(request, typeof body.csrf === 'string' ? { csrf: body.csrf } : {});
            const session = http.session(request), binding = session || http.cookie(request, http.flowCookie);
            if (!binding)
                throw new AuthHttpError(403, 'Browser flow required');
            const kind = ceremony[1]!, phase = ceremony[2]!, actor = session ? await service.authenticate(session) : null;
            if (kind === 'step-up' && (!session || !actor || actor.impersonatorId))
                throw new AuthHttpError(401, 'Sign in required');
            if (kind === 'register') {
                if (!session || !actor)
                    throw new AuthHttpError(401, 'Sign in required');
                fresh(actor.authenticatedAt);
            }
            if (phase === 'options') {
                const generated = kind === 'register' ? await options.passkeys.beginRegistration({ id: actor!.id, email: actor!.email }, await service.listPasskeys(actor!.id)) : await options.passkeys.beginAuthentication();
                const flowId = id();
                await service.putFlow({ id: flowId, kind: 'passkey-' + kind, expires: Date.now() + 300000, data: { challenge: generated.challenge, browserHash: hash(binding), ...(actor ? { accountId: actor.id } : {}) } });
                return jsonResponse(200, { options: generated, flowId });
            }
            if (typeof body.flowId !== 'string')
                throw new AuthHttpError(400, 'Flow ID required');
            const data = record(await service.consumeFlow(body.flowId, 'passkey-' + kind));
            checkBinding(data, binding);
            if (typeof data.challenge !== 'string')
                throw new AuthHttpError(400, 'Invalid challenge');
            const response = record(body.response);
            if (typeof response.id !== 'string')
                throw new AuthHttpError(400, 'Invalid credential');
            if (kind === 'register') {
                if (data.accountId !== actor!.id)
                    throw new AuthHttpError(403, 'Account changed during ceremony');
                const credential = await options.passkeys.verifyRegistration(response as unknown as RegistrationResponseJSON, data.challenge);
                await service.addPasskey({ actorToken: session!, credential });
                return jsonResponse(200, { registered: true });
            }
            const stored = await service.getPasskey(response.id);
            if (!stored)
                throw new AuthHttpError(401, 'Passkey authentication failed');
            if (kind === 'step-up' && (stored.accountId !== actor!.id || data.accountId !== actor!.id))
                throw new AuthHttpError(403, 'Passkey belongs to another account');
            const verified = await options.passkeys.verifyAuthentication(response as unknown as AuthenticationResponseJSON, data.challenge, stored.credential);
            const proof = { ...stored.proof, newCounter: verified.counter };
            if (body.secondFactorToken !== undefined && typeof body.secondFactorToken !== 'string') throw new AuthHttpError(400, 'Invalid second-factor proof');
            if (body.totp !== undefined && typeof body.totp !== 'string' || body.recoveryCode !== undefined && typeof body.recoveryCode !== 'string')
                throw new AuthHttpError(400, 'Invalid second factor');
            if (kind === 'step-up')
                return finish(request, await service.completeStepUp({ token: session!, accountId: stored.accountId, method: 'passkey', proof, ...(typeof body.totp === 'string' && body.totp ? { totp: body.totp } : {}), ...(typeof body.recoveryCode === 'string' && body.recoveryCode ? { recoveryCode: body.recoveryCode } : {}), ...(typeof body.secondFactorToken === 'string' && body.secondFactorToken ? { secondFactor: secondFactors.proof(request, body.secondFactorToken) } : {}) }));
            return finish(request, await service.issueSession(stored.accountId, { device: http.device(request), ...trusted(request), method: 'passkey', proof, ...(typeof body.totp === 'string' && body.totp ? { totp: body.totp } : {}), ...(typeof body.recoveryCode === 'string' && body.recoveryCode ? { recoveryCode: body.recoveryCode } : {}), ...(typeof body.secondFactorToken === 'string' && body.secondFactorToken ? { secondFactor: secondFactors.proof(request, body.secondFactorToken) } : {}) }));
        },
    };
}
