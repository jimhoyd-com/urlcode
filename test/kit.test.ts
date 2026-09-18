import test from 'node:test';
import assert from 'node:assert/strict';
import { createKit } from '../src/kit.ts';
import { createPresentation } from '../src/presentation.ts';
import { kitTemplates, kitTemplateNames } from '../src/partials.ts';
import { markup } from '../src/escape.ts';
import { kitCatalogue } from '../src/catalogue.ts';
import { kitCss, kitCssLimit } from '../src/kit-styles.ts';
const decode = (body: Uint8Array) => new TextDecoder().decode(body);
const header = (headers: [string, string][], name: string) => headers.find(([key]) => key === name)?.[1];
test('every shipped partial renders its sample with the kit catalogue and declares a view model', () => {
    const kit = createKit({ presentation: createPresentation({ defaults: kitCatalogue }) });
    const context = kit.resolveContext();
    for (const name of kitTemplateNames) {
        const info = kit.info(name)!;
        assert.equal(info.origin, 'kit');
        assert.match(info.viewModel ?? '', new RegExp(`^${name}@\\d+$`), `${name} declares its view model`);
        const html = name === 'layout' ? decode(kit.wrap(markup('<p>x</p>'), { title: 'T', context }).body) : kit.render(name, kitTemplates[name]!.sample, context).html;
        assert.ok(html.length > 0, `${name} renders`);
        assert.doesNotMatch(html, /\{\{/, `${name} leaves no unrendered expression`);
    }
});
test('pages are complete documents with lang, dir, theme, stylesheet, nonce-bound scripts and a strict CSP', () => {
    const presentation = createPresentation({ defaults: kitCatalogue, catalogues: { ar: {} }, theme: { '--ui-accent': '#123456' } });
    const kit = createKit({ presentation, theme: { name: 'Acme', logo: '/logo.svg', backTo: '/', colors: { primary: '24 95% 53%' } }, assetsBase: '/assets/ui' });
    const page = kit.page('card', kitTemplates.card!.sample, { title: 'Welcome', preferences: { queryLocale: 'ar' }, scripts: ['otp'], nav: [{ href: '/account', label: 'Overview', current: true }], menu: { label: 'Ada', items: [{ href: '/account/sign-out', label: 'Sign out' }] }, flash: { kind: 'error', message: 'Wrong code' } });
    const html = decode(page.body);
    assert.equal(page.status, 200);
    assert.match(html, /^<!doctype html>\n<html lang="ar" dir="rtl">/);
    assert.match(html, /<link rel="stylesheet" href="\/assets\/ui\/kit\.[0-9a-f]{12}\.css">/);
    assert.match(html, /<style nonce="[A-Za-z0-9+/=]+">:root\{--ui-accent:#123456\}:root\{--primary:24 95% 53%\}<\/style>/);
    assert.match(html, /<script nonce="([A-Za-z0-9+/=]+)" src="\/assets\/ui\/otp\.[0-9a-f]{12}\.js" defer><\/script>/);
    const nonce = /<style nonce="([^"]+)"/.exec(html)![1]!;
    const csp = header(page.headers, 'content-security-policy')!;
    assert.ok(csp.includes(`script-src 'nonce-${nonce}'`) && csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'"));
    assert.equal(header(page.headers, 'cache-control'), 'no-store');
    assert.equal(header(page.headers, 'content-language'), 'ar');
    assert.match(html, /<a class="ui-brand" href="\/"><img class="ui-logo" src="\/logo\.svg"/);
    assert.match(html, /aria-current="page">Overview</);
    assert.match(html, /<div class="ui-alert ui-alert-error" role="alert"><p class="ui-alert-title">Error<\/p><p>Wrong code<\/p>/);
    assert.match(html, /<main id="main" class="ui-container ui-main" tabindex="-1"><h1 class="ui-title">Welcome<\/h1>/);
    assert.throws(() => kit.page('card', kitTemplates.card!.sample, { title: 'x', scripts: ['evil'] }), /Unknown kit script/);
});
test('project templates shadow extension and kit templates; extensions may only add under their namespace; behind view models are reported', () => {
    const presentation = createPresentation({ defaults: { ...kitCatalogue, 'auth.title': 'Sign in' }, catalogues: { fr: { 'auth.title': 'Connexion' } } });
    const kit = createKit({
        presentation,
        extensions: [{ name: 'auth', templates: { 'auth/sign-in': '{{!-- viewModel: auth/sign-in@2 --}}<form>{{t "auth.title"}}</form>' } }],
        templates: { 'auth/sign-in': '{{!-- viewModel: auth/sign-in@1 --}}<section class="mine">{{t "auth.title"}}</section>', card: '<div class="my-card">{{cardContent}}</div>' },
    });
    assert.equal(kit.info('auth/sign-in')!.origin, 'project');
    assert.equal(kit.render('auth/sign-in', {}, kit.resolveContext({ queryLocale: 'fr' })).html, '<section class="mine">Connexion</section>');
    assert.equal(kit.render('card', { cardContent: markup('<p>x</p>') }, kit.resolveContext()).html, '<div class="my-card"><p>x</p></div>');
    const report = kit.report();
    assert.deepEqual(report.overrides.map(entry => entry.name), ['auth/sign-in', 'card']);
    assert.deepEqual(report.behind.map(entry => [entry.name, entry.viewModel, entry.expected]), [['auth/sign-in', 'auth/sign-in@1', 'auth/sign-in@2'], ['card', undefined, 'card@1']]);
    assert.deepEqual(report.languages.map(language => [language.locale, language.missing.length > 0]), [['fr', true]]);
    assert.throws(() => createKit({ presentation, extensions: [{ name: 'auth', templates: { layout: '<html>' } }] }), /cannot replace kit template/);
    assert.throws(() => createKit({ presentation, templates: { 'Bad Name': 'x' } }), /invalid template name/);
    assert.throws(() => createKit({ presentation: createPresentation(), extensions: [{ name: 'auth', templates: { 'auth/x': '{{t "auth.missing"}}' } }] }), /presentation lacks/);
});
test('the stylesheet can be appended to or replaced, and asset names change with content', () => {
    const presentation = createPresentation({ defaults: kitCatalogue });
    const base = createKit({ presentation });
    const appended = createKit({ presentation, stylesheet: { append: '.mine{color:red}' } });
    const replaced = createKit({ presentation, stylesheet: { replace: 'body{margin:0}' } });
    assert.notEqual(base.assets[0]!.name, appended.assets[0]!.name);
    assert.ok(appended.assets[0]!.body.endsWith('.mine{color:red}'));
    assert.equal(replaced.assets[0]!.body, 'body{margin:0}');
    assert.match(decode(replaced.wrap(markup(''), { title: 'x' }).body), new RegExp(`/assets/ui/${replaced.assets[0]!.name.replace('.', '\\.')}`));
    assert.throws(() => createKit({ presentation, assetsBase: 'assets' }), /absolute path/);
});
test('rendered pages carry the accessibility basics: skip link, main landmark, labelled inputs, alert roles, current-page markers', () => {
    const kit = createKit({ presentation: createPresentation({ defaults: kitCatalogue }) });
    const context = kit.resolveContext();
    const field = kit.render('field', { ...kitTemplates.field!.sample, help: 'We never share it', error: 'Enter an address' }, context).html;
    assert.match(field, /<label class="ui-label" for="email">/);
    assert.match(field, /aria-describedby="email-help"/);
    assert.match(field, /aria-invalid="true" aria-errormessage="email-error"/);
    assert.match(field, /<p class="ui-error" id="email-error" role="alert">/);
    const otp = kit.render('otp', kitTemplates.otp!.sample, context).html;
    assert.match(otp, /pattern="\[0-9\]\{6\}" maxlength="6"/);
    assert.match(otp, /autocomplete="one-time-code"/);
    const html = decode(kit.wrap(markup('<p>x</p>'), { title: 'T', context }).body);
    assert.match(html, /<a class="ui-skip" href="#main">Skip to content<\/a>/);
    const table = kit.render('table', { ...kitTemplates.table!.sample, rows: [] }, context).html;
    assert.match(table, /<td class="ui-muted" colspan="2">No rows<\/td>/);
});

test('the kit catalogue is merged by default: a host presentation without ui.* keys renders the layout, and its own keys win', () => {
    const host = createPresentation({ defaults: { 'auth.title': 'Sign in', 'ui.signOut': 'Leave' }, catalogues: { fr: { 'auth.title': 'Connexion' } } });
    const kit = createKit({ presentation: host, theme: { backTo: '/' } });
    assert.ok(Object.hasOwn(kit.presentation.english, 'ui.backTo') && Object.hasOwn(kit.presentation.english, 'auth.title'));
    assert.equal(kit.presentation.english['ui.signOut'], 'Leave', 'the host key wins over the kit default');
    const context = kit.resolveContext({ queryLocale: 'fr' });
    assert.equal(context.text('auth.title'), 'Connexion');
    assert.equal(context.text('ui.backTo'), 'Back to site');
    assert.equal(context.text('ui.signOut'), 'Leave');
    assert.ok(context.has('ui.close') && !context.has('ui.nope'));
    assert.throws(() => context.text('ui.nope'), /Unknown catalogue key/);
    // A context resolved by the host's own presentation, handed to the kit, is completed the same way.
    const html = decode(kit.wrap(markup('<p>x</p>'), { title: 'T', context: host.resolve(), flash: { kind: 'info', message: 'Hi' } }).body);
    assert.match(html, /Back to site/);
    assert.match(html, /<p class="ui-alert-title">Note<\/p>/);
    assert.equal(decode(kit.wrap(markup(''), { title: 'T', context: host.resolve({ queryLocale: 'fr' }) }).body).match(/lang="fr"/)?.length, 1);
    // A presentation that already carries the kit catalogue is used as is.
    const complete = createPresentation({ defaults: kitCatalogue });
    assert.equal(createKit({ presentation: complete }).presentation, complete);
});
test('extension-owned scripts render nonce-bound beside kit scripts; foreign, absolute and schemed sources and the count limit are refused', () => {
    const kit = createKit({ presentation: createPresentation({ defaults: kitCatalogue }) });
    const page = kit.wrap(markup(''), { title: 'T', scripts: ['confirm', { src: '/account/static/passkeys.js' }, { src: '/account/static/vendor.js?v=2', integrity: 'sha384-' + 'A'.repeat(64) }] });
    const html = decode(page.body);
    const nonce = /<style nonce="([^"]+)"/.exec(html)![1]!;
    assert.match(html, new RegExp(`<script nonce="${nonce.replace(/[+/]/g, '\\$&')}" src="/assets/ui/confirm\\.[0-9a-f]{12}\\.js" defer></script><script nonce="${nonce.replace(/[+/]/g, '\\$&')}" src="/account/static/passkeys\\.js" defer></script><script nonce="${nonce.replace(/[+/]/g, '\\$&')}" src="/account/static/vendor\\.js\\?v=2" integrity="sha384-A{64}" defer></script></body></html>$`));
    assert.ok(header(page.headers, 'content-security-policy')!.includes(`script-src 'nonce-${nonce}'`));
    for (const src of ['https://cdn.example.test/lib.js', '//cdn.example.test/lib.js', 'javascript:alert(1)', 'static/passkeys.js', '/bad path.js', '/x"onload="1', '', '/' + 'a'.repeat(2048)])
        assert.throws(() => kit.wrap(markup(''), { title: 'T', scripts: [{ src }] }), /same-site path/, src || '(empty)');
    assert.throws(() => kit.wrap(markup(''), { title: 'T', scripts: [{ src: '/a.js', integrity: 'md5-abc' }] }), /integrity/);
    assert.throws(() => kit.wrap(markup(''), { title: 'T', scripts: [{ src: '/a.js', integrity: 'sha256-<b>' }] }), /integrity/);
    assert.throws(() => kit.wrap(markup(''), { title: 'T', scripts: [42 as never] }), /kit script name or an extension script/);
    assert.equal((decode(kit.wrap(markup(''), { title: 'T', scripts: Array.from({ length: 8 }, (_, i) => ({ src: `/s${i}.js` })) }).body).match(/<script [^>]*src=/g) ?? []).length, 8);
    assert.throws(() => kit.wrap(markup(''), { title: 'T', scripts: Array.from({ length: 9 }, () => ({ src: '/s.js' })) }), /exceed limit/);
    assert.throws(() => kit.wrap(markup(''), { title: 'T', scripts: ['otp', 'nope'] }), /Unknown kit script/);
});
test('navigation items carry icons in the header nav; the application layout hides the header chrome and title for the page shell; the bounds hold', () => {
    const kit = createKit({ presentation: createPresentation({ defaults: kitCatalogue }), theme: { backTo: '/' } });
    const options = { title: 'Overview', nav: [{ href: '/admin', label: 'Overview', current: true, icon: 'home' as const }, { href: '/admin/users', label: 'Users' }], menu: { label: 'Ada', items: [{ href: '/account', label: 'Account' }] }, flash: { kind: 'success' as const, message: 'Saved' } };
    const standard = decode(kit.wrap(markup('<p>body</p>'), options).body);
    assert.match(standard, /<body class="ui-body" data-layout="default">/);
    assert.match(standard, /<header class="ui-header">.*<nav class="ui-nav" aria-label="Primary"><ul><li><a href="\/admin" aria-current="page"><svg class="ui-icon"[^>]*aria-hidden="true" focusable="false">.*?<\/svg>Overview<\/a><\/li><li><a href="\/admin\/users">Users<\/a><\/li><\/ul><\/nav>/);
    assert.match(standard, /<h1 class="ui-title">Overview<\/h1>/);
    const application = decode(kit.wrap(markup('<div class="ui-shell"><aside class="ui-sidebar"></aside><div class="ui-content"><h1>Overview</h1></div></div>'), { ...options, layout: 'application' }).body);
    assert.match(application, /<body class="ui-body" data-layout="application">/);
    assert.doesNotMatch(application, /<h1 class="ui-title">/);
    assert.equal((application.match(/<h1[ >]/g) ?? []).length, 1);
    assert.match(application, /<a class="ui-skip" href="#main">Skip to content<\/a>/);
    assert.throws(() => kit.wrap(markup(''), { title: 'T', layout: 'sidebar' as never }), /Invalid page layout/);
    assert.throws(() => kit.wrap(markup(''), { title: 'T', nav: [{ href: '/', label: 'x', icon: 'evil' as never }] }), /Unknown icon/);
    assert.throws(() => kit.wrap(markup(''), { title: 'T', nav: Array.from({ length: 101 }, () => ({ href: '/', label: 'x' })) }), /Too many navigation items/);
    assert.ok(!kitTemplateNames.includes('layout-application'));
    assert.equal(kit.info('nav')!.viewModel, 'nav@2');
    assert.equal(kit.info('layout')!.viewModel, 'layout@2');
});
test('doctor reports an ejected layout or nav behind the bumped view model and an unchanged ejected partial as current', () => {
    const presentation = createPresentation({ defaults: kitCatalogue });
    const kit = createKit({ presentation, templates: { layout: kitTemplates.layout!.source.replace('layout@2', 'layout@1'), card: kitTemplates.card!.source, nav: kitTemplates.nav!.source.replace('nav@2', 'nav@1') } });
    assert.deepEqual(kit.report().behind.map(entry => [entry.name, entry.viewModel, entry.expected]), [['layout', 'layout@1', 'layout@2'], ['nav', 'nav@1', 'nav@2']]);
    assert.deepEqual(kit.report().overrides.map(entry => entry.name), ['card', 'layout', 'nav']);
});
test('the kit stylesheet carries the console layout classes for light and dark and stays under its size limit', () => {
    for (const name of ['ui-shell', 'ui-sidebar', 'ui-sidebar-nav', 'ui-content', 'ui-page-header', 'ui-metrics', 'ui-metric', 'ui-definition-grid', 'ui-badge', 'ui-list', 'ui-toolbar', 'ui-section-heading', 'ui-danger-zone', 'ui-form-grid', 'ui-actions', 'ui-activity', 'ui-chart', 'ui-chart-legend', 'ui-chart-key', 'ui-filter', 'ui-icon', 'ui-nav-link', 'ui-sidebar-footer'])
        assert.ok(kitCss.includes(`.${name}{`) || kitCss.includes(`.${name} `) || kitCss.includes(`.${name}>`) || kitCss.includes(`.${name},`), name);
    for (const token of ['--sidebar', '--sidebar-foreground'])
        assert.equal((kitCss.match(new RegExp(`${token}:`, 'g')) ?? []).length, 3, `${token} is set for light, the dark media query and .dark`);
    assert.doesNotMatch(kitCss, /var\(--ui-|@import|url\(|<\/style|expression\(|javascript:/);
    assert.ok(new TextEncoder().encode(kitCss).length <= kitCssLimit);
});
test('kit compact pages share the nonce-bound accessible theme toggle and flag older layouts',()=>{
 const presentation=createPresentation({defaults:kitCatalogue});
 const kit=createKit({presentation});
 const page=kit.wrap(markup('<form></form>'),{title:'Sign in',layout:'compact'});
 const html=decode(page.body);
 assert.match(html,/data-layout="compact"/);
 assert.match(html,/<h1 class="ui-title">Sign in<\/h1>/);
 const app=decode(kit.wrap(markup('<h1>Users</h1>'),{title:'Users',layout:'application'}).body);
 assert.equal((app.match(/<h1[ >]/g)??[]).length,1);
 assert.match(app,/<h1>Users<\/h1>/);
 assert.match(html,/class="ui-theme-toggle"/);
 assert.match(html,/aria-label="Switch to dark mode"/);
 assert.doesNotMatch(html,/<select/);
 const token=html.match(/<script nonce="([^"]+)"/)!;
 assert.ok(token);assert.ok(header(page.headers,'content-security-policy')?.includes(`'nonce-${token[1]}'`));
 const overridden=createKit({presentation,templates:{layout:'{{!-- viewModel: layout@1 --}}<main>{{content}}</main>'}});
 assert.equal(overridden.info('layout')?.behind,true);
 assert.throws(()=>kit.wrap(markup(''),{title:'T',layout:'invalid' as 'compact'}),/Invalid page layout/);
});
