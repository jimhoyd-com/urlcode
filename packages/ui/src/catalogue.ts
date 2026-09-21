/** Copy catalogue helpers shared by the kit, its extension and the CLI. Validation lives in createPresentation. */
import { catalogueLimits } from './presentation.ts';
import type { Catalogue, PluralMessage } from './presentation.ts';
const placeholderPattern = /\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}/g;
/** The placeholder names a message uses, sorted, so a translation can be checked against its source. */
export function placeholders(entry: string | PluralMessage): string[] {
    const texts = typeof entry === 'string' ? [entry] : Object.values(entry);
    return [...new Set(texts.flatMap(text => [...text.matchAll(placeholderPattern)].map(match => match[1]!)))].sort();
}
/** Keys present in the source catalogue and absent from a translation, plus keys whose placeholders differ. */
export function compareCatalogues(source: Catalogue, translation: Catalogue): { missing: string[]; mismatched: string[]; unknown: string[] } {
    const missing: string[] = [], mismatched: string[] = [], unknown: string[] = [];
    for (const key of Object.keys(source)) {
        if (!Object.hasOwn(translation, key)) { missing.push(key); continue; }
        if (JSON.stringify(placeholders(source[key]!)) !== JSON.stringify(placeholders(translation[key]!)))
            mismatched.push(key);
    }
    for (const key of Object.keys(translation))
        if (!Object.hasOwn(source, key))
            unknown.push(key);
    return { missing: missing.sort(), mismatched: mismatched.sort(), unknown: unknown.sort() };
}
/**
 * Merges English catalogues from the kit and from extensions into presentation defaults; a key may be registered once.
 * Each source is bounded on its own (`catalogueLimits.sourceKeys`) and the merge as a whole (`catalogueLimits.keys`),
 * so a host can register the kit's, auth's and admin's catalogues side by side.
 */
export function mergeCatalogues(sources: readonly Catalogue[]): Catalogue {
    if (!Array.isArray(sources) || sources.length > 16) throw new Error('Too many catalogue sources');
    const merged: Catalogue = Object.create(null) as Catalogue;
    let total = 0;
    for (const source of sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid catalogue source');
        const entries = Object.entries(source as Catalogue);
        if (entries.length > catalogueLimits.sourceKeys) throw new Error('Catalogue source exceeds key limit');
        total += entries.length;
        if (total > catalogueLimits.keys) throw new Error('Catalogue exceeds key limit');
        for (const [key, value] of entries) {
            if (Object.hasOwn(merged, key)) throw new Error(`Catalogue key registered twice: ${key.slice(0, 64)}`);
            merged[key] = value;
        }
    }
    return merged;
}
/** The kit's own English strings, beside the base catalogue's nav.skip, action.* and message.empty. */
export const kitCatalogue: Readonly<Catalogue> = Object.freeze({
    'ui.backTo': 'Back to site',
    'ui.menu': 'Account menu',
    'ui.signOut': 'Sign out',
    'ui.close': 'Close',
    'ui.confirmTyped': 'Type {value} to confirm',
    'ui.otp.label': 'Verification code',
    'ui.otp.help': 'Enter the {count}-digit code',
    'ui.pagination.previous': 'Previous',
    'ui.pagination.next': 'Next',
    'ui.pagination.page': 'Page {page} of {pages}',
    'ui.empty.title': 'Nothing here yet',
    'ui.table.empty': 'No rows',
    'ui.alert.error': 'Error',
    'ui.alert.warning': 'Warning',
    'ui.alert.success': 'Done',
    'ui.alert.info': 'Note',
    'ui.field.optional': 'Optional',
    'ui.field.required': 'Required',
    'ui.language': 'Language',
    'ui.crud.add': 'Add',
    'ui.crud.save': 'Save',
    'ui.crud.cancel': 'Cancel',
    'ui.crud.edit': 'Edit',
    'ui.crud.remove': 'Delete',
    'ui.crud.refresh': 'Refresh',
    'ui.crud.more': 'Load more',
    'ui.crud.sort': 'Sort by',
    'ui.crud.empty': 'Nothing here yet',
    'ui.crud.loading': 'Loading',
    'ui.crud.loadFailed': 'The list could not be loaded. Try again.',
    'ui.crud.saveFailed': 'That change was not saved. Try again.',
    'ui.crud.deleteFailed': 'That item was not deleted. Try again.',
    'ui.crud.invalid': 'Some values are not valid. Check the highlighted fields.',
    'ui.crud.noScript': 'This screen needs JavaScript to list and edit records.',
    'ui.count.items': { one: '{count} item', other: '{count} items' },
});
