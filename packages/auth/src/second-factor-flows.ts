import { createHash, randomBytes } from 'node:crypto';
import type { ExtensionRequest } from '@jimhoyd/urlcode/extensions';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { AuthService, PasskeyAuthProof } from './auth-core.ts';
import type { PasskeyProvider } from './passkeys.ts';
import { AuthHttp, AuthHttpError, jsonResponse } from './auth-ui.ts';
import type { AuthHttpResponse } from './auth-ui.ts';
export interface SecondFactorInput {
    token: string;
    browserHash: string;
}
export interface SecondFactorFlowService extends Pick<AuthService, 'putFlow' | 'consumeFlow' | 'getPasskey'> {
    getSecurityPolicy(): {
        allowPasskeySecondFactor?: boolean;
    };
    createSecondFactorProof(input: {
        browserHash: string;
        proof: PasskeyAuthProof;
    }): Promise<string>;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new AuthHttpError(400, 'Invalid second-factor payload');
    return value as Record<string, unknown>;
}
function payload(request: ExtensionRequest): Record<string, unknown> {
    if (request.body.byteLength > 16384)
        throw new AuthHttpError(413, 'Request body too large');
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json')
        throw new AuthHttpError(415, 'JSON required');
    try {
        return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.body)));
    }
    catch {
        throw new AuthHttpError(400, 'Invalid second-factor payload');
    }
}
/** Obtains UV evidence only. The domain consumes the resulting opaque proof together
 * with the independent primary proof and counter update in the final transaction. */
export function createSecondFactorFlows(options: {
    service: SecondFactorFlowService;
    passkeys?: PasskeyProvider;
    now?: () => number;
}, http: AuthHttp, mount: string) {
    const { service, passkeys } = options, now = options.now ?? Date.now;
    const enabled = () => Boolean(passkeys && service.getSecurityPolicy().allowPasskeySecondFactor);
    const browserHash = (request: ExtensionRequest) => {
        const browser = http.session(request) || http.cookie(request, http.flowCookie);
        if (!browser)
            throw new AuthHttpError(403, 'Authentication browser binding required');
        return hash(browser);
    };
    return {
        proof(request: ExtensionRequest, token: string): SecondFactorInput {
            if (!enabled() || !opaque(token))
                throw new AuthHttpError(400, 'Invalid second-factor proof');
            return { token, browserHash: browserHash(request) };
        },
        async handle(request: ExtensionRequest): Promise<AuthHttpResponse | undefined> {
            if (!enabled() || ![mount + '/second-factor/options', mount + '/second-factor/verify'].includes(request.path))
                return undefined;
            if (request.method !== 'POST')
                throw new AuthHttpError(405, 'POST required');
            const body = payload(request), begin = request.path.endsWith('/options');
            if (Object.keys(body).some(key => !(begin ? ['csrf'] : ['csrf', 'flowId', 'response']).includes(key)) || body.csrf !== undefined && typeof body.csrf !== 'string')
                throw new AuthHttpError(400, 'Invalid second-factor payload');
            http.verify(request, { csrf: typeof body.csrf === 'string' ? body.csrf : '' });
            const binding = browserHash(request);
            if (begin) {
                const authentication = await passkeys!.beginAuthentication(), flowId = randomBytes(32).toString('base64url');
                await service.putFlow({ id: flowId, kind: 'passkey-second-factor', expires: now() + 300000, data: { challenge: authentication.challenge, browserHash: binding, expires: now() + 300000 } });
                return jsonResponse(200, { flowId, options: authentication });
            }
            if (!opaque(body.flowId))
                throw new AuthHttpError(400, 'Invalid second-factor flow');
            const flow = record(await service.consumeFlow(body.flowId, 'passkey-second-factor'));
            if (flow.browserHash !== binding || typeof flow.challenge !== 'string' || typeof flow.expires !== 'number' || flow.expires <= now())
                throw new AuthHttpError(403, 'Invalid second-factor flow');
            const response = record(body.response);
            if (typeof response.id !== 'string' || response.id.length > 2048)
                throw new AuthHttpError(400, 'Invalid second-factor assertion');
            const stored = await service.getPasskey(response.id);
            if (!stored)
                throw new AuthHttpError(400, 'Invalid second-factor assertion');
            let counter: number;
            try {
                ({ counter } = await passkeys!.verifyAuthentication(response as unknown as AuthenticationResponseJSON, flow.challenge, stored.credential));
            }
            catch {
                throw new AuthHttpError(400, 'Invalid second-factor assertion');
            }
            const secondFactorToken = await service.createSecondFactorProof({ browserHash: binding, proof: { ...stored.proof, newCounter: counter } });
            return jsonResponse(200, { secondFactorToken });
        },
    };
}
