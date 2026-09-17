import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { createAppleProvider, createGoogleProvider } from '../src/providers.ts';
test('Google factory uses pinned issuer and standard code flow', async () => {
    const provider = await createGoogleProvider({ clientId: 'client', clientSecret: 'synthetic', redirectUri: 'https://site.example/account/providers/google/callback', fetch: async (input) => { assert.equal(String(input), 'https://accounts.google.com/.well-known/openid-configuration'); return Response.json({ issuer: 'https://accounts.google.com', authorization_endpoint: 'https://accounts.google.com/authorize', token_endpoint: 'https://accounts.google.com/token', jwks_uri: 'https://accounts.google.com/jwks', response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }); } });
    const { url } = await provider.start();
    assert.equal(new URL(url).searchParams.get('scope'), 'openid email');
});
test('Apple uses form-post, ES256 short-lived client secret, and token verification remains fail-closed', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    let checked = false;
    const provider = await createAppleProvider({ teamId: 'ABCDEFGHIJ', keyId: '1234567890', clientId: 'com.example.web', privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), redirectUri: 'https://site.example/account/providers/apple/callback', fetch: async (input, init) => {
            const url = String(input);
            if (url.endsWith('/.well-known/openid-configuration'))
                return Response.json({ issuer: 'https://appleid.apple.com', authorization_endpoint: 'https://appleid.apple.com/auth/authorize', token_endpoint: 'https://appleid.apple.com/auth/token', jwks_uri: 'https://appleid.apple.com/auth/keys', response_types_supported: ['code'], subject_types_supported: ['pairwise'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
            if (url.endsWith('/auth/token')) {
                const body = new URLSearchParams(String(init?.body)), secret = body.get('client_secret')!;
                const result = await jwtVerify(secret, publicKey, { issuer: 'ABCDEFGHIJ', audience: 'https://appleid.apple.com', subject: 'com.example.web', algorithms: ['ES256'] });
                assert.equal(result.protectedHeader.kid, '1234567890');
                assert.equal(result.payload.exp! - result.payload.iat!, 300);
                checked = true;
                return Response.json({ error: 'invalid_grant' }, { status: 400 });
            }
            throw new Error('Unexpected provider request');
        } });
    const { url, flow } = await provider.start();
    assert.equal(new URL(url).searchParams.get('response_mode'), 'form_post');
    assert.equal(new URL(url).searchParams.get('scope'), 'name email');
    await assert.rejects(provider.complete(new Request('https://site.example/account/providers/apple/callback', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: 'synthetic', state: flow.state }) }), flow));
    assert.equal(checked, true);
});
