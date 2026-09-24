/**
 * The auth extension definition: what `urlcode extensions add auth` scaffolds into a site, and what host.mjs
 * activates through `composeHost`, for example
 *
 *   import auth from '@jimhoyd/urlcode-auth/extension';
 *   export default await composeHost(import.meta.url, [ui(), auth({ sendEmailCode })]);
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { Catalogue, ExtensionTemplates } from '@jimhoyd/urlcode-ui';
import { authAuthoring, authConfigSchema, authExtension, authPolicySchema } from './auth.ts';
import type { AuthExtensionOptions } from './auth.ts';
import type { AuthService } from './auth-core.ts';
import { authUiTemplates } from './auth-templates.ts';
import { authHookContracts } from './lifecycle-hooks.ts';
import { englishCatalogue } from './presentation.ts';
import type { UiHost } from './auth-ui.ts';

const OPERATOR_FILE = 'operator-service.mjs', ENCRYPTION_KEY = 'data/encryption.key', CSRF_KEY = 'data/csrf.key';

/**
 * What the operator may pass as `auth({...})` in host.mjs. Everything is optional: by default the service comes from
 * the scaffolded operator-service.mjs and the CSRF key from data/csrf.key; the revision pin and the kit come from
 * the host.
 */
export type AuthHostOptions = Partial<Omit<AuthExtensionOptions, 'projectSha256' | 'ui'>>;
/** What auth shares with extensions that require it (admin). */
export interface AuthExports { service: AuthService; csrfKey: Uint8Array }

/**
 * The trusted operator module. It stays a separate file because `urlcode-auth <command> --operator-file` imports it
 * directly, without the host.
 */
const operatorService = `import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createAuthService} from '@jimhoyd/urlcode-auth';
const key = await readFile(new URL('./${ENCRYPTION_KEY}', import.meta.url));
let service;
try {
  service = await createAuthService({
    database: fileURLToPath(new URL('./data/auth.sqlite', import.meta.url)),
    encryptionKey: key,
    roles: {member: [], admin: ['*']},
    defaultRole: 'member',
    registrationMode: 'off',
    ...(process.env.AUTH_CONFIG_FROM ? {approveConfigurationChangeFrom: process.env.AUTH_CONFIG_FROM} : {}),
  });
} finally { key.fill(0); }
export default service;
`;

const uiContribution: { sources: Catalogue[]; templates: ExtensionTemplates[] } = { sources: [englishCatalogue], templates: [authUiTemplates] };

async function loadOperatorService(site: string): Promise<AuthService> {
  // A fresh module instance per activation: a host that is composed again in the same process must not receive the
  // service the previous host closed.
  const url = pathToFileURL(join(site, OPERATOR_FILE)).href + '?urlcode-host=' + randomUUID();
  const service = (await import(url) as { default?: AuthService }).default;
  if (!service || typeof service.close !== 'function' || typeof service.bootstrapAdmin !== 'function')
    throw new Error(`${OPERATOR_FILE} must default-export the service createAuthService returns`);
  return service;
}

export default defineExtension<AuthHostOptions>({
  name: 'auth',
  description: 'Accounts, sessions, passkeys, OIDC and TOTP sign-in with trusted account pages',
  requires: ['ui'],
  schema: authConfigSchema,
  policySchema: authPolicySchema,
  hooks: authHookContracts,
  authoring: authAuthoring,
  agent: {
    description: 'Local, revision-pinned references for agents configuring the auth extension.',
    references: [{name: 'auth extension guide', description: 'Configuration, operator setup and route integration guidance.', path: 'README.md'}],
  },
  contributes: { ui: uiContribution },
  scaffold() {
    return {
      config: { registration: 'off' },
      routes: {
        '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
        '/private': { respond: { text: 'Signed in' }, auth: true },
      },
      files: [
        { path: OPERATOR_FILE, content: operatorService, mode: 0o600 },
        { path: ENCRYPTION_KEY, content: randomBytes(32), mode: 0o600 },
        { path: CSRF_KEY, content: randomBytes(32), mode: 0o600 },
      ],
      env: {
        AUTH_ORIGIN: 'Canonical HTTPS origin of the site as served by the TLS proxy; pass it to urlcode serve --origin.',
        AUTH_CONFIG_FROM: 'Optional: the current configuration revision hash, approving an operator configuration migration for one startup.',
      },
      notes: [
        'Bootstrap the first administrator with `npx urlcode-auth bootstrap --operator-file "$PWD/operator-service.mjs"`, passing {"email","password"} JSON on stdin, never in argv.',
        'Sign in at /account/login; /private requires a session. Registration is off until a reviewed configuration migration opens it.',
        'Keep data/ private and back up data/encryption.key and data/csrf.key separately from the database backup.',
      ],
    };
  },
  async host(ctx, options) {
    const { service: givenService, csrfKey: givenKey, ...rest } = options;
    const service = givenService ?? await loadOperatorService(ctx.site);
    let csrfKey: Uint8Array;
    try {
      if (givenKey) csrfKey = givenKey;
      else {
        csrfKey = await readFile(join(ctx.site, CSRF_KEY));
        if (csrfKey.length !== 32) { csrfKey.fill(0); throw new Error(`${CSRF_KEY} must hold exactly 32 bytes`); }
      }
    }
    catch (error) { if (!givenService) await service.close(); throw error; }
    const registration = authExtension({ ...rest, service, csrfKey, projectSha256: ctx.projectSha256, ui: ctx.get<UiHost>('ui') });
    const exports: AuthExports = { service, csrfKey };
    return {
      registration,
      exports,
      // Release only what this host opened; an operator-supplied service or key stays the operator's.
      async close() {
        if (!givenKey) csrfKey.fill(0);
        if (!givenService) await service.close();
      },
    };
  },
});
