/**
 * The `forms` extension definition: what `urlcode extensions add forms` scaffolds and what host.mjs activates
 * through `composeHost`. Published as the package's `./extension` entry.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';
import { createFormsExtension, formHookContracts, formsAuthoring, formsConfigSchema } from './forms.ts';

/** The CSRF secret file, relative to the site; `data/` is outside app/ and ignored by the starter's .gitignore. */
export const formsCsrfKeyFile = 'data/forms-csrf.key';
/** Operator options from host.mjs, `forms({...})`; all optional. */
export interface FormsHostOptions {
  /** The CSRF signing secret (at least 32 bytes). Default: the bytes of `csrfSecretFile`. */
  csrfSecret?: string | Uint8Array | undefined;
  /** Secret file, relative to the site or absolute. Default: `data/forms-csrf.key`, written by the scaffold. */
  csrfSecretFile?: string | undefined;
}

export default defineExtension<FormsHostOptions>({
  name: 'forms',
  description: 'Declarative server-rendered form flows with CSRF, field validation and a confirmation page, rendered through ui.',
  requires: ['ui'],
  schema: formsConfigSchema,
  hooks: formHookContracts,
  authoring: formsAuthoring,
  agent: {description: 'Local, revision-pinned references for agents configuring the forms extension.', references: [{name: 'forms extension guide', description: 'Configuration and integration guidance for declarative form flows.', path: 'README.md'}]},
  // The capability: the CSRF key the extension needs and an empty flows block; no form is mounted.
  scaffold() {
    return {
      config: { flows: {} },
      routes: {},
      // A fresh secret per site; an existing file is kept, so outstanding tokens survive remove and re-add.
      files: [{ path: formsCsrfKeyFile, content: new Uint8Array(randomBytes(32)), mode: 0o600 }],
      notes: [
        'forms is installed with no flows: declare one under extensions.forms.config.flows and mount it with a route <mount>/* using extension: forms (GET, HEAD, POST). See the @jimhoyd/urlcode-forms README.',
        `Keep ${formsCsrfKeyFile} secret and out of version control; it signs the forms CSRF tokens.`,
      ],
    };
  },
  // `--example`: a public contact form on /contact.
  example() {
    return {
      config: {
        flows: {
          contact: {
            mount: '/contact', title: 'Contact us', submitLabel: 'Send message',
            confirmation: { title: 'Thank you', message: 'We received your message.' },
            fields: {
              name: { label: 'Name', maxLength: 120 },
              email: { label: 'Email', type: 'email', maxLength: 320 },
              message: { label: 'Message', control: 'textarea', minLength: 10, maxLength: 2000 },
            },
          },
        },
      },
      routes: { '/contact/*': { extension: 'forms', methods: ['GET', 'HEAD', 'POST'] } },
      notes: [
        'Open /contact: a sample form declared in app/urlcode.yaml under extensions.forms.config.flows; edit its fields or add flows there.',
        'Handle submissions with a trusted onSubmit hook (extensions.forms.config.hooks.onSubmit); without one a valid submission only shows the confirmation.',
      ],
    };
  },
  async host(context, options) {
    let csrfSecret = options.csrfSecret;
    if (csrfSecret === undefined) {
      const file = options.csrfSecretFile ?? formsCsrfKeyFile;
      const path = isAbsolute(file) ? file : join(context.site, file);
      try { csrfSecret = await readFile(path); } catch (error) {
        throw new Error(`forms needs its CSRF secret at ${path} (urlcode extensions add forms writes it), or pass forms({csrfSecret})`, { cause: error });
      }
    }
    return { registration: createFormsExtension({ projectSha256: context.projectSha256, csrfSecret, ui: context.get<UiExtension>('ui') }) };
  },
});
