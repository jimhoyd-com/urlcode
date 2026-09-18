/**
 * The shipped partials, written in the kit's template language with shadcn/ui
 * markup and the kit's class names. Each declares the view model it expects.
 * Sample views drive `preview` and the accessibility checks.
 */
import type { ViewModel } from './template.ts';
import { markup } from './escape.ts';
export interface ShippedTemplate { readonly source: string; readonly sample: ViewModel }
export const kitTemplates: Readonly<Record<string, ShippedTemplate>> = Object.freeze({
    layout: {
        source: `{{!-- viewModel: layout@2 --}}<!doctype html>
<html lang="{{lang}}" dir="{{dir}}"><head><script nonce="{{nonce}}">{{themeBootstrap}}</script><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{title}}{{#if siteName}} · {{siteName}}{{/if}}</title>{{#if favicon}}<link rel="icon" href="{{href favicon}}">{{/if}}<link rel="stylesheet" href="{{href stylesheet}}">{{#if extraStylesheet}}<link rel="stylesheet" href="{{href extraStylesheet}}">{{/if}}<style nonce="{{nonce}}">{{themeCss}}</style></head>
<body class="ui-body" data-layout="{{layout}}">{{themeToggle}}<a class="ui-skip" href="#main">{{t "nav.skip"}}</a>
<header class="ui-header"><div class="ui-container ui-header-row">{{#if backTo}}<a class="ui-brand" href="{{href backTo}}">{{#if logo}}<img class="ui-logo" src="{{href logo}}" alt="" width="32" height="32">{{/if}}<span>{{#if siteName}}{{siteName}}{{else}}{{t "ui.backTo"}}{{/if}}</span></a>{{else}}<span class="ui-brand">{{#if logo}}<img class="ui-logo" src="{{href logo}}" alt="" width="32" height="32">{{/if}}<span>{{siteName}}</span></span>{{/if}}{{#if nav}}{{> nav}}{{/if}}{{#if menu}}{{> menu}}{{/if}}</div></header>
<main id="main" class="ui-container ui-main" tabindex="-1">{{#if showTitle}}<h1 class="ui-title">{{title}}</h1>{{/if}}{{#if flash}}{{> alert}}{{/if}}{{content}}</main>
{{#if footer}}<footer class="ui-container ui-footer">{{footer}}</footer>{{/if}}
{{#each scripts}}<script nonce="{{nonce}}" src="{{href this}}" defer></script>{{/each}}</body></html>`,
        sample: { layout:'default', showTitle:true, themeToggle:markup(''), themeBootstrap:markup(''), lang: 'en', dir: 'ltr', title: 'Sign in', siteName: 'Example', favicon: null, logo: null, backTo: '/', stylesheet: '/assets/ui/kit.css', extraStylesheet: null, nonce: 'sample', themeCss: '', nav: null, menu: null, flash: null, content: markup('<p>Content</p>'), footer: null, scripts: [] },
    },
    nav: {
        source: `{{!-- viewModel: nav@1 --}}<nav class="ui-nav" aria-label="Primary"><ul>{{#each nav}}<li><a href="{{href href}}"{{#if current}} aria-current="page"{{/if}}>{{label}}</a></li>{{/each}}</ul></nav>`,
        sample: { nav: [{ href: '/account', label: 'Overview', current: true }, { href: '/account/security', label: 'Security', current: false }] },
    },
    menu: {
        source: `{{!-- viewModel: menu@1 --}}<details class="ui-menu"><summary aria-label="{{t "ui.menu"}}"><span class="ui-avatar" aria-hidden="true">{{menu.initial}}</span><span class="ui-menu-name">{{menu.label}}</span></summary><ul class="ui-menu-list">{{#each menu.items}}<li><a href="{{href href}}">{{label}}</a></li>{{/each}}</ul></details>`,
        sample: { menu: { label: 'Ada', initial: 'A', items: [{ href: '/account', label: 'Account' }, { href: '/account/sign-out', label: 'Sign out' }] } },
    },
    card: {
        source: `{{!-- viewModel: card@1 --}}<section class="ui-card">{{#if cardTitle}}<header class="ui-card-header"><h2 class="ui-card-title">{{cardTitle}}</h2>{{#if cardDescription}}<p class="ui-card-description">{{cardDescription}}</p>{{/if}}</header>{{/if}}<div class="ui-card-content">{{cardContent}}</div>{{#if cardFooter}}<footer class="ui-card-footer">{{cardFooter}}</footer>{{/if}}</section>`,
        sample: { cardTitle: 'Welcome back', cardDescription: 'Enter your email to continue.', cardContent: markup('<p>Body</p>'), cardFooter: null },
    },
    form: {
        source: `{{!-- viewModel: form@1 --}}<form class="ui-form" method="post" action="{{href action}}" novalidate><input type="hidden" name="csrf" value="{{csrf}}">{{fields}}<div class="ui-form-actions"><button class="ui-button ui-button-primary" type="submit">{{submit}}</button>{{#if cancelHref}}<a class="ui-button ui-button-ghost" href="{{href cancelHref}}">{{cancelLabel}}</a>{{/if}}</div></form>`,
        sample: { action: '/account/sign-in', csrf: 'token', fields: markup(''), submit: 'Continue', cancelHref: null, cancelLabel: null },
    },
    field: {
        source: `{{!-- viewModel: field@1 --}}<div class="ui-field{{#if error}} ui-field-invalid{{/if}}"><label class="ui-label" for="{{id}}">{{label}}{{#if required}}{{else}} <span class="ui-muted">({{t "ui.field.optional"}})</span>{{/if}}</label><input class="ui-input" id="{{id}}" name="{{name}}" type="{{type}}"{{#if value}} value="{{value}}"{{/if}}{{#if autocomplete}} autocomplete="{{autocomplete}}"{{/if}}{{#if placeholder}} placeholder="{{placeholder}}"{{/if}}{{#if required}} required{{/if}}{{#if inputmode}} inputmode="{{inputmode}}"{{/if}} maxlength="1024"{{#if help}} aria-describedby="{{id}}-help"{{/if}}{{#if error}} aria-invalid="true" aria-errormessage="{{id}}-error"{{/if}}>{{#if help}}<p class="ui-help" id="{{id}}-help">{{help}}</p>{{/if}}{{#if error}}<p class="ui-error" id="{{id}}-error" role="alert">{{error}}</p>{{/if}}</div>`,
        sample: { id: 'email', name: 'email', label: 'Email address', type: 'email', value: null, autocomplete: 'username', placeholder: null, required: true, inputmode: null, help: null, error: null },
    },
    button: {
        source: `{{!-- viewModel: button@1 --}}{{#if href}}<a class="ui-button ui-button-{{variant}}" href="{{href href}}">{{label}}</a>{{else}}<button class="ui-button ui-button-{{variant}}" type="{{type}}"{{#if name}} name="{{name}}" value="{{value}}"{{/if}}>{{label}}</button>{{/if}}`,
        sample: { href: null, variant: 'primary', type: 'submit', name: null, value: null, label: 'Continue' },
    },
    alert: {
        source: `{{!-- viewModel: alert@1 --}}<div class="ui-alert ui-alert-{{flash.kind}}" role="{{#if flash.live}}alert{{else}}status{{/if}}"><p class="ui-alert-title">{{#if flash.title}}{{flash.title}}{{else}}{{#if flash.kind}}{{flash.kindLabel}}{{/if}}{{/if}}</p><p>{{flash.message}}</p></div>`,
        sample: { flash: { kind: 'info', kindLabel: 'Note', live: false, title: null, message: 'Check your email for a code.' } },
    },
    otp: {
        source: `{{!-- viewModel: otp@1 --}}<div class="ui-field ui-otp" data-ui-otp="{{digits}}"><label class="ui-label" for="{{id}}">{{#if label}}{{label}}{{else}}{{t "ui.otp.label"}}{{/if}}</label><input class="ui-input ui-otp-input" id="{{id}}" name="{{name}}" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{{{digits}}}" maxlength="{{digits}}" required aria-describedby="{{id}}-help"><p class="ui-help" id="{{id}}-help">{{t "ui.otp.help" count=digits}}</p></div>`,
        sample: { id: 'code', name: 'code', digits: 6, label: null },
    },
    table: {
        source: `{{!-- viewModel: table@1 --}}<div class="ui-table-wrap"><table class="ui-table">{{#if caption}}<caption>{{caption}}</caption>{{/if}}<thead><tr>{{#each columns}}<th scope="col">{{label}}</th>{{/each}}</tr></thead><tbody>{{#if rows}}{{#each rows}}<tr>{{#each cells}}<td>{{#if href}}<a href="{{href href}}">{{text}}</a>{{else}}{{text}}{{/if}}</td>{{/each}}</tr>{{/each}}{{else}}<tr><td class="ui-muted" colspan="{{columnCount}}">{{t "ui.table.empty"}}</td></tr>{{/if}}</tbody></table></div>`,
        sample: { caption: 'Sessions', columns: [{ label: 'Device' }, { label: 'Last seen' }], columnCount: 2, rows: [{ cells: [{ text: 'MacBook', href: '/account/sessions/1' }, { text: 'Today', href: null }] }] },
    },
    tabs: {
        source: `{{!-- viewModel: tabs@1 --}}<nav class="ui-tabs" aria-label="{{tabsLabel}}"><ul>{{#each tabs}}<li><a href="{{href href}}"{{#if current}} aria-current="page"{{/if}}>{{label}}</a></li>{{/each}}</ul></nav>`,
        sample: { tabsLabel: 'Sections', tabs: [{ href: '/account', label: 'Overview', current: true }, { href: '/account/sessions', label: 'Sessions', current: false }] },
    },
    empty: {
        source: `{{!-- viewModel: empty@1 --}}<div class="ui-empty"><p class="ui-empty-title">{{#if emptyTitle}}{{emptyTitle}}{{else}}{{t "ui.empty.title"}}{{/if}}</p>{{#if emptyMessage}}<p class="ui-muted">{{emptyMessage}}</p>{{/if}}{{#if actionHref}}<a class="ui-button ui-button-secondary" href="{{href actionHref}}">{{actionLabel}}</a>{{/if}}</div>`,
        sample: { emptyTitle: null, emptyMessage: 'Add a passkey to sign in without a password.', actionHref: '/account/passkeys/new', actionLabel: 'Add a passkey' },
    },
    pagination: {
        source: `{{!-- viewModel: pagination@1 --}}<nav class="ui-pagination" aria-label="Pagination">{{#if previousHref}}<a class="ui-button ui-button-ghost" href="{{href previousHref}}" rel="prev">{{t "ui.pagination.previous"}}</a>{{/if}}<span class="ui-muted">{{t "ui.pagination.page" page=page pages=pages}}</span>{{#if nextHref}}<a class="ui-button ui-button-ghost" href="{{href nextHref}}" rel="next">{{t "ui.pagination.next"}}</a>{{/if}}</nav>`,
        sample: { previousHref: null, nextHref: '/account/sessions?after=abc', page: 1, pages: 3 },
    },
    confirm: {
        source: `{{!-- viewModel: confirm@1 --}}<div class="ui-field" data-ui-confirm="{{confirmValue}}"><label class="ui-label" for="{{id}}">{{t "ui.confirmTyped" value=confirmValue}}</label><input class="ui-input" id="{{id}}" name="{{name}}" type="text" autocomplete="off" required maxlength="128"></div>`,
        sample: { id: 'confirm', name: 'confirm', confirmValue: 'DELETE' },
    },
});
export const kitTemplateNames: readonly string[] = Object.freeze(Object.keys(kitTemplates));
