/**
 * The admin extension definition: what `urlcode extensions add admin` scaffolds into a site, and what host.mjs
 * activates through `composeHost`, for example
 *
 *   import admin from '@jimhoyd/urlcode-admin/extension';
 *   export default await composeHost(import.meta.url, [ui(), audit(), mail({transport}), auth(), admin()]);
 *
 * Admin holds none of auth's secrets: auth's route policy on `/admin/*` resolves the session and verifies CSRF, and
 * admin reads the signed-in account, a CSRF token and the administration API from AuthExports v1. Audit reads go
 * straight to AuditExports.
 */
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { Catalogue, ExtensionTemplates } from '@jimhoyd/urlcode-ui';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';
import type { AuthExports } from '@jimhoyd/urlcode-auth';
import type { AuditExports } from '@jimhoyd/urlcode-audit';
import { adminAuthoring, adminConfigSchema, createAdmin } from './admin.ts';
import { adminCatalogue } from './admin-copy.ts';
import type { AdminHealthProvider } from './admin-health.ts';
import { adminUiTemplates } from './admin-templates.ts';

/** What the operator may pass as `admin({...})` in host.mjs: an optional health observer. Everything else comes from the host. */
export interface AdminHostOptions { health?: AdminHealthProvider }

const uiContribution: { sources: Catalogue[]; templates: ExtensionTemplates[] } = { sources: [adminCatalogue], templates: [adminUiTemplates] };

export default defineExtension<AdminHostOptions>({
  name: 'admin',
  description: 'Administration console for users, sessions, roles and audit, on top of the auth and audit extensions',
  requires: ['auth', 'ui', 'audit'],
  schema: adminConfigSchema,
  authoring: adminAuthoring,
  agent: {description: 'Local, revision-pinned references for agents configuring the admin extension.', references: [{name: 'admin extension guide', description: 'Configuration and operational guidance for users, sessions and roles.', path: 'README.md'}]},
  contributes: { ui: uiContribution },
  // The capability is the console itself; admin ships no example.
  scaffold() {
    return {
      config: {},
      routes: { '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'], auth: { onDeny: 404 } } },
      notes: [
        'After bootstrapping the first administrator and signing in at auth\'s mount (/account/login by default), open /admin. The console answers 404 to anyone auth does not sign in with a console permission.',
        'Invitations, setup links, manual recovery and account operations need a mail transport; impersonation also needs allowImpersonation in operator-service.mjs.',
        'Grant audit.read (and audit.export for range exports) in operator-service.mjs roles to show the audit log.',
      ],
    };
  },
  host(ctx, options) {
    const auth = ctx.get<AuthExports>('auth');
    if (auth?.version !== 1) throw new Error('admin needs auth exports version 1');
    const audit = ctx.get<AuditExports>('audit');
    if (audit?.version !== 1) throw new Error('admin needs audit exports version 1');
    const ui = ctx.get<UiExtension>('ui');
    return { registration: createAdmin({ auth, ui, audit, health: options.health, projectSha256: ctx.projectSha256 }) };
  },
});
