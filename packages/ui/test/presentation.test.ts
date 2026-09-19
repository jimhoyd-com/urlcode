import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresentation, catalogueLimits } from '../src/presentation.ts';
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

test('catalogues are bounded per source and in total, so the kit, auth and admin catalogues register side by side', () => {
    const source = (prefix: string, count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}.k${i}`, `${prefix} ${i}`]));
    assert.deepEqual(catalogueLimits, { sourceKeys: 1024, keys: 4096, bytes: 524288 });
    assert.equal(Object.keys(mergeCatalogues([kitCatalogue, source('auth', 470), source('admin', 44)])).length, 20 + 470 + 44);
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
