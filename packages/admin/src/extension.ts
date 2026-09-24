/**
 * The admin extension definition: what `urlcode extensions add admin` scaffolds into a site, and what host.mjs
 * activates through `composeHost`, for example
 *
 *   import admin from '@jimhoyd/urlcode-admin/extension';
 *   export default await composeHost(import.meta.url, [ui(), auth(), admin({ sendInvitation })]);
 *
 * Admin opens nothing of its own: it shares auth's operator service and CSRF key through the host.
 */
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ExtensionTemplates } from '@jimhoyd/urlcode-ui';
import type { AuthService } from '@jimhoyd/urlcode-auth';
import { adminAuthoring, adminConfigSchema, adminExtension } from './admin.ts';
import type { AdminExtensionOptions } from './admin.ts';
import { adminHookContracts } from './admin-hooks.ts';
import { adminUiTemplates } from './admin-templates.ts';
import type { UiHost } from './admin-ui.ts';

/** What the operator may pass as `admin({...})` in host.mjs; all optional. The service, CSRF key, revision pin and kit come from the host. */
export type AdminHostOptions = Partial<Omit<AdminExtensionOptions, 'service' | 'csrfKey' | 'projectSha256' | 'ui'>>;

const uiContribution: { templates: ExtensionTemplates[] } = { templates: [adminUiTemplates] };

export default defineExtension<AdminHostOptions>({
  name: 'admin',
  description: 'Administration console for users, sessions, roles and audit, on top of the auth extension',
  requires: ['auth', 'ui'],
  schema: adminConfigSchema,
  hooks: adminHookContracts,
  authoring: adminAuthoring,
  agent: {description: 'Local, revision-pinned references for agents configuring the admin extension.', references: [{name: 'admin extension guide', description: 'Configuration and operational guidance for users, sessions and roles.', path: 'README.md'}]},
  contributes: { ui: uiContribution },
  scaffold() {
    return {
      config: {},
      routes: { '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] } },
      notes: [
        'After bootstrapping the first administrator and signing in at /account/login, open /admin.',
        'Configure sender callbacks in host.mjs (admin({...})) before inviting users; impersonation stays disabled until explicitly enabled.',
      ],
    };
  },
  host(ctx, options) {
    const auth = ctx.get<{ service: AuthService; csrfKey: Uint8Array } | undefined>('auth');
    if (!auth || !auth.service || !(auth.csrfKey instanceof Uint8Array)) throw new Error('admin needs the auth extension to share its service and CSRF key');
    return { registration: adminExtension({ ...options, authMount: options.authMount ?? '/account', service: auth.service, csrfKey: auth.csrfKey, projectSha256: ctx.projectSha256, ui: ctx.get<UiHost>('ui') }) };
  },
});
