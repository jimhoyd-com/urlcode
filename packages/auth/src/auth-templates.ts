/**
 * The account screens as kit templates, under the `auth` namespace. A
 * template only places a view model the extension computes: every value is
 * escaped by the renderer, and the `Markup` slots (forms with their CSRF
 * field, fields, buttons) are built by trusted package code. A project may
 * shadow any of these by name; it cannot change a flow, what a form
 * validates, what is escaped or what a page sends in headers.
 */
import { Markup } from '@jimhoyd/urlcode-ui';
import type { ExtensionTemplates, ViewModel } from '@jimhoyd/urlcode-ui';
import { englishCatalogue } from './presentation.ts';
export interface AuthTemplate { readonly source: string; readonly sample: ViewModel }
const m = (html: string) => new Markup(html);
const declare = (name: string, body: string) => `{{!-- viewModel: auth/${name}@1 --}}${body}`;
const link = '<a href="{{href href}}">{{label}}</a>';
const screens: Record<string, { body: string; sample: ViewModel }> = {
    'sign-in': {
        body: `{{#if intro}}<p class="ui-intro">{{intro}}</p>{{/if}}{{form}}{{passkey}}{{providers}}<nav class="ui-link-list" aria-label="{{linksLabel}}">{{#each links}}${link}{{/each}}</nav>`,
        sample: { intro: '', form: m('<form method="post"></form>'), passkey: m(''), providers: m(''), linksLabel: 'Sign-in methods', links: [{ href: '/account/register', label: 'Create account' }] },
    },
    password: {
        body: `{{#if failed}}<p class="error" role="alert">{{failed}}</p>{{/if}}{{#if intro}}<p class="ui-intro">{{intro}}</p>{{/if}}<div class="ui-selected-identity"><span class="ui-identifier">{{email}}</span><a href="{{href changeHref}}">{{changeLabel}}</a></div>{{form}}`,
        sample: { failed: null, intro: '', email: 'ada@example.test', changeHref: '/account/login', changeLabel: 'Change', form: m('<form method="post"></form>') },
    },
    register: { body: `{{form}}`, sample: { form: m('<form method="post"></form>') } },
    'forgot-password': { body: `{{#if intro}}<p class="ui-intro">{{intro}}</p>{{/if}}{{form}}`, sample: { intro: 'We will send a reset link.', form: m('<form method="post"></form>') } },
    'email-code': { body: `{{form}}`, sample: { form: m('<form method="post"></form>') } },
    'confirm-token': { body: `{{form}}`, sample: { form: m('<form method="post"></form>') } },
    enrollment: {
        body: `<p role="status">{{status}}</p><p>{{email}}</p><h2>{{heading}}</h2>{{#if form}}{{form}}{{else}}<p>{{unavailable}}</p>{{/if}}{{#if passkeyHref}}<p><a href="{{href passkeyHref}}">{{passkeyLabel}}</a></p>{{/if}}<p><a href="{{href stepUpHref}}">{{stepUpLabel}}</a> {{stepUpHelp}}</p>{{signOut}}`,
        sample: { status: 'Application access remains blocked until enrollment is complete.', email: 'ada@example.test', heading: 'Verify your email first', form: m('<form method="post"></form>'), unavailable: null, passkeyHref: null, passkeyLabel: null, stepUpHref: '/account/step-up', stepUpLabel: 'Confirm your identity', stepUpHelp: 'if your recent sign-in has expired.', signOut: m('<form method="post"></form>') },
    },
    impersonation: { body: `{{navigation}}<p role="alert">{{alert}}</p>{{form}}`, sample: { navigation: m('<nav></nav>'), alert: 'You are viewing this account as a support administrator.', form: m('<form method="post"></form>') } },
    account: {
        body: `{{navigation}}<section class="ui-card ui-section"><div class="ui-toolbar"><div><p class="ui-identifier">{{email}}</p></div>{{signOut}}</div><p>{{state}}</p>{{verification}}</section><div class="ui-settings-grid">{{#each sections}}<section class="ui-card ui-section{{#if danger}} ui-danger-zone{{/if}}"><h2>{{heading}}</h2>{{content}}</section>{{/each}}</div>`,
        sample: { navigation: m('<nav></nav>'), overviewLabel: 'Your account', email: 'ada@example.test', signOut: m('<form method="post"></form>'), state: 'Email verified. Authenticator disabled.', verification: m(''), sections: [{ heading: 'Profile', content: m('<form method="post"></form>'), danger: false }] },
    },
    'second-factors': {
        body: `{{navigation}}{{csrf}}<p>{{intro}}</p>{{register}}{{#each passkeys}}<section class="ui-card ui-section"><h2>{{id}}</h2><p>{{state}}</p>{{form}}</section>{{/each}}`,
        sample: { navigation: m('<nav></nav>'), csrf: m('<input type="hidden" name="csrf" value="token">'), intro: 'A second-factor passkey must be different from the sign-in passkey.', register: m('<button type="button">Add a passkey</button>'), passkeys: [{ id: 'credential', state: 'Enabled', form: m('<form method="post"></form>') }] },
    },
    'trusted-devices': {
        body: `{{navigation}}<p>{{intro}}</p>{{form}}{{#each devices}}<section class="ui-card ui-section"><h2>{{label}}</h2><p>{{expires}}</p>{{form}}</section>{{/each}}`,
        sample: { navigation: m('<nav></nav>'), intro: 'Remembering a device requires a real second factor.', form: m('<form method="post"></form>'), devices: [{ label: 'Laptop', expires: '2030-01-01T00:00:00.000Z', form: m('<form method="post"></form>') }] },
    },
    sessions: {
        body: `{{navigation}}<ul class="ui-card-list">{{#each sessions}}<li class="ui-card ui-section">{{summary}}{{form}}</li>{{/each}}</ul>{{form}}`,
        sample: { navigation: m('<nav></nav>'), sessions: [{ summary: 'Session started 2030-01-01T00:00:00.000Z', form: m('<form method="post"></form>') }], form: m('<form method="post"></form>') },
    },
    methods: {
        body: `{{navigation}}<h2>{{passkeysHeading}}</h2>{{#each passkeys}}{{form}}{{/each}}<h2>{{providersHeading}}</h2>{{#each identities}}{{form}}{{/each}}<p>{{note}}</p>`,
        sample: { navigation: m('<nav></nav>'), passkeysHeading: 'Passkeys', passkeys: [{ form: m('<form method="post"></form>') }], providersHeading: 'Linked providers', identities: [], note: 'The last sign-in method cannot be removed.' },
    },
    'step-up': { body: `{{navigation}}{{form}}{{passkey}}`, sample: { navigation: m('<nav></nav>'), form: m('<form method="post"></form>'), passkey: m('') } },
    status: {
        body: `<p role="{{#if alert}}alert{{else}}status{{/if}}"{{#if alert}} class="error"{{/if}}>{{message}}</p>{{#if href}}<p><a class="ui-button" href="{{href href}}">{{label}}</a></p>{{/if}}`,
        sample: { alert: false, message: 'Your email address has been verified.', href: '/account', label: 'Continue to your account' },
    },
    'totp-setup': { body: `<p>{{intro}} <code>{{secret}}</code></p>{{form}}`, sample: { intro: 'Add this key to your authenticator:', secret: 'JBSWY3DPEHPK3PXP', form: m('<form method="post"></form>') } },
    'recovery-codes': {
        body: `<p>{{intro}}</p><ul>{{#each codes}}<li><code>{{this}}</code></li>{{/each}}</ul><a href="{{href href}}">{{label}}</a>`,
        sample: { intro: 'Store these codes securely. Each can be used once.', codes: ['abcd-efgh', 'ijkl-mnop'], href: '/account', label: 'Continue to your account' },
    },
    signup: {
        body: `<p class="ui-progress">{{progressLabel}}</p>{{#if email}}<div class="ui-selected-identity"><span class="ui-identifier">{{email}}</span></div>{{/if}}{{#if intro}}<p class="ui-intro">{{intro}}</p>{{/if}}{{#if identifier}}<p class="ui-identifier">{{identifier}}</p>{{/if}}{{form}}{{passkey}}{{#if restart}}<details class="ui-disclosure"><summary>{{changeLabel}}</summary><p>{{restart.help}}</p>{{restart.form}}</details>{{/if}}<p class="ui-link-list">{{signInPrompt}} <a href="{{href signInHref}}">{{signInLabel}}</a></p>`,
        sample: { progressLabel: 'Step 1 of 3', stepsLabel: 'Account setup progress', steps: [{ number: 1, label: 'Email address', current: true }, { number: 2, label: 'Secure your account', current: false }], email: null, changeLabel: 'Change', intro: '', identifier: null, form: m('<form method="post"></form>'), passkey: m(''), restart: null, signInPrompt: 'Already have an account?', signInHref: '/account/login', signInLabel: 'Sign in' },
    },
    'recover-factor': { body: `{{#if intro}}<p>{{intro}}</p>{{/if}}{{form}}`, sample: { intro: 'We will send recovery instructions.', form: m('<form method="post"></form>') } },
    'restore-access': { body: `<p>{{intro}}</p>{{form}}`, sample: { intro: 'Choose a new password, then enroll a second factor.', form: m('<form method="post"></form>') } },
    'provider-enroll': { body: `{{form}}`, sample: { form: m('<form method="post"></form>') } },
    'provider-second-factor': { body: `{{form}}`, sample: { form: m('<form method="post"></form>') } },
};
/** Template sources with their view model samples, keyed by full template name. */
export const authTemplates: Readonly<Record<string, AuthTemplate>> = Object.freeze(Object.fromEntries(Object.entries(screens).map(([name, screen]) => [`auth/${name}`, Object.freeze({ source: declare(name, screen.body), sample: screen.sample })])));
export const authTemplateNames: readonly string[] = Object.freeze(Object.keys(authTemplates));
/**
 * What the host hands to `createUiExtension({ extensions: [authUiTemplates] })`. It also carries the
 * catalogue the host registers in `sources` and the view model samples, so `urlcode-ui --extensions
 * @jimhoyd/urlcode-auth` lists, ejects, previews and drift-checks these screens from this one export.
 */
export const authUiTemplates: ExtensionTemplates & { readonly name: 'auth'; readonly templates: Readonly<Record<string, string>>; readonly samples: Readonly<Record<string, ViewModel>> } = Object.freeze({
    name: 'auth',
    templates: Object.freeze(Object.fromEntries(Object.entries(authTemplates).map(([name, template]) => [name, template.source]))),
    catalogue: englishCatalogue,
    samples: Object.freeze(Object.fromEntries(Object.entries(authTemplates).map(([name, template]) => [name, template.sample]))),
});
