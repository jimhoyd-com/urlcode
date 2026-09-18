/** Copy catalogue helpers shared by the kit, its extension and the CLI. Validation lives in createPresentation. */
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
/** Merges English catalogues from the kit and from extensions into presentation defaults; a key may be registered once. */
export function mergeCatalogues(sources: readonly Catalogue[]): Catalogue {
    const merged: Catalogue = Object.create(null) as Catalogue;
    for (const source of sources) {
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid catalogue source');
        for (const [key, value] of Object.entries(source)) {
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
    'ui.count.items': { one: '{count} item', other: '{count} items' },
});
