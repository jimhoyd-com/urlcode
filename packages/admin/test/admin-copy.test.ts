// The console's copy is admin's own catalogue, contributed to ui under admin.*; auth's catalogue carries none of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseCatalogue, createPresentation, kitCatalogue, mergeCatalogues } from '@jimhoyd/urlcode-ui';
import admin from '../src/extension.ts';
import auth from '@jimhoyd/urlcode-auth/extension';
import type { Catalogue } from '@jimhoyd/urlcode-ui';
import { adminCatalogue, adminCopy, copyObserver } from '../src/admin-copy.ts';

const src = new URL('../src/', import.meta.url).pathname;
const sources = readdirSync(src).filter(name => name.endsWith('.ts') && name !== 'admin-copy.ts').map(name => [name, readFileSync(join(src, name), 'utf8')] as const);
const english = new Set(Object.values(adminCatalogue).filter(value => typeof value === 'string'));

test('the admin catalogue holds only admin.* keys, and every key literal in admin/src resolves in it or in the kit', () => {
    assert.ok(Object.keys(adminCatalogue).length > 100);
    assert.deepEqual(Object.keys(adminCatalogue).filter(key => !key.startsWith('admin.')), []);
    const kit = new Set([...Object.keys(kitCatalogue), ...Object.keys(baseCatalogue)]);
    for (const [name, source] of sources)
        for (const [, key] of source.matchAll(/\b(?:t|tr|trh)\('((?:admin|ui|nav|action|message)\.[A-Za-z0-9.]+[A-Za-z0-9])'/g))
            assert.ok(Object.hasOwn(adminCatalogue, key!) || kit.has(key!), `${name}: ${key} is not in adminCatalogue or the kit`);
    // Dynamic keys: the account operations, recovery states and health statuses admin builds from a prefix.
    for (const action of ['verifyEmail', 'forcePasswordReset', 'scheduleDeletion', 'cancelDeletion', 'removePasskey', 'removeExternal', 'requestEmailChange', 'assignRoles', 'resendVerification'])
        assert.ok(Object.hasOwn(adminCatalogue, 'admin.ops.action.' + action), action);
    for (const status of ['healthy', 'degraded', 'unavailableStatus', 'unknown'])
        assert.ok(Object.hasOwn(adminCatalogue, 'admin.health.' + status), status);
});

test('every English source literal admin resolves is carried by its catalogue', () => {
    for (const [name, source] of sources)
        for (const [, text] of source.matchAll(/\b(?:s|text|html|plain|copy\.s)\('([A-Z][^'\\]*)'\)/g))
            assert.ok(english.has(text!), `${name}: '${text}' is not admin copy`);
    for (const [name, source] of sources)
        for (const [, text] of source.matchAll(/new AdminHttpError\(\d+, ?'([^']+)'\)/g))
            assert.ok(english.has(text!), `${name}: refusal '${text}' is not admin copy`);
});

test('auth\'s catalogue carries no console copy', () => {
    const contributed = (auth.definition.contributes as { ui: { sources: Catalogue[] } }).ui.sources;
    const keys = contributed.flatMap(catalogue => Object.keys(catalogue));
    assert.deepEqual(keys.filter(key => /^(?:users|adminOps|adminUi|health)\./.test(key) || key.startsWith('admin.')), []);
    assert.deepEqual(keys.filter(key => key.startsWith('manualRecovery.')).sort(), ['manualRecovery.newPassword', 'manualRecovery.replace', 'manualRecovery.restoreIntro', 'manualRecovery.restoreTitle']);
    // The two contributions merge into one kit catalogue without a key registered twice.
    const own = (admin.definition.contributes as { ui: { sources: Catalogue[] } }).ui.sources;
    assert.doesNotThrow(() => mergeCatalogues([kitCatalogue, ...contributed, ...own]));
});

test('adminCopy resolves a project translation by key or by the English it ships, reports what it lacks, and refuses foreign keys', () => {
    const context = createPresentation({ defaults: mergeCatalogues([kitCatalogue, adminCatalogue]), catalogues: { fr: { 'admin.ui.noSessions': 'Aucune session active.' } } }).resolve({ queryLocale: 'fr' });
    const copy = adminCopy(context), missing: string[] = [];
    copyObserver.missing = source => { missing.push(source); };
    try {
        assert.equal(copy.t('admin.ui.noSessions'), 'Aucune session active.');
        assert.equal(copy.s('No active sessions match these filters.'), 'Aucune session active.');
        assert.equal(copy.s('Not console copy'), 'Not console copy');
        assert.deepEqual(missing, ['Not console copy']);
        assert.equal(copy.t('action.next'), 'Next page');
        assert.throws(() => copy.t('page.signIn'), /admin\.\* and kit keys/);
    }
    finally { copyObserver.missing = undefined; }
});
