import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TestContext } from 'node:test';
import { createAuthService as createPublicService, internal } from '../../src/auth-core.ts';
import type { AuthOptions, AuthServiceInternal as AuthService } from '../../src/auth-core.ts';
import { cleanup } from '../cleanup.ts';

/** Shared fixtures keep each core suite independent under the per-file test deadline. */
export const key = Buffer.alloc(32, 7);
export const roles = { user: ['content.read'], editor: ['content.read', 'content.write'], manager: ['content.read', 'auth.users.manage', 'auth.sessions.manage'], admin: ['*'] };
export const password = 'synthetic password phrase 123';
/** These suites exercise administrative operations directly and need the full service. */
export const createAuthService = async (options: AuthOptions) => internal(await createPublicService(options));

export async function setup(t: TestContext, extra: Partial<AuthOptions> = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'urlcode-auth-'));
    cleanup(t, () => rm(directory, { recursive: true, force: true }));
    const database = join(directory, 'auth.sqlite');
    let timestamp = 1800000000000;
    const options = { database, encryptionKey: key, roles, defaultRole: 'user', now: () => timestamp, ...extra };
    const service = await createAuthService(options);
    cleanup(t, () => service.close());
    return { service, options, database, advance: (ms: number) => { timestamp += ms; }, now: () => timestamp };
}

/** The registrant verifies in its own signed-in browser, so its methods are kept. */
export async function verifyOwnMailbox(service: AuthService, email: string, sessionToken: string) {
    await service.consumeVerification((await service.issueToken({ email, purpose: 'verify-email' })).token!, sessionToken);
}
