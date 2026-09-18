import {renderDocument,field,escapeHtml} from '@jimhoyd/urlcode-ui';
export {escapeHtml} from '@jimhoyd/urlcode-ui';
import { addTurnstileWidgets, turnstileOrigin, turnstileScript } from './challenge-ui.ts';
import type { TurnstileWidget } from './challenge-ui.ts';
import { englishCatalogue } from './presentation.ts';
import type { PresentationContext } from './presentation.ts';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
export interface AuthHttpResponse {
    status: number;
    headers: [
        string,
        string
    ][];
    body: Uint8Array;
}
export class AuthHttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}
const encoder = new TextEncoder();
const securityHeaders: [
    string,
    string
][] = [['cache-control', 'no-store'], ['content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"], ['referrer-policy', 'strict-origin'], ['x-content-type-options', 'nosniff']];
export function jsonResponse(status: number, value: unknown, headers: [
    string,
    string
][] = []): AuthHttpResponse { return { status, headers: [...securityHeaders, ['content-type', 'application/json; charset=utf-8'], ...headers], body: encoder.encode(JSON.stringify(value)) }; }
/** Only trusted package code constructs markup. Project/user values must pass escapeHtml. */
export function pageResponse(title: string, markup: string, status = 200, headers: [
    string,
    string
][] = [], scriptPath?: string, presentation?: PresentationContext, turnstile?: TurnstileWidget, layout: 'default' | 'compact' | 'application' = 'default'): AuthHttpResponse {
    const titleKey = Object.entries(englishCatalogue).find(([key, value]) => key.startsWith('page.') && value === title)?.[0];
    title = presentation ? (titleKey ? presentation.text(titleKey) : presentation.textSource(title)) : title;
    const challenge = addTurnstileWidgets(markup, turnstile);
    markup = challenge.markup;
    const nonce = randomBytes(18).toString('base64');
    const scripts = [...(scriptPath ? [{src:scriptPath,nonce:nonce!}] : []), ...(challenge.enabled ? [{src:turnstileScript,nonce:nonce!,async:true}] : [])];
    const html = renderDocument({title,trustedContent:markup,layout,theme:{nonce},...(presentation?{presentation}:{}),scripts});
    return { status, headers: [...securityHeaders.map(([name, value]): [
                string,
                string
            ] => [name, name === 'content-security-policy' ? value + (presentation?.logo || presentation?.favicon ? "; img-src 'self'" : '') + (nonce ? `; script-src 'nonce-${nonce}'${challenge.enabled ? ' ' + turnstileOrigin : ''}` : '') + (challenge.enabled ? `; frame-src ${turnstileOrigin}; connect-src 'self' ${turnstileOrigin}` : '') : value]), ['content-type', 'text/html; charset=utf-8'], ...headers], body: encoder.encode(html) };
}
export function formField(name: string, label: string, type = 'text', autocomplete = 'off', required = true): string { return field({name,label,type,autocomplete,required}); }
export function csrfField(token: string): string { return `<input type="hidden" name="csrf" value="${escapeHtml(token)}">`; }
export function wantsJson(request: ExtensionRequest): boolean { return (request.headers.get('accept') || '').split(',').some(value => value.trim().split(';')[0] === 'application/json') || request.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json'; }
export function readFields(request: ExtensionRequest, allowed: string[]): Record<string, string> {
    if (request.body.byteLength > 16384)
        throw new AuthHttpError(413, 'Request body too large');
    let source: string;
    try {
        source = new TextDecoder('utf-8', { fatal: true }).decode(request.body);
    }
    catch {
        throw new AuthHttpError(400, 'Invalid request encoding');
    }
    const type = request.headers.get('content-type')?.split(';')[0]?.trim(), result: Record<string, string> = Object.create(null);
    let entries: [
        string,
        unknown
    ][];
    if (type === 'application/json') {
        let data: unknown;
        try {
            data = JSON.parse(source);
        }
        catch {
            throw new AuthHttpError(400, 'Invalid JSON body');
        }
        if (!data || typeof data !== 'object' || Array.isArray(data))
            throw new AuthHttpError(400, 'Expected an object');
        entries = Object.entries(data);
    }
    else if (type === 'application/x-www-form-urlencoded')
        entries = [...new URLSearchParams(source)];
    else
        throw new AuthHttpError(415, 'Use JSON or form data');
    if (entries.length > 64)
        throw new AuthHttpError(400, 'Too many fields');
    for (const [key, value] of entries) {
        if (![...allowed, 'csrf', 'challengeToken'].includes(key) || Object.hasOwn(result, key) || typeof value !== 'string' || value.length > (key === 'challengeToken' ? 2048 : 4096))
            throw new AuthHttpError(400, 'Invalid request field');
        result[key] = value;
    }
    return result;
}
export interface AuthHttpOptions {
    csrfKey: Uint8Array;
    origin: string;
}
export class AuthHttp {
    readonly origin: string;
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
        this.#key = Buffer.from(options.csrfKey);
    }
    cookie(request: ExtensionRequest, name: string): string | undefined {
        const raw = request.headers.get('cookie') || '';
        if (raw.length > 8192 || (request.headerCounts['cookie'] || 0) > 1)
            throw new AuthHttpError(400, 'Invalid cookies');
        const values = raw.split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
        if (values.length > 1)
            throw new AuthHttpError(400, 'Duplicate session cookie');
        const value = values[0]?.slice(name.length + 1);
        if (value !== undefined && !/^[A-Za-z0-9_-]{20,256}$/.test(value))
            throw new AuthHttpError(400, 'Invalid session cookie');
        return value;
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
    token(binding: string): string { return createHmac('sha256', this.#key).update('urlcode-csrf\0' + this.origin + '\0' + binding).digest('hex'); }
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
    verify(request: ExtensionRequest, fields: Record<string, string>): void {
        if (request.origin !== this.origin || request.headers.get('origin') !== this.origin || request.headers.get('sec-fetch-site') === 'cross-site')
            throw new AuthHttpError(403, 'Same-origin request required');
        if ((request.headerCounts['origin'] || 0) > 1 || (request.headerCounts['x-csrf-token'] || 0) > 1)
            throw new AuthHttpError(403, 'Invalid CSRF token');
        const binding = this.session(request) || this.cookie(request, this.flowCookie), provided = request.headers.get('x-csrf-token') || fields.csrf;
        if (!binding || !provided || !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(this.token(binding), 'hex'), Buffer.from(provided, 'hex')))
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
export function httpFailure(error: unknown, request: ExtensionRequest, presentation?: PresentationContext, recovery?: {href:string;label:string}): AuthHttpResponse {
    const known = error instanceof AuthHttpError || (error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500);
    const status = known ? (error as Error & {
        status: number;
    }).status : 500;
    const source = error instanceof AuthHttpError ? error.message : status >= 500 ? 'Service unavailable' : 'Request could not be completed';
    const message = presentation?.textSource(source) ?? source;
    return wantsJson(request) ? jsonResponse(status, { error: message }) : pageResponse('Request could not be completed', `<p class="error" role="alert">${escapeHtml(presentation?.textSource(message) ?? message)}</p>${recovery ? `<p><a class="ui-button" href="${escapeHtml(recovery.href)}">${escapeHtml(recovery.label)}</a></p>` : ''}`, status, [], undefined, presentation, undefined, 'compact');
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
