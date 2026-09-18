import {themeControl} from './document.ts';
import {themeScript} from './theme-script.ts';
/**
 * The kit: templates resolved in override order (project file, then the
 * owning extension, then the kit), rendered into complete pages with the
 * layout, the theme, the stylesheet and a strict CSP. Node-free.
 */
import { compileTemplate, safeHref } from './template.ts';
import type { CompiledTemplate, ViewModel } from './template.ts';
import { kitTemplates } from './partials.ts';
import { kitAssets } from './kit-styles.ts';
import type { Asset } from './kit-styles.ts';
import { resolveTheme } from './theme.ts';
import type { Theme, ResolvedTheme } from './theme.ts';
import { Markup, escapeHtml } from './escape.ts';
import { icon } from './icons.ts';
import type { IconName } from './icons.ts';
import { createPresentation } from './presentation.ts';
import type { Presentation, PresentationContext, LocalePreferences } from './presentation.ts';
import { kitCatalogue } from './catalogue.ts';
export type TemplateOrigin = 'project' | 'kit' | `extension:${string}`;
export interface ExtensionTemplates { name: string; templates?: Record<string, string> | undefined; viewModels?: Record<string, string> | undefined }
export interface KitOptions {
    presentation: Presentation;
    /** The project's theme block: name, logo, favicon, back link, shadcn/ui colours, radius, font. */
    theme?: Theme | undefined;
    /** Project template sources by name, shadowing extension and kit templates. */
    templates?: Record<string, string> | undefined;
    /** Extensions that ship templates under their own namespace. */
    extensions?: readonly ExtensionTemplates[] | undefined;
    stylesheet?: { append?: string | undefined; replace?: string | undefined } | undefined;
    /** Where the assets are served, the mount of the `ui` extension route. */
    assetsBase?: string | undefined;
}
export interface TemplateInfo { name: string; origin: TemplateOrigin; viewModel: string | undefined; expected: string | undefined; behind: boolean }
export interface KitReport {
    templates: TemplateInfo[];
    overrides: TemplateInfo[];
    behind: TemplateInfo[];
    languages: { locale: string; missing: string[]; mismatched: string[] }[];
    assets: { name: string; bytes: number }[];
}
/**
 * A script an extension serves itself, under its own mount: a same-site path
 * (no scheme, no host, passes `safeHref` unchanged) and an optional
 * Subresource Integrity value. It is rendered with the page nonce, like a kit
 * script, so the page CSP admits it without post-processing the document.
 */
export interface ExtensionScript { src: string; integrity?: string | undefined }
export interface NavigationItem { href: string; label: string; current?: boolean | undefined; icon?: IconName | undefined }
export type PageLayout = 'default' | 'compact' | 'application';
export interface PageOptions {
    title: string;
    preferences?: LocalePreferences | undefined;
    context?: PresentationContext | undefined;
    status?: number | undefined;
    headers?: [string, string][] | undefined;
    /** Kit scripts by name ('otp', 'confirm') and extension-owned scripts by path; at most `pageLimits.scripts` in all. */
    scripts?: readonly (string | ExtensionScript)[] | undefined;
    /** `default` keeps the header; `compact` centres a small card; `application` hides the header and title so the page supplies its console shell (`ui-shell`, `ui-sidebar`, `ui-content`). All render through `layout`. */
    layout?: PageLayout | undefined;
    nav?: NavigationItem[] | undefined;
    menu?: { label: string; initial?: string; items: { href: string; label: string }[] } | undefined;
    flash?: { kind: 'error' | 'warning' | 'success' | 'info'; title?: string; message: string } | undefined;
    footer?: Markup | undefined;
    /** Extra CSP sources for script-src, connect-src and frame-src, for an extension that embeds a challenge widget. */
    csp?: { script?: string[]; connect?: string[]; frame?: string[] } | undefined;
}
export interface PageResult { status: number; headers: [string, string][]; body: Uint8Array }
export interface Kit {
    readonly presentation: Presentation;
    readonly theme: ResolvedTheme;
    readonly assetsBase: string;
    readonly assets: readonly Asset[];
    readonly names: readonly string[];
    info(name: string): TemplateInfo | undefined;
    template(name: string): CompiledTemplate | undefined;
    /** Renders one template with a view; the result is trusted markup for composition. */
    render(name: string, view: ViewModel, context: PresentationContext): Markup;
    /** Renders a template inside the layout as a complete HTML response. */
    page(name: string, view: ViewModel, options: PageOptions): PageResult;
    /** Wraps ready markup in the layout, for extensions composing pages from partials. */
    wrap(content: Markup, options: PageOptions): PageResult;
    report(): KitReport;
    resolveContext(preferences?: LocalePreferences): PresentationContext;
}
/** The same bounds `renderDocument` applies to its scripts: count per page and source length. */
export const pageLimits = Object.freeze({ scripts: 8, scriptSource: 2048, navigation: 100 });
const encoder = new TextEncoder();
const kindLabel: Record<string, string> = { error: 'ui.alert.error', warning: 'ui.alert.warning', success: 'ui.alert.success', info: 'ui.alert.info' };
const pageLayouts: readonly PageLayout[] = ['default', 'compact', 'application'];
const kitKeys = Object.keys(kitCatalogue);
function nonce(): string {
    const bytes = new Uint8Array(18);
    globalThis.crypto.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}
/** An extension script's path: same-site, absolute, no scheme or host, and unchanged by `safeHref`. */
function extensionScriptSource(value: unknown): string {
    if (typeof value !== 'string' || value.length > pageLimits.scriptSource || !value.startsWith('/') || value.startsWith('//') || safeHref(value) !== value)
        throw new Error(`Extension script must be a same-site path: ${String(value).slice(0, 64)}`);
    return value;
}
function integrityValue(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/]{40,90}={0,2}$/.test(value)) throw new Error('Extension script integrity must be a sha256, sha384 or sha512 value');
    return value;
}
/**
 * The kit's own copy (`ui.*`) is part of every page the layout renders. A
 * host that builds its own presentation need not register `kitCatalogue`: a
 * context that lacks a kit key answers it from the kit's English catalogue,
 * and the extension's or project's key wins wherever it exists.
 */
let kitOnly: Presentation | undefined;
function withKitCopy(context: PresentationContext): PresentationContext {
    if (kitKeys.every(key => context.has(key))) return context;
    const fallback = (kitOnly ??= createPresentation({ defaults: kitCatalogue })).resolve({ accountLocale: context.locale });
    return Object.freeze({
        locale: context.locale, lang: context.lang, dir: context.dir, cssVariables: context.cssVariables,
        ...(context.logo ? { logo: context.logo } : {}), ...(context.favicon ? { favicon: context.favicon } : {}),
        has: (key: string) => context.has(key) || fallback.has(key),
        formatDate: (value: Date | string | number, style?: 'date' | 'time' | 'datetime') => context.formatDate(value, style),
        formatNumber: (value: number) => context.formatNumber(value),
        textSource: (sourceEnglish: string) => context.textSource(sourceEnglish),
        text: (key: string, values?: Readonly<Record<string, string | number>>) => context.has(key) ? context.text(key, values) : fallback.text(key, values),
    });
}
function withKitCatalogue(presentation: Presentation): Presentation {
    if (kitKeys.every(key => Object.hasOwn(presentation.english, key))) return presentation;
    const english: Presentation['english'] = Object.freeze({ ...kitCatalogue, ...presentation.english });
    return Object.freeze({
        locales: presentation.locales, defaultLocale: presentation.defaultLocale, english,
        resolve: (preferences?: LocalePreferences) => withKitCopy(presentation.resolve(preferences)),
        coverage: (locale: string) => presentation.coverage(locale),
    });
}
export function createKit(options: KitOptions): Kit {
    const presentation = withKitCatalogue(options.presentation);
    const assetsBase = options.assetsBase ?? '/assets/ui';
    if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(assetsBase))
        throw new Error('Kit assets base must be an absolute path');
    if (options.stylesheet?.append !== undefined && (typeof options.stylesheet.append !== 'string' || options.stylesheet.append.length > 524288))
        throw new Error('Appended stylesheet missing or too large');
    if (options.stylesheet?.replace !== undefined && (typeof options.stylesheet.replace !== 'string' || options.stylesheet.replace.length > 524288))
        throw new Error('Replacement stylesheet missing or too large');
    const assets = kitAssets(options.stylesheet?.append, options.stylesheet?.replace);
    const theme = resolveTheme(options.theme);
    const stylesheet = `${assetsBase}/${assets[0]!.name}`;
    const compiled = new Map<string, { template: CompiledTemplate; origin: TemplateOrigin }>();
    const expected = new Map<string, string>();
    for (const [name, shipped] of Object.entries(kitTemplates)) {
        const template = compileTemplate(name, shipped.source);
        compiled.set(name, { template, origin: 'kit' });
        if (template.viewModel) expected.set(name, template.viewModel);
    }
    for (const extension of options.extensions ?? []) {
        if (!/^[a-z][a-z0-9-]{0,63}$/.test(extension.name)) throw new Error('Invalid extension name for templates');
        for (const [name, source] of Object.entries(extension.templates ?? {})) {
            const template = compileTemplate(name, source);
            if (compiled.get(name)?.origin === 'kit' && !name.startsWith(extension.name + '/')) throw new Error(`Extension ${extension.name} cannot replace kit template ${name}`);
            compiled.set(name, { template, origin: `extension:${extension.name}` });
            if (template.viewModel) expected.set(name, template.viewModel);
        }
        for (const [name, version] of Object.entries(extension.viewModels ?? {})) expected.set(name, version);
    }
    const projectEntries = Object.entries(options.templates ?? {});
    if (projectEntries.length > 256) throw new Error('Too many project templates');
    for (const [name, source] of projectEntries) {
        const template = compileTemplate(name, source);
        compiled.set(name, { template, origin: 'project' });
    }
    for (const { template } of compiled.values())
        for (const key of template.copyKeys)
            if (!Object.hasOwn(presentation.english, key))
                throw new Error(`Template ${template.name} uses copy key ${key} that the presentation lacks; register the extension catalogues in defaults`);
    const info = (name: string): TemplateInfo | undefined => {
        const entry = compiled.get(name);
        if (!entry) return undefined;
        const want = expected.get(name);
        const behind = entry.origin === 'project' && want !== undefined && entry.template.viewModel !== want;
        return { name, origin: entry.origin, viewModel: entry.template.viewModel, expected: want, behind };
    };
    const resolve = (name: string): CompiledTemplate | undefined => compiled.get(name)?.template;
    const render = (name: string, view: ViewModel, context: PresentationContext): Markup => {
        const template = resolve(name);
        if (!template) throw new Error(`Unknown template: ${name.slice(0, 64)}`);
        return template.render(view, withKitCopy(context), resolve);
    };
    const wrap = (content: Markup, page: PageOptions): PageResult => {
        const context = withKitCopy(page.context ?? presentation.resolve(page.preferences));
        const token = nonce();
        const layout = page.layout ?? 'default';
        if (!pageLayouts.includes(layout)) throw new Error('Invalid page layout');
        const scripts = page.scripts ?? [];
        if (!Array.isArray(scripts) || scripts.length > pageLimits.scripts) throw new Error('Page scripts exceed limit');
        const scriptAssets = scripts.map(script => {
            if (typeof script === 'string') {
                const asset = assets.find(candidate => candidate.name.startsWith(script + '.'));
                if (!asset) throw new Error(`Unknown kit script: ${script.slice(0, 32)}`);
                return { src: `${assetsBase}/${asset.name}`, integrity: null };
            }
            if (!script || typeof script !== 'object') throw new Error('Page script must be a kit script name or an extension script');
            return { src: extensionScriptSource(script.src), integrity: integrityValue(script.integrity) };
        });
        const nav = page.nav ?? null;
        if (nav && (!Array.isArray(nav) || nav.length > pageLimits.navigation)) throw new Error('Too many navigation items');
        const view: ViewModel = {
            layout, showTitle: layout !== 'application', themeToggle: new Markup(themeControl(context)), themeBootstrap: new Markup(themeScript),
            lang: context.lang, dir: context.dir, title: page.title, siteName: theme.name ?? null, favicon: theme.favicon ?? context.favicon ?? null, logo: theme.logo ?? context.logo ?? null, backTo: theme.backTo ?? null,
            stylesheet, extraStylesheet: null, nonce: token, themeCss: new Markup((context.cssVariables ? `:root{${context.cssVariables}}` : '') + theme.css), content,
            nav: nav ? nav.map(item => ({ href: item.href, label: item.label, current: Boolean(item.current), icon: item.icon ? new Markup(icon(item.icon)) : null })) : null,
            menu: page.menu ? { label: page.menu.label, initial: page.menu.initial ?? page.menu.label.slice(0, 1).toUpperCase(), items: page.menu.items.map(item => ({ href: item.href, label: item.label })) } : null,
            flash: page.flash ? { kind: page.flash.kind, kindLabel: context.text(kindLabel[page.flash.kind] ?? 'ui.alert.info'), live: page.flash.kind === 'error', title: page.flash.title ?? null, message: page.flash.message } : null,
            footer: page.footer ?? null, scripts: scriptAssets,
        };
        const html = render('layout', view, context).html;
        const scriptSources = [`'nonce-${token}'`, ...(page.csp?.script ?? [])].join(' ');
        const csp = [`default-src 'none'`, `style-src 'self' 'nonce-${token}'`, `img-src 'self'`, `font-src 'self'`, `form-action 'self'`, `base-uri 'none'`, `frame-ancestors 'none'`, `script-src ${scriptSources}`, ...(page.csp?.connect?.length ? [`connect-src 'self' ${page.csp.connect.join(' ')}`] : []), ...(page.csp?.frame?.length ? [`frame-src ${page.csp.frame.join(' ')}`] : [])].join('; ');
        const headers: [string, string][] = [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'no-store'], ['content-security-policy', csp], ['referrer-policy', 'strict-origin'], ['x-content-type-options', 'nosniff'], ['content-language', context.lang], ['vary', 'Accept-Language, Cookie'], ...(page.headers ?? [])];
        return { status: page.status ?? 200, headers, body: encoder.encode(html) };
    };
    const kit: Kit = {
        presentation, theme, assetsBase, assets, names: Object.freeze([...compiled.keys()].sort()),
        info, template: resolve, render, wrap,
        page(name, view, page) {
            const context = withKitCopy(page.context ?? presentation.resolve(page.preferences));
            return wrap(render(name, view, context), { ...page, context });
        },
        resolveContext: (preferences?: LocalePreferences) => presentation.resolve(preferences),
        report() {
            const templates = [...compiled.keys()].sort().map(name => info(name)!);
            return {
                templates,
                overrides: templates.filter(entry => entry.origin === 'project'),
                behind: templates.filter(entry => entry.behind),
                languages: presentation.locales.filter(locale => locale !== 'en').map(locale => ({ locale, ...presentation.coverage(locale) })),
                assets: assets.map(asset => ({ name: asset.name, bytes: encoder.encode(asset.body).length })),
            };
        },
    };
    return Object.freeze(kit);
}
/** A small helper for extensions building field markup without a template: escapes every attribute. */
export function attributes(pairs: Record<string, string | number | boolean | null | undefined>): string {
    return Object.entries(pairs).filter(([, value]) => value !== null && value !== undefined && value !== false).map(([name, value]) => {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('Invalid attribute name');
        return value === true ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`;
    }).join('');
}
