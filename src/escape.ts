/** HTML escaping and the one trusted-markup type the renderer accepts unescaped. */
export { escapeHtml } from './components.ts';
/**
 * Rendered output of the kit's own renderer. Only the renderer and trusted
 * extension code construct it; a template cannot, and any other object placed
 * in a template is escaped as text.
 */
export class Markup {
    readonly html: string;
    constructor(html: string) { this.html = html; Object.freeze(this); }
    toString(): string { return this.html; }
}
export function markup(html: string): Markup { return new Markup(html); }
export function isMarkup(value: unknown): value is Markup { return value instanceof Markup; }
