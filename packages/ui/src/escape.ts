/** HTML escaping and the one trusted-markup type the renderer accepts unescaped. */
export { escapeHtml } from './components.ts';
/**
 * Rendered output of the kit's own renderer. Only the renderer and trusted
 * extension code construct it; a template cannot, and any other object placed
 * in a template is escaped as text.
 */
/**
 * Well-known brand for Markup instances, keyed through Symbol.for so it
 * resolves to the identical symbol across separately loaded module
 * instances of this same source (e.g. one bundle's embedded copy of
 * @jimhoyd/urlcode-ui versus another bundle's own copy). A plain
 * `instanceof Markup` check fails across such module-instance boundaries
 * even when both classes are built from identical source, because each
 * loaded module gets its own distinct class object.
 */
const MARKUP_BRAND = Symbol.for('urlcode.ui.Markup');

export class Markup {
    readonly html: string;
    constructor(html: string) {
        this.html = html;
        (this as Record<symbol, unknown>)[MARKUP_BRAND] = true;
        Object.freeze(this);
    }
    toString(): string { return this.html; }
}
export function markup(html: string): Markup { return new Markup(html); }
/**
 * True for any Markup instance, including one constructed by a different
 * loaded copy of this module (as happens when composed extension bundles
 * each embed their own copy of urlcode-ui). Keeps the fast-path `instanceof`
 * check for the common single-module-instance case and falls back to the
 * cross-instance structural brand otherwise.
 */
export function isMarkup(value: unknown): value is Markup {
    return value instanceof Markup
        || (typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[MARKUP_BRAND] === true);
}
