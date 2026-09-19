import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import { createSecondFactorFlows } from '../src/second-factor-flows.ts';
import type { SecondFactorFlowService } from '../src/second-factor-flows.ts';
import { AuthHttp } from '../src/auth-ui.ts';
import { createPasskeyProvider } from '../src/passkeys.ts';
test('second-factor ceremonies require real UV assertions, origin, browser binding and single-use challenges without issuing sessions', async () => {
    const origin = 'https://factor.example', browser = randomBytes(32).toString('base64url'), http = new AuthHttp({ origin, csrfKey: randomBytes(32) });
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
    const publicBytes = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
    const id = randomBytes(32).toString('base64url'), flows = new Map<string, unknown>();
    let timestamp = Date.now(), issued = 0;
    const service: SecondFactorFlowService = {
        getSecurityPolicy: () => ({ allowPasskeySecondFactor: true }),
        async putFlow(input) { flows.set(input.id, input.data); },
        async consumeFlow(id) { const value = flows.get(id); flows.delete(id); return value; },
        async getPasskey(credentialId) { return credentialId === id ? { accountId: 'account-not-for-client', credential: { id, publicKey: publicBytes.toString('base64url'), counter: 0 }, proof: { kind: 'passkey', credentialId: id, expectedCounter: 0, publicKeyHash: createHash('sha256').update(publicBytes.toString('base64url')).digest('hex'), version: 2 } } : null; },
        async createSecondFactorProof(input) {
            assert.equal(input.browserHash, createHash('sha256').update(browser).digest('hex'));
            assert.equal(input.proof.newCounter, 1);
            assert.equal(input.proof.version, 2);
            issued++;
            return randomBytes(32).toString('base64url');
        },
    };
    const handler = createSecondFactorFlows({ service, passkeys: createPasskeyProvider({ origin, rpId: 'factor.example', rpName: 'Factor' }), now: () => timestamp }, http, '/account');
    function request(path: string, body: Record<string, unknown>, binding = browser, requestOrigin = origin): ExtensionRequest {
        return { method: 'POST', path: '/account/second-factor/' + path, target: '/account/second-factor/' + path, query: new URLSearchParams(), headers: new Headers({ cookie: '__Host-urlcode-flow=' + binding, origin: requestOrigin, 'content-type': 'application/json' }), headerCounts: { cookie: 1, origin: 1 }, body: Buffer.from(JSON.stringify({ csrf: http.token(binding), ...body })), origin, route: '/account/*', mount: '/account', client: null };
    }
    async function begin() { const response = await handler.handle(request('options', {})); return JSON.parse(Buffer.from(response!.body!).toString()) as {
        flowId: string;
        options: {
            challenge: string;
            userVerification: string;
        };
    }; }
    function assertion(challenge: string, flags = 5, clientOrigin = origin) {
        const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: clientOrigin, crossOrigin: false })), counter = Buffer.alloc(4);
        counter.writeUInt32BE(1);
        const auth = Buffer.concat([createHash('sha256').update('factor.example').digest(), Buffer.from([flags]), counter]);
        return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'), signature: sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey).toString('base64url') } };
    }
    const first = await begin();
    assert.equal(first.options.userVerification, 'required');
    const valid = request('verify', { flowId: first.flowId, response: assertion(first.options.challenge) });
    const completed = await handler.handle(valid), result = JSON.parse(Buffer.from(completed!.body!).toString());
    assert.deepEqual(Object.keys(result), ['secondFactorToken']);
    assert.equal(result.secondFactorToken.length, 43);
    assert.equal(issued, 1);
    assert.equal(completed!.headers.some(([name]) => name === 'set-cookie'), false);
    await assert.rejects(handler.handle(valid));
    for (const [flags, clientOrigin] of [[1, origin], [5, 'https://attacker.example']] as const) {
        const flow = await begin();
        await assert.rejects(handler.handle(request('verify', { flowId: flow.flowId, response: assertion(flow.options.challenge, flags, clientOrigin) })), /Invalid second-factor assertion/);
    }
    const foreign = await begin();
    await assert.rejects(handler.handle(request('verify', { flowId: foreign.flowId, response: assertion(foreign.options.challenge) }, randomBytes(32).toString('base64url'))), /Invalid second-factor flow/);
    const expired = await begin();
    timestamp += 300001;
    await assert.rejects(handler.handle(request('verify', { flowId: expired.flowId, response: assertion(expired.options.challenge) })), /Invalid second-factor flow/);
    await assert.rejects(handler.handle(request('options', {}, browser, 'https://attacker.example')), /Same-origin/);
    await assert.rejects(handler.handle(request('options', { csrf: '0'.repeat(64) })), /CSRF/);
    await assert.rejects(handler.handle(request('options', { unexpected: true })), /Invalid second-factor payload/);
    const large = request('verify', { response: 'x'.repeat(17000) });
    await assert.rejects(handler.handle(large), /too large/);
    assert.equal(issued, 1);
    assert.deepEqual(handler.proof(valid, result.secondFactorToken), { token: result.secondFactorToken, browserHash: createHash('sha256').update(browser).digest('hex') });
    const disabled = createSecondFactorFlows({ service }, http, '/account');
    assert.equal(await disabled.handle(request('options', {})), undefined);
    assert.throws(() => disabled.proof(valid, result.secondFactorToken), /Invalid second-factor proof/);
});
