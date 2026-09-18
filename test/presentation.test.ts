import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentation } from '../src/presentation.ts';
import { compareCatalogues, mergeCatalogues, kitCatalogue } from '../src/catalogue.ts';
const defaults = { 'auth.page.signIn': 'Sign in', 'auth.field.email': 'Email address', 'auth.sessions.count': { one: '{count} session', other: '{count} sessions' } };
test('the context reports key presence and formats dates and numbers for the negotiated locale', () => {
    const presentation = createPresentation({ defaults, catalogues: { ar: { 'auth.page.signIn': 'دخول' } } });
    const english = presentation.resolve(), arabic = presentation.resolve({ accountLocale: 'ar' });
    assert.ok(english.has('auth.page.signIn') && english.has('nav.skip') && !english.has('missing.key'));
    assert.equal(arabic.formatNumber(1234.5), new Intl.NumberFormat('ar').format(1234.5));
    assert.equal(english.formatDate('2026-09-18T10:30:00Z', 'date'), new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date('2026-09-18T10:30:00Z')));
    assert.throws(() => english.formatDate('nope'), /Invalid date/);
    assert.throws(() => english.formatNumber(Infinity), /Invalid number/);
    assert.equal(presentation.defaultLocale, 'en');
    assert.ok(Object.hasOwn(presentation.english, 'auth.field.email'));
});
test('coverage reports the keys a language lacks and placeholder mismatches; untranslated keys fall back to English', () => {
    const presentation = createPresentation({ defaults, catalogues: { fr: { 'auth.page.signIn': 'Connexion', 'auth.sessions.count': { one: 'une session', other: '{count} sessions' } } } });
    const coverage = presentation.coverage('fr');
    assert.ok(coverage.missing.includes('auth.field.email') && coverage.missing.includes('nav.skip'));
    assert.deepEqual(coverage.mismatched, []);
    assert.equal(presentation.resolve({ queryLocale: 'fr' }).text('auth.field.email'), 'Email address');
    assert.deepEqual(presentation.coverage('de'), { missing: Object.keys(presentation.english).sort(), mismatched: [] });
    assert.deepEqual(compareCatalogues({ 'a.b': 'hi {name}' }, { 'a.b': 'salut', 'a.c': 'x' }), { missing: [], mismatched: ['a.b'], unknown: ['a.c'] });
});
test('extension catalogues merge beside the kit catalogue and a key may be registered once', () => {
    const merged = mergeCatalogues([kitCatalogue, { 'auth.title': 'Sign in' }]);
    assert.ok(Object.hasOwn(merged, 'ui.close') && Object.hasOwn(merged, 'auth.title'));
    assert.throws(() => mergeCatalogues([kitCatalogue, { 'ui.close': 'Shut' }]), /registered twice/);
    assert.throws(() => mergeCatalogues([kitCatalogue, [] as never]), /Invalid catalogue source/);
});
