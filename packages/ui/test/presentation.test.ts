import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentation, catalogueLimits } from '../src/presentation.ts';
import { compareCatalogues, mergeCatalogues, kitCatalogue, kitCatalogueFr } from '../src/catalogue.ts';
import { baseCatalogue } from '../src/presentation.ts';
import { createKit } from '../src/kit.ts';
import { markup } from '../src/escape.ts';
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
test('the shipped kitCatalogueFr is a complete French translation, clean under the coverage report, and actually renders (#616)', () => {
    // "Complete" means the existing translation-coverage report (Presentation.coverage,
    // the same mechanism a project's own ui/copy/<locale>.json is checked with) finds no
    // gap and no placeholder mismatch once kitCatalogueFr is registered for a locale.
    const presentation = createPresentation({ defaults: kitCatalogue, catalogues: { fr: kitCatalogueFr } });
    assert.deepEqual(presentation.coverage('fr'), { missing: [], mismatched: [] });
    assert.deepEqual(compareCatalogues({ ...baseCatalogue, ...kitCatalogue }, kitCatalogueFr), { missing: [], mismatched: [], unknown: [] });
    // Selecting fr actually renders the French text, not just English with a locale tag.
    const french = presentation.resolve({ queryLocale: 'fr' });
    assert.equal(french.text('ui.signOut'), 'Se déconnecter');
    assert.equal(french.text('nav.skip'), 'Aller au contenu');
    assert.equal(french.text('ui.otp.help', { count: 6 }), 'Saisissez le code à 6 chiffres');
    assert.equal(french.text('ui.count.items', { count: 1 }), '1 élément');
    assert.equal(french.text('ui.count.items', { count: 3 }), '3 éléments');
    // A kit built on this presentation renders a real page in French end to end.
    const kit = createKit({ presentation });
    const html = new TextDecoder().decode(kit.wrap(markup('<p>x</p>'), { title: 'Bienvenue', preferences: { queryLocale: 'fr' } }).body);
    assert.match(html, /^<!doctype html>\n<html lang="fr" dir="ltr">/);
    assert.match(html, /Aller au contenu/);
});
test('extension catalogues merge beside the kit catalogue and a key may be registered once', () => {
    const merged = mergeCatalogues([kitCatalogue, { 'auth.title': 'Sign in' }]);
    assert.ok(Object.hasOwn(merged, 'ui.close') && Object.hasOwn(merged, 'auth.title'));
    assert.throws(() => mergeCatalogues([kitCatalogue, { 'ui.close': 'Shut' }]), /registered twice/);
    assert.throws(() => mergeCatalogues([kitCatalogue, [] as never]), /Invalid catalogue source/);
});

test('catalogues are bounded per source and in total, so the kit, auth and admin catalogues register side by side', () => {
    const source = (prefix: string, count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}.k${i}`, `${prefix} ${i}`]));
    assert.deepEqual(catalogueLimits, { sourceKeys: 1024, keys: 4096, bytes: 524288 });
    assert.equal(Object.keys(mergeCatalogues([kitCatalogue, source('auth', 470), source('admin', 44)])).length, Object.keys(kitCatalogue).length + 470 + 44);
    assert.equal(Object.keys(mergeCatalogues([source('a', 1024)])).length, 1024);
    assert.throws(() => mergeCatalogues([source('a', 1025)]), /source exceeds key limit/);
    assert.equal(Object.keys(mergeCatalogues([source('a', 1024), source('b', 1024), source('c', 1024), source('d', 1024)])).length, 4096);
    assert.throws(() => mergeCatalogues([source('a', 1024), source('b', 1024), source('c', 1024), source('d', 1024), source('e', 1)]), /Catalogue exceeds key limit/);
    assert.throws(() => mergeCatalogues(Array.from({ length: 17 }, () => ({}))), /Too many catalogue sources/);
    const base = Object.keys(createPresentation().english).length;
    assert.doesNotThrow(() => createPresentation({ defaults: source('x', 4096 - base) }));
    assert.throws(() => createPresentation({ defaults: source('x', 4096 - base + 1) }), /exceeds key limit/);
    assert.throws(() => createPresentation({ catalogues: { fr: source('x', 4097) } }), /exceeds key limit/);
    assert.throws(() => createPresentation({ defaults: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`big.k${i}`, 'x'.repeat(2048)])) }), /exceeds byte limit/);
    assert.doesNotThrow(() => createPresentation({ defaults: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`big.k${i}`, 'x'.repeat(2048)])) }));
});
