import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON, AuthenticatorTransport, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
export interface StoredPasskey {
    id: string;
    publicKey: string;
    counter: number;
    transports?: string[];
    /** The relying-party ID the credential was registered for; auth records it so a later RP ID change is noticed (#736). */
    rpId?: string;
}
export interface PasskeyProviderOptions {
    origin: string;
    rpId: string;
    rpName: string;
}
/** The operator's shared relying-party domain and the site origins a ceremony may come from (canonical first). */
export interface PasskeySite {
    rpId: string;
    origins: readonly string[];
}
export interface PasskeyProvider {
    /** The relying-party ID ceremonies are bound to. */
    readonly rpId: string;
    /** The client origins a ceremony is accepted from: the canonical origin first. */
    readonly origins: readonly string[];
    beginRegistration(user: { id: string; email: string }, exclude?: StoredPasskey[]): Promise<PublicKeyCredentialCreationOptionsJSON>;
    verifyRegistration(response: RegistrationResponseJSON, challenge: string): Promise<StoredPasskey>;
    beginAuthentication(): Promise<PublicKeyCredentialRequestOptionsJSON>;
    verifyAuthentication(response: AuthenticationResponseJSON, challenge: string, stored: StoredPasskey): Promise<{ counter: number }>;
    /**
     * The same provider bound to an operator's shared relying-party domain (the extension activation's
     * `passkeyRpId`): ceremonies use `site.rpId` and accept any of `site.origins`. The canonical origin must
     * stay first and equal this provider's origin; every origin's host must be `rpId` or a subdomain of it.
     */
    withSite(site: PasskeySite): PasskeyProvider;
}
const dnsName = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
function bound(origins: readonly string[], rpId: string, rpName: string): PasskeyProvider {
    // A single origin keeps the exact string match simplewebauthn has always been given.
    const expectedOrigin = origins.length === 1 ? origins[0]! : [...origins];
    return {
        rpId,
        origins,
        beginRegistration(user, exclude = []) {
            if (!user.id || Buffer.byteLength(user.id) > 64 || exclude.length > 100)
                throw new Error('Invalid passkey registration');
            return generateRegistrationOptions({ rpID: rpId, rpName, userID: new TextEncoder().encode(user.id), userName: user.email, attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: exclude.map(item => ({ id: item.id, ...(item.transports ? { transports: item.transports as AuthenticatorTransport[] } : {}) })) });
        },
        async verifyRegistration(response, challenge) {
            const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin, expectedRPID: rpId, requireUserVerification: true });
            if (!result.verified)
                throw new Error('Passkey registration refused');
            const credential = result.registrationInfo.credential;
            return { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter, ...(credential.transports ? { transports: credential.transports } : {}), rpId };
        },
        beginAuthentication() { return generateAuthenticationOptions({ rpID: rpId, userVerification: 'required' }); },
        async verifyAuthentication(response, challenge, stored) {
            const credential = { id: stored.id, publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')), counter: stored.counter, ...(stored.transports ? { transports: stored.transports as AuthenticatorTransport[] } : {}) };
            const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin, expectedRPID: rpId, credential, requireUserVerification: true });
            if (!result.verified || !result.authenticationInfo.userVerified)
                throw new Error('Passkey authentication refused');
            return { counter: result.authenticationInfo.newCounter };
        },
        withSite(site) {
            const canonical = origins[0]!;
            if (!site || typeof site.rpId !== 'string' || !dnsName.test(site.rpId) || !Array.isArray(site.origins) || site.origins.length < 1 || site.origins.length > 17)
                throw new Error('Passkey site binding requires a lowercase RP ID domain and the site origins');
            if (site.origins[0] !== canonical)
                throw new Error(`Passkey provider origin ${canonical} is not the site's canonical origin ${String(site.origins[0])}; create the provider with the --origin value`);
            for (const origin of site.origins) {
                let url: URL;
                try { url = new URL(origin); } catch { throw new Error('Passkey site origins must be absolute origins'); }
                if (url.origin !== origin || !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === 'localhost'))
                    throw new Error(`Passkey site origin ${origin} must be a serialized https: origin`);
                // Label-boundary match: the RP ID is the host or a parent domain of it, never a string suffix.
                if (url.hostname !== site.rpId && !url.hostname.endsWith('.' + site.rpId))
                    throw new Error(`Passkey RP ID ${site.rpId} is neither the host of ${origin} nor a parent domain of it`);
            }
            return bound(Object.freeze([...site.origins]), site.rpId, rpName);
        }
    };
}
export function createPasskeyProvider({ origin, rpId, rpName }: PasskeyProviderOptions): PasskeyProvider {
    const url = new URL(origin);
    // Exact hostname deliberately avoids accidental sibling-site credential sharing. A shared,
    // operator-chosen RP ID is opt-in and applied at activation through withSite().
    if (url.origin !== origin || url.protocol !== 'https:' || rpId !== url.hostname || !rpName || rpName.length > 128)
        throw new Error('Passkeys require a canonical HTTPS origin and matching RP hostname');
    return bound(Object.freeze([origin]), rpId, rpName);
}
