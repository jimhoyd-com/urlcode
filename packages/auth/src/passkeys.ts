import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON, AuthenticatorTransport } from '@simplewebauthn/server';
export interface StoredPasskey {
    id: string;
    publicKey: string;
    counter: number;
    transports?: string[];
}
export interface PasskeyProviderOptions {
    origin: string;
    rpId: string;
    rpName: string;
}
export function createPasskeyProvider({ origin, rpId, rpName }: PasskeyProviderOptions) {
    const url = new URL(origin);
    // Exact hostname deliberately avoids accidental sibling-site credential sharing.
    if (url.origin !== origin || url.protocol !== 'https:' || rpId !== url.hostname || !rpName || rpName.length > 128)
        throw new Error('Passkeys require a canonical HTTPS origin and matching RP hostname');
    return {
        beginRegistration(user: {
            id: string;
            email: string;
        }, exclude: StoredPasskey[] = []) {
            if (!user.id || Buffer.byteLength(user.id) > 64 || exclude.length > 100)
                throw new Error('Invalid passkey registration');
            return generateRegistrationOptions({ rpID: rpId, rpName, userID: new TextEncoder().encode(user.id), userName: user.email, attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: exclude.map(item => ({ id: item.id, ...(item.transports ? { transports: item.transports } : {}) })) });
        },
        async verifyRegistration(response: RegistrationResponseJSON, challenge: string): Promise<StoredPasskey> {
            const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true });
            if (!result.verified)
                throw new Error('Passkey registration refused');
            const credential = result.registrationInfo.credential;
            return { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64url'), counter: credential.counter, ...(credential.transports ? { transports: credential.transports } : {}) };
        },
        beginAuthentication() { return generateAuthenticationOptions({ rpID: rpId, userVerification: 'required' }); },
        async verifyAuthentication(response: AuthenticationResponseJSON, challenge: string, stored: StoredPasskey): Promise<{
            counter: number;
        }> {
            const credential = { id: stored.id, publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')), counter: stored.counter, ...(stored.transports ? { transports: stored.transports as AuthenticatorTransport[] } : {}) };
            const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId, credential, requireUserVerification: true });
            if (!result.verified || !result.authenticationInfo.userVerified)
                throw new Error('Passkey authentication refused');
            return { counter: result.authenticationInfo.newCounter };
        }
    };
}
export type PasskeyProvider = ReturnType<typeof createPasskeyProvider>;
