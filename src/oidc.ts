import * as oidc from 'openid-client';
/** Secrets in this flow stay in encrypted, single-use server storage. */
export interface OidcFlow {
    state: string;
    nonce: string;
    verifier: string;
}
export interface OidcIdentity {
    issuer: string;
    subject: string;
    email?: string;
    emailVerified: boolean;
}
export interface OidcProviderOptions {
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** Trusted operator transport, useful for offline provider fixtures. */
    fetch?: typeof globalThis.fetch;
    scope?: 'openid email' | 'name email';
    responseMode?: 'query' | 'form_post';
    appleEmailClaim?: boolean;
}
export interface OidcProvider {
    start(): Promise<{
        url: string;
        flow: OidcFlow;
    }>;
    complete(callback: URL | Request, flow: OidcFlow): Promise<OidcIdentity>;
}
export async function createOidcProvider(options: OidcProviderOptions): Promise<OidcProvider> {
    const issuer = new URL(options.issuer), redirect = new URL(options.redirectUri);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash || issuer.search)
        throw new Error('OIDC issuer must be an operator-supplied HTTPS URL');
    if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash || redirect.search)
        throw new Error('OIDC callback must be a fixed HTTPS URL');
    if (!options.clientId || !options.clientSecret)
        throw new Error('OIDC client credentials are required');
    const transport: oidc.CustomFetch = async (url, init) => {
        const endpoint = new URL(String(url));
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password)
            throw new Error('OIDC endpoint must use HTTPS');
        const response = await (options.fetch ?? globalThis.fetch)(url, { ...init, body: init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body ?? null, redirect: 'error', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(10000)]) });
        if (response.status >= 300 && response.status < 400)
            throw new Error('OIDC redirects are not accepted');
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader)
            try {
                for (;;) {
                    const part = await reader.read();
                    if (part.done)
                        break;
                    size += part.value.byteLength;
                    if (size > 1048576)
                        throw new Error('OIDC response exceeds limit');
                    chunks.push(part.value);
                }
            }
            finally {
                await reader.cancel().catch(() => { });
                reader.releaseLock();
            }
        return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    };
    const config = await oidc.discovery(issuer, options.clientId, options.clientSecret, undefined, { [oidc.customFetch]: transport, timeout: 10, execute: [oidc.enableNonRepudiationChecks] });
    return {
        async start() { const flow = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier() }; const url = oidc.buildAuthorizationUrl(config, { redirect_uri: redirect.href, scope: options.scope ?? 'openid email', ...(options.responseMode ? { response_mode: options.responseMode } : {}), response_type: 'code', state: flow.state, nonce: flow.nonce, code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: 'S256' }); return { url: url.href, flow }; },
        async complete(callback, flow) {
            const url = callback instanceof URL ? callback : new URL(callback.url);
            if (url.origin !== redirect.origin || url.pathname !== redirect.pathname)
                throw new Error('OIDC callback mismatch');
            if (!flow || ![flow.state, flow.nonce, flow.verifier].every(value => typeof value === 'string' && value.length >= 32 && value.length <= 256))
                throw new Error('Invalid OIDC flow');
            const tokens = await oidc.authorizationCodeGrant(config, callback, { expectedState: flow.state, expectedNonce: flow.nonce, pkceCodeVerifier: flow.verifier, idTokenExpected: true });
            const claims = tokens.claims();
            if (!claims || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 1024)
                throw new Error('Invalid OIDC identity');
            return { issuer: config.serverMetadata().issuer, subject: claims.sub, ...(typeof claims.email === 'string' && claims.email.length <= 320 ? { email: claims.email } : {}), emailVerified: claims.email_verified === true || (options.appleEmailClaim === true && claims.email_verified === 'true') };
        }
    };
}
