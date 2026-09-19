import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentation } from '../src/presentation.ts';
import type { Catalogue, ThemeVariables } from '../src/presentation.ts';
test('locale preferences only select configured catalogues with stable quality negotiation', () => {
    const presentation = createPresentation({ catalogues: { fr: { 'page.signIn': 'Connexion' }, ar: { 'page.signIn': 'دخول' }, 'pt-BR': { 'page.signIn': 'Entrar' } } });
    assert.equal(presentation.resolve({ acceptLanguage: 'de;q=1, fr-CA;q=0.8, ar;q=0.5' }).locale, 'fr');
    assert.equal(presentation.resolve({ accountLocale: 'ar', queryLocale: 'fr', acceptLanguage: 'en' }).dir, 'rtl');
    assert.equal(presentation.resolve({ queryLocale: '../../bad', acceptLanguage: 'fr;q=0, ar;q=0.2' }).locale, 'ar');
    assert.equal(presentation.resolve({ queryLocale: 'pt' }).locale, 'pt-BR');
    assert.equal(presentation.resolve({ acceptLanguage: 'x'.repeat(2049) }).locale, 'en');
    assert.equal(presentation.resolve({ queryLocale: 'fr' }).text('page.signIn'), 'Connexion');
    assert.equal(presentation.resolve({ queryLocale: 'fr' }).text('field.email'), 'Email address');
    assert.throws(() => createPresentation({ defaultLocale: 'fr' }), /no catalogue/);
});
test('plural categories use Intl rules and numbers, with explicit bounded values', () => {
    const p = createPresentation({ catalogues: { ar: { 'message.sessionCount': { zero: 'zero {count}', one: 'one', two: 'two', few: 'few {count}', many: 'many {count}', other: 'other {count}' } } } }).resolve({ accountLocale: 'ar' });
    assert.equal(p.text('message.sessionCount', { count: 2 }), 'two');
    assert.equal(p.text('message.sessionCount', { count: 4 }), 'few ' + new Intl.NumberFormat('ar').format(4));
    assert.throws(() => p.text('message.sessionCount'), /numeric/);
    assert.throws(() => p.text('message.sessionCount', { count: Infinity }), /Invalid/);
    assert.throws(() => p.text('missing.key'), /Unknown/);
});
test('themes and assets reject executable CSS, remote URLs, traversal and malformed paths', () => {
    const p = createPresentation({ theme: { '--auth-accent': '#123AbC', '--auth-radius': '8px' }, logo: '/assets/logo.svg', favicon: '/assets/icon.png' }).resolve();
    assert.equal(p.cssVariables, '--ui-accent:#123AbC;--ui-radius:8px');
    assert.equal(p.logo, '/assets/logo.svg');
    for (const theme of [{ '--auth-accent': 'red; background:url(https://evil.test)' }, { '--unknown': '#ffffff' }, { '--auth-radius': '9999px' }])
        assert.throws(() => createPresentation({ theme: theme as ThemeVariables }));
    for (const path of ['https://evil.test/a', '//evil.test', '/a/../b', '/a/%2e%2e', '/a?x=1', '/a"onload=alert(1)', '/a\\b'])
        assert.throws(() => createPresentation({ logo: path }));
});
test('catalogues are snapshots, plain text, and reject oversized or malformed input', () => {
    const catalogue: Catalogue = { 'page.signIn': '<img src=x onerror=alert(1)> {name}' };
    const p = createPresentation({ catalogues: { fr: catalogue } }).resolve({ queryLocale: 'fr' });
    catalogue['page.signIn'] = 'mutated';
    assert.equal(p.text('page.signIn', { name: '<script>' }), '<img src=x onerror=alert(1)> <script>'); // renderer must escape, never treat as markup
    assert.ok(Object.isFrozen(p));
    assert.throws(() => p.text('page.signIn'), /Missing/);
    assert.throws(() => createPresentation({ catalogues: { fr: { 'page.bad': 'x'.repeat(2049) } } }), /Invalid catalogue message/);
    assert.throws(() => createPresentation({ catalogues: { fr: { 'page.bad': { one: 'one' } } as unknown as Catalogue } }), /other/);
    assert.throws(() => createPresentation({ catalogues: { fr: { 'page.bad': '{bad-name}' } } }), /placeholder/);
    assert.throws(() => p.text('page.signIn', { name: 'x'.repeat(1025) }), /Invalid catalogue value/);
});
test('RTL derives from script rather than assuming all locales of a language share direction', () => {
    const p = createPresentation({ catalogues: { 'az-Arab': {}, 'az-Latn': {}, 'ar-Latn': {} } });
    assert.equal(p.resolve({ queryLocale: 'az-Arab' }).dir, 'rtl');
    assert.equal(p.resolve({ queryLocale: 'az-Latn' }).dir, 'ltr');
    assert.equal(p.resolve({ queryLocale: 'ar-Latn' }).dir, 'ltr');
});
