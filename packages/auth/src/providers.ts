import { SignJWT, importPKCS8 } from 'jose';
import { createOidcProvider } from './oidc.ts';
import type { OidcProvider, OidcProviderOptions } from './oidc.ts';
export type GoogleProviderOptions = Pick<OidcProviderOptions, 'clientId' | 'clientSecret' | 'redirectUri' | 'fetch'>;
export function createGoogleProvider(options: GoogleProviderOptions): Promise<OidcProvider> { return createOidcProvider({ ...options, issuer: 'https://accounts.google.com' }); }
export interface AppleProviderOptions {
    teamId: string;
    keyId: string;
    clientId: string;
    privateKey: string;
    redirectUri: string;
    fetch?: typeof globalThis.fetch;
}
/** Operator-owned signing key; no Apple key or client secret enters project YAML. */
export async function createAppleProvider(options: AppleProviderOptions): Promise<OidcProvider> {
    if (!/^[A-Z0-9]{10}$/.test(options.teamId) || !/^[A-Z0-9]{10}$/.test(options.keyId) || !/^[A-Za-z0-9.-]{1,255}$/.test(options.clientId) || options.privateKey.length > 16384)
        throw new Error('Invalid Apple operator configuration');
    const key = await importPKCS8(options.privateKey, 'ES256');
    // A fresh five-minute credential for each protocol exchange avoids long-lived
    // client-secret expiry silently disabling a running deployment.
    const client = async () => createOidcProvider({ issuer: 'https://appleid.apple.com', clientId: options.clientId, clientSecret: await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: options.keyId }).setIssuer(options.teamId).setSubject(options.clientId).setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(key), redirectUri: options.redirectUri, scope: 'name email', responseMode: 'form_post', appleEmailClaim: true, ...(options.fetch ? { fetch: options.fetch } : {}) });
    // Validate discovery during operator activation, not after rendering a button.
    await client();
    return { async start() { return (await client()).start(); }, async complete(callback, flow) { return (await client()).complete(callback, flow); } };
}
