/**
 * The shipped partials, written in the kit's template language with shadcn/ui
 * markup and the kit's class names. Each declares the view model it expects.
 * Sample views drive `preview` and the accessibility checks.
 */
import type { ViewModel } from './template.ts';
import { markup } from './escape.ts';
import { icon } from './icons.ts';
export interface ShippedTemplate { readonly source: string; readonly sample: ViewModel }
export const kitTemplates: Readonly<Record<string, ShippedTemplate>> = Object.freeze({
    layout: {
        source: `{{!-- viewModel: layout@3 --}}<!doctype html>
<html lang="{{lang}}" dir="{{dir}}"><head><script nonce="{{nonce}}">{{themeBootstrap}}</script><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{{title}}{{#if siteName}} · {{siteName}}{{/if}}</title>{{#if favicon}}<link rel="icon" href="{{href favicon}}">{{/if}}<link rel="stylesheet" href="{{href stylesheet}}">{{#if extraStylesheet}}<link rel="stylesheet" href="{{href extraStylesheet}}">{{/if}}<style nonce="{{nonce}}">{{themeCss}}</style></head>
<body class="ui-body" data-layout="{{layout}}">{{themeToggle}}<a class="ui-skip" href="#main">{{t "nav.skip"}}</a>
{{#if application}}<div class="ui-shell" data-slot="sidebar-wrapper"><aside class="ui-sidebar" data-slot="sidebar">{{#if backTo}}<a class="ui-brand" href="{{href backTo}}">{{#if logo}}<img class="ui-logo" src="{{href logo}}" alt="" width="32" height="32">{{/if}}<span>{{#if siteName}}{{siteName}}{{else}}{{t "ui.backTo"}}{{/if}}</span></a>{{else}}<span class="ui-brand">{{#if logo}}<img class="ui-logo" src="{{href logo}}" alt="" width="32" height="32">{{/if}}<span>{{siteName}}</span></span>{{/if}}{{#if nav}}{{> nav}}{{/if}}{{#if menu}}<div class="ui-sidebar-footer" data-slot="sidebar-footer">{{> menu}}</div>{{/if}}</aside><div class="ui-content" data-slot="sidebar-inset" id="main" tabindex="-1"><header class="ui-page-header" data-slot="page-header"><h1>{{title}}</h1></header>{{#if flash}}{{> alert}}{{/if}}{{content}}</div></div>{{else}}<header class="ui-header"><div class="ui-container ui-header-row">{{#if backTo}}<a class="ui-brand" href="{{href backTo}}">{{#if logo}}<img class="ui-logo" src="{{href logo}}" alt="" width="32" height="32">{{/if}}<span>{{#if siteName}}{{siteName}}{{else}}{{t "ui.backTo"}}{{/if}}</span></a>{{else}}<span class="ui-brand">{{#if logo}}<img class="ui-logo" src="{{href logo}}" alt="" width="32" height="32">{{/if}}<span>{{siteName}}</span></span>{{/if}}{{#if nav}}{{> nav}}{{/if}}{{#if menu}}{{> menu}}{{/if}}</div></header>
<main id="main" class="ui-container ui-main" tabindex="-1"><h1 class="ui-title">{{title}}</h1>{{#if flash}}{{> alert}}{{/if}}{{content}}</main>{{/if}}
{{#if footer}}<footer class="ui-container ui-footer">{{footer}}</footer>{{/if}}
{{#each scripts}}<script nonce="{{nonce}}" src="{{href src}}"{{#if integrity}} integrity="{{integrity}}"{{/if}}{{#if async}} async{{else}} defer{{/if}}></script>{{/each}}</body></html>`,
        sample: { layout:'default', application:false, themeToggle:markup(''), themeBootstrap:markup(''), lang: 'en', dir: 'ltr', title: 'Sign in', siteName: 'Example', favicon: null, logo: null, backTo: '/', stylesheet: '/assets/ui/kit.css', extraStylesheet: null, nonce: 'sample', themeCss: '', nav: null, menu: null, flash: null, content: markup('<p>Content</p>'), footer: null, scripts: [{ src: '/assets/ui/otp.js', integrity: null, async: false }] },
    },
    nav: {
        source: `{{!-- viewModel: nav@2 --}}<nav class="ui-nav" data-slot="sidebar-group" aria-label="Primary"><ul data-slot="sidebar-menu">{{#each nav}}<li data-slot="sidebar-menu-item"><a data-slot="sidebar-menu-button" href="{{href href}}"{{#if current}} aria-current="page"{{/if}}>{{#if icon}}{{icon}}{{/if}}{{label}}</a></li>{{/each}}</ul></nav>`,
        sample: { nav: [{ href: '/account', label: 'Overview', current: true, icon: markup(icon('user')) }, { href: '/account/security', label: 'Security', current: false, icon: null }] },
    },
    menu: {
        source: `{{!-- viewModel: menu@1 --}}<details class="ui-menu" data-slot="dropdown-menu"><summary data-slot="dropdown-menu-trigger" aria-label="{{t "ui.menu"}}"><span class="ui-avatar" data-slot="avatar"><span data-slot="avatar-fallback" aria-hidden="true">{{menu.initial}}</span></span><span class="ui-menu-name">{{menu.label}}</span></summary><ul class="ui-menu-list" data-slot="dropdown-menu-content">{{#each menu.items}}<li data-slot="dropdown-menu-group"><a data-slot="dropdown-menu-item" href="{{href href}}">{{label}}</a></li>{{/each}}</ul></details>`,
        sample: { menu: { label: 'Ada', initial: 'A', items: [{ href: '/account', label: 'Account' }, { href: '/account/sign-out', label: 'Sign out' }] } },
    },
    card: {
        source: `{{!-- viewModel: card@1 --}}<section class="ui-card" data-slot="card">{{#if cardTitle}}<header class="ui-card-header" data-slot="card-header"><h2 class="ui-card-title" data-slot="card-title">{{cardTitle}}</h2>{{#if cardDescription}}<p class="ui-card-description" data-slot="card-description">{{cardDescription}}</p>{{/if}}</header>{{/if}}<div class="ui-card-content" data-slot="card-content">{{cardContent}}</div>{{#if cardFooter}}<footer class="ui-card-footer" data-slot="card-footer">{{cardFooter}}</footer>{{/if}}</section>`,
        sample: { cardTitle: 'Welcome back', cardDescription: 'Enter your email to continue.', cardContent: markup('<p>Body</p>'), cardFooter: null },
    },
    form: {
        source: `{{!-- viewModel: form@1 --}}<form class="ui-form" data-slot="field-group" method="post" action="{{href action}}" novalidate><input type="hidden" name="csrf" value="{{csrf}}">{{fields}}<div class="ui-form-actions" data-slot="field"><button class="ui-button ui-button-primary" data-slot="button" type="submit">{{submit}}</button>{{#if cancelHref}}<a class="ui-button ui-button-ghost" data-slot="button" href="{{href cancelHref}}">{{cancelLabel}}</a>{{/if}}</div></form>`,
        sample: { action: '/account/sign-in', csrf: 'token', fields: markup(''), submit: 'Continue', cancelHref: null, cancelLabel: null },
    },
    field: {
        source: `{{!-- viewModel: field@1 --}}<div class="ui-field{{#if error}} ui-field-invalid{{/if}}" data-slot="field"{{#if error}} data-invalid="true"{{/if}}><label class="ui-label" data-slot="field-label" for="{{id}}">{{label}}{{#if required}}{{else}} <span class="ui-muted">({{t "ui.field.optional"}})</span>{{/if}}</label><input class="ui-input" data-slot="input" id="{{id}}" name="{{name}}" type="{{type}}"{{#if value}} value="{{value}}"{{/if}}{{#if autocomplete}} autocomplete="{{autocomplete}}"{{/if}}{{#if placeholder}} placeholder="{{placeholder}}"{{/if}}{{#if required}} required{{/if}}{{#if inputmode}} inputmode="{{inputmode}}"{{/if}} maxlength="1024"{{#if help}} aria-describedby="{{id}}-help"{{/if}}{{#if error}} aria-invalid="true" aria-errormessage="{{id}}-error"{{/if}}>{{#if help}}<p class="ui-help" data-slot="field-description" id="{{id}}-help">{{help}}</p>{{/if}}{{#if error}}<p class="ui-error" data-slot="field-error" id="{{id}}-error" role="alert">{{error}}</p>{{/if}}</div>`,
        sample: { id: 'email', name: 'email', label: 'Email address', type: 'email', value: null, autocomplete: 'username', placeholder: null, required: true, inputmode: null, help: null, error: null },
    },
    textarea: {
        source: `{{!-- viewModel: textarea@1 --}}<div class="ui-field{{#if error}} ui-field-invalid{{/if}}" data-slot="field"{{#if error}} data-invalid="true"{{/if}}><label class="ui-label" data-slot="field-label" for="{{id}}">{{label}}{{#if required}}{{else}} <span class="ui-muted">({{t "ui.field.optional"}})</span>{{/if}}</label><textarea class="ui-input ui-textarea" data-slot="textarea" id="{{id}}" name="{{name}}" rows="{{rows}}"{{#if placeholder}} placeholder="{{placeholder}}"{{/if}}{{#if required}} required{{/if}} maxlength="{{maxlength}}"{{#if help}} aria-describedby="{{id}}-help"{{/if}}{{#if error}} aria-invalid="true" aria-errormessage="{{id}}-error"{{/if}}>
{{value}}</textarea>{{#if help}}<p class="ui-help" data-slot="field-description" id="{{id}}-help">{{help}}</p>{{/if}}{{#if error}}<p class="ui-error" data-slot="field-error" id="{{id}}-error" role="alert">{{error}}</p>{{/if}}</div>`,
        sample: { id: 'content', name: 'content', label: 'Content', value: null, rows: 6, placeholder: null, required: true, maxlength: 4096, help: null, error: null },
    },
    select: {
        source: `{{!-- viewModel: select@1 --}}<div class="ui-field{{#if error}} ui-field-invalid{{/if}}" data-slot="field"{{#if error}} data-invalid="true"{{/if}}><label class="ui-label" data-slot="field-label" for="{{id}}">{{label}}{{#if required}}{{else}} <span class="ui-muted">({{t "ui.field.optional"}})</span>{{/if}}</label><select class="ui-input ui-select" data-slot="select" id="{{id}}" name="{{name}}"{{#if required}} required{{/if}}{{#if help}} aria-describedby="{{id}}-help"{{/if}}{{#if error}} aria-invalid="true" aria-errormessage="{{id}}-error"{{/if}}>{{#if placeholder}}<option value="">{{placeholder}}</option>{{/if}}{{#each options}}<option value="{{value}}"{{#if selected}} selected{{/if}}{{#if disabled}} disabled{{/if}}>{{label}}</option>{{/each}}</select>{{#if help}}<p class="ui-help" data-slot="field-description" id="{{id}}-help">{{help}}</p>{{/if}}{{#if error}}<p class="ui-error" data-slot="field-error" id="{{id}}-error" role="alert">{{error}}</p>{{/if}}</div>`,
        sample: { id: 'status', name: 'status', label: 'Status', placeholder: 'Choose a status', required: true, help: null, error: null, options: [{ value: 'draft', label: 'Draft', selected: false, disabled: false }, { value: 'published', label: 'Published', selected: true, disabled: false }] },
    },
    button: {
        source: `{{!-- viewModel: button@1 --}}{{#if href}}<a class="ui-button ui-button-{{variant}}" data-slot="button" href="{{href href}}">{{label}}</a>{{else}}<button class="ui-button ui-button-{{variant}}" data-slot="button" type="{{type}}"{{#if name}} name="{{name}}" value="{{value}}"{{/if}}>{{label}}</button>{{/if}}`,
        sample: { href: null, variant: 'primary', type: 'submit', name: null, value: null, label: 'Continue' },
    },
    alert: {
        source: `{{!-- viewModel: alert@1 --}}<div class="ui-alert ui-alert-{{flash.kind}}" data-slot="alert" role="{{#if flash.live}}alert{{else}}status{{/if}}"><p class="ui-alert-title" data-slot="alert-title">{{#if flash.title}}{{flash.title}}{{else}}{{#if flash.kind}}{{flash.kindLabel}}{{/if}}{{/if}}</p><p data-slot="alert-description">{{flash.message}}</p></div>`,
        sample: { flash: { kind: 'info', kindLabel: 'Note', live: false, title: null, message: 'Check your email for a code.' } },
    },
    otp: {
        source: `{{!-- viewModel: otp@1 --}}<div class="ui-field ui-otp" data-ui-otp="{{digits}}"><label class="ui-label" for="{{id}}">{{#if label}}{{label}}{{else}}{{t "ui.otp.label"}}{{/if}}</label><input class="ui-input ui-otp-input" id="{{id}}" name="{{name}}" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{{{digits}}}" maxlength="{{digits}}" required aria-describedby="{{id}}-help"><p class="ui-help" id="{{id}}-help">{{t "ui.otp.help" count=digits}}</p></div>`,
        sample: { id: 'code', name: 'code', digits: 6, label: null },
    },
    table: {
        source: `{{!-- viewModel: table@1 --}}<div class="ui-table-wrap" data-slot="table-container"><table class="ui-table" data-slot="table">{{#if caption}}<caption data-slot="table-caption">{{caption}}</caption>{{/if}}<thead data-slot="table-header"><tr data-slot="table-row">{{#each columns}}<th data-slot="table-head" scope="col">{{label}}</th>{{/each}}</tr></thead><tbody data-slot="table-body">{{#if rows}}{{#each rows}}<tr data-slot="table-row">{{#each cells}}<td data-slot="table-cell">{{#if href}}<a href="{{href href}}">{{text}}</a>{{else}}{{text}}{{/if}}</td>{{/each}}</tr>{{/each}}{{else}}<tr data-slot="table-row"><td class="ui-muted" data-slot="table-cell" colspan="{{columnCount}}">{{t "ui.table.empty"}}</td></tr>{{/if}}</tbody></table></div>`,
        sample: { caption: 'Sessions', columns: [{ label: 'Device' }, { label: 'Last seen' }], columnCount: 2, rows: [{ cells: [{ text: 'MacBook', href: '/account/sessions/1' }, { text: 'Today', href: null }] }] },
    },
    tabs: {
        source: `{{!-- viewModel: tabs@1 --}}<nav class="ui-tabs" aria-label="{{tabsLabel}}"><ul>{{#each tabs}}<li><a href="{{href href}}"{{#if current}} aria-current="page"{{/if}}>{{label}}</a></li>{{/each}}</ul></nav>`,
        sample: { tabsLabel: 'Sections', tabs: [{ href: '/account', label: 'Overview', current: true }, { href: '/account/sessions', label: 'Sessions', current: false }] },
    },
    empty: {
        source: `{{!-- viewModel: empty@1 --}}<div class="ui-empty" data-slot="empty"><header data-slot="empty-header"><p class="ui-empty-title" data-slot="empty-title">{{#if emptyTitle}}{{emptyTitle}}{{else}}{{t "ui.empty.title"}}{{/if}}</p>{{#if emptyMessage}}<p class="ui-muted" data-slot="empty-description">{{emptyMessage}}</p>{{/if}}</header>{{#if actionHref}}<div data-slot="empty-content"><a class="ui-button ui-button-secondary" data-slot="button" href="{{href actionHref}}">{{actionLabel}}</a></div>{{/if}}</div>`,
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
