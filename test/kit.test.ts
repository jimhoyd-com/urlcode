import test from 'node:test';
import assert from 'node:assert/strict';
import { createKit } from '../src/kit.ts';
import { createPresentation } from '../src/presentation.ts';
import { kitTemplates, kitTemplateNames } from '../src/partials.ts';
import { markup } from '../src/escape.ts';
import { kitCatalogue } from '../src/catalogue.ts';
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
    assert.throws(() => createKit({ presentation: createPresentation() }), /register kitCatalogue/);
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
