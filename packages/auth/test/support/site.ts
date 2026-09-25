/** The extensions a real auth site composes in host.mjs (ui, audit, mail, auth), for suites that run a whole site through composeHost. Its project declares ui, audit, mail and auth. */
import type { TestContext } from 'node:test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import ui from '@jimhoyd/urlcode-ui/extension';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import { recordingTransport } from '@jimhoyd/urlcode-mail';
import type { ExtensionEntry } from '@jimhoyd/urlcode/extensions';
import auth from '../../src/extension.ts';
import { createAuthService } from '../../src/auth-core.ts';
import type { AuthOptions, AuthService } from '../../src/auth-core.ts';
import { cleanup } from '../cleanup.ts';

export async function siteHost(t: TestContext, root: string, csrfKey: Uint8Array, options: Partial<AuthOptions> = {}): Promise<{ entries: ExtensionEntry[]; service: AuthService }> {
    const service = await createAuthService({ database: join(root, 'accounts.sqlite'), encryptionKey: randomBytes(32), roles: { member: ['site.read'], admin: ['*'] }, defaultRole: 'member', registrationMode: 'open', ...options });
    cleanup(t, () => service.close());
    return { entries: [ui(), audit({ database: join(root, 'audit.sqlite') }), mail({ transport: recordingTransport() }), auth({ service, csrfKey })], service };
}
