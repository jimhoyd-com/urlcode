/**
 * The auth extension definition: what `urlcode extensions add auth` scaffolds into a site, and what host.mjs
 * activates through `composeHost`, for example
 *
 *   import auth from '@jimhoyd/urlcode-auth/extension';
 *   export default await composeHost(import.meta.url, [ui(), audit(), mail({transport}), auth()]);
 *
 * Auth requires ui (every account screen), audit (every privileged action is recorded through its outbox) and mail
 * (every message it sends); it uses abuse, when installed, for the budgets extensions.auth.config.abuse declares.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { Catalogue, ExtensionTemplates } from '@jimhoyd/urlcode-ui';
import type { AbuseExports } from '@jimhoyd/urlcode-abuse';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import type { MailExports } from '@jimhoyd/urlcode-mail';
import { authAuthoring, authConfigSchema, authPolicySchema, createAuth } from './auth.ts';
import { internal } from './auth-core.ts';
import type { AuthService } from './auth-core.ts';
import { authUiTemplates } from './auth-templates.ts';
import { authHookContracts } from './lifecycle-hooks.ts';
import { authMail } from './mail-templates.ts';
import type { OidcProvider } from './oidc.ts';
import type { PasskeyProvider } from './passkeys.ts';
import { englishCatalogue } from './presentation.ts';
import type { UiHost } from './auth-ui.ts';

const OPERATOR_FILE = 'operator-service.mjs', ENCRYPTION_KEY = 'data/encryption.key', CSRF_KEY = 'data/csrf.key';

/**
 * What the operator may pass as `auth({...})` in host.mjs. Everything is optional: by default the service comes from
 * the scaffolded operator-service.mjs and the CSRF key from data/csrf.key; the revision pin, the kit, audit, mail and
 * abuse come from the host.
 */
export type AuthHostOptions = { service?: AuthService; csrfKey?: Uint8Array; providers?: Record<string, OidcProvider>; passkeys?: PasskeyProvider };

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
  requires: ['ui', 'audit', 'mail'],
  uses: ['abuse'],
  schema: authConfigSchema,
  policySchema: authPolicySchema,
  hooks: authHookContracts,
  authoring: authAuthoring,
  agent: {
    description: 'Local, revision-pinned references for agents configuring the auth extension.',
    references: [{name: 'auth extension guide', description: 'Configuration, operator setup and route integration guidance.', path: 'README.md'}],
  },
  contributes: { ui: uiContribution, mail: authMail },
  // The capability: the account pages at the default /account mount (configurable: move the route, and pass
  // admin({authMount}) when admin is installed), the operator service with the minimal {member, admin} role model
  // admin and bootstrap rely on, and the private keys. No application page is protected yet.
  scaffold() {
    return {
      config: { registration: 'off' },
      routes: {
        '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
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
        'Sign in at /account/login. Registration is off until a reviewed configuration migration opens it. Protect a route of your own with `auth: true` (or `auth: {role: admin}`); roles are member and admin, set in operator-service.mjs.',
        'Keep data/ private and back up data/encryption.key and data/csrf.key separately from the database backup.',
        'Auth records every privileged action in the audit extension (its outbox drains while the host runs) and sends every email through the mail extension; without a mail transport it serves password sign-in only.',
      ],
    };
  },
  // `--example`: a /private page that only a signed-in caller can read.
  example() {
    return {
      config: {},
      routes: { '/private': { respond: { text: 'Signed in' }, auth: true } },
      notes: ['/private requires a session: open it signed out, then after signing in at /account/login.'],
    };
  },
  async host(ctx, options) {
    const ui = ctx.get<UiHost>('ui'), audit = ctx.get<AuditExports>('audit'), mail = ctx.get<MailExports>('mail'), abuse = ctx.get<AbuseExports | undefined>('abuse');
    if (audit?.version !== 1) throw new Error('auth needs audit exports version 1');
    if (mail?.version !== 1) throw new Error('auth needs mail exports version 1');
    if (abuse !== undefined && abuse.version !== 1) throw new Error('auth needs abuse exports version 1');
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
    const { registration, exports } = createAuth({ ...rest, service, csrfKey, projectSha256: ctx.projectSha256, ui, audit, mail, abuse });
    // Auth's outbox drains into the audit log while this host runs; a commit that wrote events wakes the drain.
    const outbox = internal(service).auditOutbox;
    const attachment = audit.attach({ source: 'auth', peek: limit => outbox.peek(limit), ack: ids => outbox.ack(ids) });
    const off = outbox.onPending(() => attachment.notify());
    return {
      registration,
      exports,
      // Release only what this host opened; an operator-supplied service or key stays the operator's. The drain stops
      // (after its in-flight batch) before the service it reads closes.
      async close() {
        off();
        await attachment.close();
        if (!givenKey) csrfKey.fill(0);
        if (!givenService) await service.close();
      },
    };
  },
});
