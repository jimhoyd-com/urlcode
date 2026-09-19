/**
 * Theme values a project may set. Everything is validated against a narrow
 * grammar so a theme can never carry CSS syntax, URLs or markup: colours are
 * shadcn/ui HSL triples or six-digit hex, radius is a bounded length, fonts
 * are a plain family list, assets are local paths.
 */
export const colorNames = ['background', 'foreground', 'card', 'cardForeground', 'popover', 'popoverForeground', 'primary', 'primaryForeground', 'secondary', 'secondaryForeground', 'muted', 'mutedForeground', 'accent', 'accentForeground', 'destructive', 'destructiveForeground', 'border', 'input', 'ring'] as const;
export type ColorName = typeof colorNames[number];
export type Colors = Partial<Record<ColorName, string>>;
export interface Theme {
    name?: string | undefined;
    logo?: string | undefined;
    favicon?: string | undefined;
    backTo?: string | undefined;
    colors?: (Colors & { dark?: Colors | undefined }) | undefined;
    radius?: string | undefined;
    font?: string | undefined;
}
export interface ResolvedTheme {
    readonly name: string | undefined;
    readonly logo: string | undefined;
    readonly favicon: string | undefined;
    readonly backTo: string | undefined;
    /** Declarations for `:root`, light values. */
    readonly light: string;
    /** Declarations for the dark scheme, empty when the theme sets none. */
    readonly dark: string;
    /** One `<style>` body: light, dark by media query and dark by class. */
    readonly css: string;
}
const hsl = /^(?:[0-9]|[1-9][0-9]|[12][0-9]{2}|3[0-5][0-9]|360)(?:\.[0-9]{1,2})? (?:[0-9]|[1-9][0-9]|100)(?:\.[0-9]{1,2})?% (?:[0-9]|[1-9][0-9]|100)(?:\.[0-9]{1,2})?%$/;
const hex = /^#[0-9a-fA-F]{6}$/;
const radius = /^(?:0|(?:0?\.[0-9]{1,3}|[0-2](?:\.[0-9]{1,3})?)rem|(?:[0-9]|[12][0-9]|3[0-2])px)$/;
const font = /^[A-Za-z0-9][A-Za-z0-9 ,'"-]{0,127}$/;
/** A local asset path: absolute, no scheme, query, fragment, traversal, backslash or markup. */
export function assetPath(value: string | undefined, what = 'asset'): string | undefined {
    if (value === undefined)
        return;
    if (typeof value !== 'string' || value.length > 512 || !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) || value.split('/').some(part => part === '.' || part === '..'))
        throw new Error(`Theme ${what} requires a safe local path`);
    return value;
}
/** A same-site link target: an absolute path with an optional query, never a scheme or a protocol-relative URL. */
export function localHref(value: string | undefined, what = 'link'): string | undefined {
    if (value === undefined)
        return;
    if (typeof value !== 'string' || value.length > 1024 || !/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/.test(value))
        throw new Error(`Theme ${what} requires a same-site path`);
    return value;
}
const kebab = (name: string): string => name.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
function colorDeclarations(colors: Colors | undefined, scope: string): string {
    if (colors === undefined)
        return '';
    if (!colors || typeof colors !== 'object' || Array.isArray(colors))
        throw new Error(`Invalid theme colors (${scope})`);
    const out: string[] = [];
    for (const [name, value] of Object.entries(colors)) {
        if (name === 'dark')
            continue;
        if (!(colorNames as readonly string[]).includes(name))
            throw new Error(`Unknown theme color: ${name.slice(0, 32)}`);
        if (typeof value !== 'string' || !(hsl.test(value) || hex.test(value)))
            throw new Error(`Theme color ${name} must be an HSL triple like "222.2 47.4% 11.2%" or six-digit hex`);
        out.push(`--${kebab(name)}:${hex.test(value) ? value : value}`);
    }
    return out.sort().join(';');
}
function text(value: string | undefined, what: string, max: number): string | undefined {
    if (value === undefined)
        return;
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
        throw new Error(`Theme ${what} must be plain text up to ${max} characters`);
    return value;
}
export function resolveTheme(theme: Theme = {}): ResolvedTheme {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme))
        throw new Error('Invalid theme');
    for (const key of Object.keys(theme))
        if (!['name', 'logo', 'favicon', 'backTo', 'colors', 'radius', 'font'].includes(key))
            throw new Error(`Unknown theme key: ${key.slice(0, 32)}`);
    const name = text(theme.name, 'name', 80), logo = assetPath(theme.logo, 'logo'), favicon = assetPath(theme.favicon, 'favicon'), backTo = localHref(theme.backTo, 'backTo');
    const declarations: string[] = [colorDeclarations(theme.colors, 'light')].filter(Boolean);
    if (theme.radius !== undefined) {
        if (typeof theme.radius !== 'string' || !radius.test(theme.radius))
            throw new Error('Theme radius must be 0 to 2rem or 0 to 32px');
        declarations.push(`--radius:${theme.radius}`);
    }
    if (theme.font !== undefined) {
        if (typeof theme.font !== 'string' || !font.test(theme.font) || /["']{2}|url|expression|\\/.test(theme.font))
            throw new Error('Theme font must be a plain font family list');
        declarations.push(`--font-sans:${theme.font}`);
    }
    const light = declarations.join(';'), dark = colorDeclarations(theme.colors?.dark, 'dark');
    const css = [light ? `:root{${light}}` : '', dark ? `@media (prefers-color-scheme: dark){:root:not(.light){${dark}}}.dark{${dark}}` : ''].filter(Boolean).join('');
    return Object.freeze({ name, logo, favicon, backTo, light, dark, css });
}
