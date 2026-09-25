import {escapeHtml,Markup} from '@jimhoyd/urlcode-ui';
import type {ViewModel} from '@jimhoyd/urlcode-ui';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';
import { signHmac, verifyHmac } from '@jimhoyd/urlcode-ui/host';
import type { AbuseChallengeWidget } from '@jimhoyd/urlcode-abuse';
import { authTemplates } from './auth-templates.ts';
import { AuthError } from './auth-store.ts';
import { englishCatalogue } from './presentation.ts';
import type { PresentationContext } from './presentation.ts';
import { randomBytes } from 'node:crypto';
import { ExtensionHttpError, isSameOriginRequest, jsonResponse, readBody, readCookie, readFields, wantsJson } from '@jimhoyd/urlcode/extensions';
import type { ExtensionRequest, HandlerResult } from '@jimhoyd/urlcode/extensions';
export type AuthHttpResponse = HandlerResult;
/** A refusal whose message is shown to the client; `headers` (a Retry-After) go on the response. */
export class AuthHttpError extends Error {
    readonly status: number;
    readonly headers: readonly [string, string][];
    constructor(status: number, message: string, headers: readonly [string, string][] = []) { super(message); this.status = status; this.headers = headers; }
}
/** One account screen: an `auth/*` template name and the view model the extension computed for it. */
export interface Screen { name: string; view: ViewModel }
export interface ScreenOptions {
    status?: number | undefined;
    headers?: [string, string][] | undefined;
    /** A same-origin script the screen needs (the passkey glue); the kit binds it to the page nonce. */
    scriptPath?: string | undefined;
    presentation?: PresentationContext | undefined;
    /** The abuse extension's challenge widget, placed in every POST form of the screen. */
    challenge?: AbuseChallengeWidget | undefined;
    /** A notice shown above the screen (a support session). */
    flash?: { kind: 'error' | 'warning' | 'success' | 'info'; message: string } | undefined;
    layout?: 'default' | 'compact' | 'application' | undefined;
    /** The kit every account screen renders through; `authExtension` refuses activation without it. */
    ui: UiExtension;
}
/** Test hook: sees every screen before it renders. */
export const screenObserver: { current?: ((screen: Screen) => void) | undefined } = {};
function pageTitle(title: string, presentation?: PresentationContext): string {
    const titleKey = Object.entries(englishCatalogue).find(([key, value]) => key.startsWith('page.') && value === title)?.[0];
    return presentation ? (titleKey ? presentation.text(titleKey) : presentation.textSource(title)) : title;
}
/** Places the challenge widget's trusted markup at the start of each POST form (at most 16). */
function insertChallenge(markup: string, widget: AbuseChallengeWidget | undefined): { markup: string; enabled: boolean } {
    if (!widget)
        return { markup, enabled: false };
    let count = 0;
    const result = markup.replace(/<form\b([^>]*)>/gi, (tag, attributes: string) => {
        if (!/(?:^|\s)method=(?:"post"|'post')(?=\s|$)/i.test(attributes))
            return tag;
        if (++count > 16)
            throw new Error('Too many challenge forms');
        return tag + widget.markup;
    });
    return { markup: result, enabled: count > 0 };
}
/** Renders a screen through `ui.kit`, the only render path; activation already refused a missing or inactive `ui`. */
export function screenResponse(title: string, screen: Screen, options: ScreenOptions): AuthHttpResponse {
    if (!Object.hasOwn(authTemplates, screen.name)) throw new Error(`Unknown auth screen: ${screen.name.slice(0, 64)}`);
    const kit = options.ui.kit;
    screenObserver.current?.(screen);
    const context = options.presentation ?? kit.resolveContext();
    const challenge = insertChallenge(kit.render(screen.name, screen.view, context).html, options.challenge);
    const scripts = [...(options.scriptPath ? [{ src: options.scriptPath }] : []), ...(challenge.enabled ? options.challenge!.scripts.map(script => ({ src: script.src, async: script.async })) : [])];
    return kit.wrap(new Markup(challenge.markup), { title: pageTitle(title, context), context, ...(options.layout ? {layout: options.layout} : {}), ...(options.status !== undefined ? { status: options.status } : {}), ...(options.headers ? { headers: options.headers } : {}), ...(scripts.length ? { scripts } : {}), ...(challenge.enabled ? { csp: { script: [...options.challenge!.csp.script], frame: [...options.challenge!.csp.frame], connect: [...options.challenge!.csp.connect] } } : {}), ...(options.flash ? { flash: options.flash } : {}) });
}
/** Auth's form fields: the listed names plus `csrf` and a challenge token, each at most 4096 (the token 2048) characters. */
export function readAuthFields(request: ExtensionRequest, allowed: readonly string[]): Record<string, string> {
    return { ...readFields(request, { fields: [...allowed, 'csrf', 'challengeToken'], limits: { challengeToken: 2048 } }) };
}
/** The body's `csrf` field for a route write that sent no header; anything unreadable asks for the header instead. */
function bodyToken(request: ExtensionRequest): string | undefined {
    let body: ReturnType<typeof readBody>;
    try { body = readBody(request, { accept: ['form', 'json'], maxBytes: 16384 }); }
    catch { throw new AuthHttpError(403, 'Send the CSRF token in the x-csrf-token header'); }
    if (body.kind === 'form') {
        const values = body.entries.filter(([name]) => name === 'csrf');
        if (values.length > 1)
            throw new AuthHttpError(403, 'Invalid CSRF token');
        return values[0]?.[1];
    }
    const value = body.value as Record<string, unknown> | null;
    return value && typeof value === 'object' && !Array.isArray(value) && typeof value.csrf === 'string' ? value.csrf : undefined;
}
export interface AuthHttpOptions {
    csrfKey: Uint8Array;
    /** The canonical origin: CSRF tokens are bound to it and generated links use it. */
    origin: string;
    /** Every origin the site is served from, canonical first (the extension activation's `origins`); a same-origin mutation may carry any of them in `Origin`. Defaults to the canonical origin alone. */
    origins?: readonly string[] | undefined;
}
export class AuthHttp {
    readonly origin: string;
    readonly origins: readonly string[];
    readonly #key: Buffer;
    readonly #devices = new WeakMap<ExtensionRequest, {
        id: string;
        label: string;
        headers: [
            string,
            string
        ][];
    }>();
    readonly sessionCookie = '__Host-urlcode-session';
    readonly flowCookie = '__Host-urlcode-flow';
    constructor(options: AuthHttpOptions) {
        const origin = new URL(options.origin);
        if (origin.origin !== options.origin || origin.username || origin.password || !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))))
            throw new Error('Auth requires a canonical HTTPS origin (loopback HTTP development only)');
        if (options.csrfKey.byteLength < 32)
            throw new Error('Auth CSRF key requires at least 32 bytes');
        this.origin = options.origin;
        this.origins = Object.freeze([...(options.origins ?? [options.origin])]);
        if (this.origins[0] !== this.origin)
            throw new Error('Auth site origins must start with the canonical origin');
        this.#key = Buffer.from(options.csrfKey);
    }
    /** One of auth's cookies; a malformed value reads as absent (signed out), an ambiguous Cookie header is 400. */
    cookie(request: ExtensionRequest, name: string): string | undefined {
        return readCookie(request, name, /^[A-Za-z0-9_-]{20,256}$/);
    }
    device(request: ExtensionRequest): {
        id: string;
        label: string;
        headers: [
            string,
            string
        ][];
    } {
        const cached = this.#devices.get(request);
        if (cached)
            return cached;
        const existing = this.cookie(request, '__Host-urlcode-device');
        const value = { id: existing || randomBytes(32).toString('base64url'), label: (request.headers.get('user-agent') || 'Browser').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160), headers: [] as [
                string,
                string
            ][] };
        if (!existing)
            value.headers.push(['set-cookie', this.setCookie('__Host-urlcode-device', value.id, 31536000)]);
        this.#devices.set(request, value);
        return value;
    }
    session(request: ExtensionRequest): string | undefined { return this.cookie(request, this.sessionCookie); }
    token(binding: string): string { return signHmac(this.#key, 'urlcode-csrf\0' + this.origin + '\0' + binding, 'hex'); }
    prepare(request: ExtensionRequest): {
        csrf: string;
        headers: [
            string,
            string
        ][];
    } {
        const session = this.session(request), flow = this.cookie(request, this.flowCookie), binding = session || flow || randomBytes(32).toString('base64url');
        return { csrf: this.token(binding), headers: [...(session || flow ? [] : [['set-cookie', this.setCookie(this.flowCookie, binding, 900)] as [
                        string,
                        string
                    ]]), ...this.device(request).headers] };
    }
    /** Same-origin admission for every write: the canonical origin, then core's one rule with no provenance refused. */
    admit(request: ExtensionRequest): void {
        if (request.origin !== this.origin || !isSameOriginRequest(request, this, { whenAbsent: 'refuse' }))
            throw new AuthHttpError(403, 'Same-origin request required');
    }
    /** A write to auth's own mount: admission, then the session- or flow-bound token from the header or the read `csrf` field. */
    verify(request: ExtensionRequest, fields: Record<string, string>): void {
        this.admit(request);
        if ((request.headerCounts['x-csrf-token'] || 0) > 1)
            throw new AuthHttpError(403, 'Invalid CSRF token');
        this.#check(request, request.headers.get('x-csrf-token') || fields.csrf);
    }
    /**
     * A write to a route an auth session policy protects (jimhoyd-com/urlcode#745). `origin` is admission alone, for a
     * mount that verifies its own token or accepts JSON only. `token` also needs the session-bound token: the single
     * `x-csrf-token` header, or only when that is absent the body's `csrf` field (one form entry, or a top-level JSON
     * string), read from at most 16384 bytes of form or JSON without consuming the body the route reads next.
     */
    verifyWrite(request: ExtensionRequest, csrf: 'token' | 'origin'): void {
        this.admit(request);
        if (csrf === 'origin')
            return;
        if ((request.headerCounts['x-csrf-token'] || 0) > 1)
            throw new AuthHttpError(403, 'Invalid CSRF token');
        this.#check(request, request.headers.get('x-csrf-token') ?? bodyToken(request));
    }
    #check(request: ExtensionRequest, provided: string | undefined): void {
        const binding = this.session(request) || this.cookie(request, this.flowCookie);
        if (!binding || !provided || !/^[a-f0-9]{64}$/.test(provided) || !verifyHmac(this.#key, 'urlcode-csrf\0' + this.origin + '\0' + binding, provided, 'hex'))
            throw new AuthHttpError(403, 'Invalid CSRF token');
    }
    setCookie(name: string, value: string, maxAge?: number): string { return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`; }
    sessionHeaders(token: string): [
        string,
        string
    ][] { return [['set-cookie', this.setCookie(this.sessionCookie, token)], ['set-cookie', this.setCookie(this.flowCookie, '', 0)]]; }
    clearSession(): [
        string,
        string
    ][] { return [['set-cookie', this.setCookie(this.sessionCookie, '', 0)]]; }
}
/**
 * The answer for a failed request. Only auth's own refusals, core's request-helper refusals and a project hook's denial
 * reason are shown as they are; any other 4xx reads 'Request could not be completed' and anything else is a 500.
 */
export function httpFailure(error: unknown, request: ExtensionRequest, presentation: PresentationContext | undefined, recovery: {href:string;label:string} | undefined, ui: UiExtension): AuthHttpResponse {
    const statusOf = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : 500;
    const known = error instanceof AuthHttpError || statusOf >= 400 && statusOf < 500 || error instanceof AuthError && statusOf === 503;
    const status = known ? statusOf : 500;
    const source = error instanceof AuthHttpError || error instanceof ExtensionHttpError ? error.message : error instanceof AuthError && error.reason ? error.reason : status >= 500 ? 'Service unavailable' : 'Request could not be completed';
    const message = presentation?.textSource(source) ?? source, headers = error instanceof AuthHttpError ? [...error.headers] : [];
    return wantsJson(request) ? jsonResponse(status, { error: message }, headers) : screenResponse('Request could not be completed', { name: 'auth/status', view: { alert: true, message, href: recovery?.href ?? null, label: recovery?.label ?? null } }, { status, headers, presentation, layout: 'compact', ui });
}
/** Proof token stays in the submitting form and is consumed once with the primary proof. */
export function secondFactorButton(base: string, text: (source: string) => string = value => value): string {
 return `<button type="button" data-passkey="second-factor" data-base="${escapeHtml(base)}" data-unavailable="${escapeHtml(text('Passkeys are unavailable in this browser. Use another sign-in method.'))}" data-failed="${escapeHtml(text('Passkey request failed'))}" data-cancelled="${escapeHtml(text('Passkey ceremony cancelled'))}" data-confirmed="${escapeHtml(text('Passkey confirmed. Continue signing in.'))}">${escapeHtml(text('Use a passkey as your second factor'))}</button><input type="hidden" name="secondFactorToken" value=""><p role="status" aria-live="polite" data-passkey-status></p>`;
}
/** Browser glue for maintained server-side WebAuthn verification. No guest scripts. */
export const passkeyScript = String.raw `(() => {
 const decode=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
 const encode=value=>{let text='';for(const byte of new Uint8Array(value))text+=String.fromCharCode(byte);return btoa(text).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
 for(const button of document.querySelectorAll('[data-passkey]'))button.addEventListener('click',async()=>{
  const form=button.closest('form'),status=form?.querySelector('[data-passkey-status]')||document.querySelector('[data-passkey-status]');button.disabled=true;
  try{
   if(!window.PublicKeyCredential||!navigator.credentials)throw new Error(button.dataset.unavailable);
   const base=button.dataset.base,kind=button.dataset.passkey,csrf=(form||document).querySelector('input[name="csrf"]').value;
   const post=async(path,data)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf,accept:'application/json'},body:JSON.stringify(data)});const result=await response.json();if(!response.ok)throw new Error(button.dataset.failed);return result;};
   const prefix=kind==='signup'?'/signup/passkeys':kind==='second-factor'?'/second-factor':'/passkeys/'+kind;
   const challengeToken=kind==='login'?form?.querySelector('input[name="challengeToken"]')?.value:undefined;
   const started=await post(prefix+'/options',challengeToken?{challengeToken}:{}),options=started.options;options.challenge=decode(options.challenge);
   if(options.user)options.user.id=decode(options.user.id);
   for(const item of options.excludeCredentials||options.allowCredentials||[])item.id=decode(item.id);
   const credential=(kind==='register'||kind==='signup')?await navigator.credentials.create({publicKey:options}):await navigator.credentials.get({publicKey:options});
   if(!credential)throw new Error(button.dataset.cancelled);
   const response={id:credential.id,rawId:encode(credential.rawId),type:credential.type,clientExtensionResults:credential.getClientExtensionResults(),response:{clientDataJSON:encode(credential.response.clientDataJSON)}};
   if(credential.authenticatorAttachment)response.authenticatorAttachment=credential.authenticatorAttachment;
   if(kind==='register'||kind==='signup'){response.response.attestationObject=encode(credential.response.attestationObject);response.response.transports=credential.response.getTransports?.()||[];}
   else {response.response.authenticatorData=encode(credential.response.authenticatorData);response.response.signature=encode(credential.response.signature);response.response.userHandle=credential.response.userHandle?encode(credential.response.userHandle):null;}
   const scope=form||document,totp=scope.querySelector('input[name="totp"]')?.value,recoveryCode=scope.querySelector('input[name="recoveryCode"]')?.value,secondFactorToken=scope.querySelector('input[name="secondFactorToken"]')?.value;
   const verified=await post(prefix+'/verify',{...(started.flowId?{flowId:started.flowId}:{}),response,...(kind!=='second-factor'&&totp?{totp}:{}),...(kind!=='second-factor'&&recoveryCode?{recoveryCode}:{}),...(kind!=='second-factor'&&secondFactorToken?{secondFactorToken}:{})});
   if(kind==='second-factor'){if(!form)throw new Error(button.dataset.failed);form.querySelector('input[name="secondFactorToken"]').value=verified.secondFactorToken;status.textContent=button.dataset.confirmed;return;}
   location.assign(base+(kind==='signup'?'/signup':'/account'));
  }catch(error){status.textContent=error instanceof Error&&[button.dataset.unavailable,button.dataset.failed,button.dataset.cancelled].includes(error.message)?error.message:button.dataset.failed;}finally{button.disabled=false;}
 });
})();`;
