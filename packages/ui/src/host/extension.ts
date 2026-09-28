/**
 * The `ui` runtime extension. It owns the project's `extensions.ui` block,
 * builds the shared kit from it at activation, and serves the kit's
 * stylesheet and scripts at its mount. Other extensions receive the kit from
 * the host file after activation. Trusted operator code, Node targets only.
 */
import { createPresentation } from '../presentation.ts';
import type { Catalogue } from '../presentation.ts';
import { kitCatalogue, mergeCatalogues } from '../catalogue.ts';
import type { Theme } from '../theme.ts';
import { createKit } from '../kit.ts';
import type { ExtensionTemplates, Kit, PageOptions } from '../kit.ts';
import type { PresentationContext } from '../presentation.ts';
import type { ViewModel } from '../template.ts';
import { extensionHookContext, extensionHooksSchema, loadExtensionHooks } from '@jimhoyd/urlcode/extensions';
import { crudFields, crudScreen } from '../crud.ts';
import type { CrudCollection, CrudColumn } from '../crud.ts';
import { loadProjectUi } from './loader.ts';
import type { UiConfig } from './loader.ts';
import type {
    ExtensionActivation, ExtensionAuthoringContract, ExtensionAuthoringSurface, ExtensionHookContract, ExtensionImmutableAssets,
    ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension,
} from '@jimhoyd/urlcode/extensions';
/*
 * The extension contract comes from core (`@jimhoyd/urlcode/extensions`, the package's
 * peer dependency) rather than a structural copy, so it cannot drift from the shape the
 * runtime checks at activation. They are re-exported from `./host` for hosts and the
 * other packages. `HeaderPair` and `TargetName` are not exported by that entry point, so
 * they are derived from the contract types that carry them.
 */
export type { ExtensionActivation, ExtensionAuthoringContract, ExtensionAuthoringSurface, ExtensionImmutableAssets, ExtensionInstance, ExtensionRequest, HandlerResult, RuntimeExtension };
export type HeaderPair = HandlerResult['headers'][number];
/** Core's deployment targets (`TargetName`), so `targets` needs no cast. */
export type TargetName = RuntimeExtension['targets'][number];
/** Mount-relative prefix under which the kit's content-hashed assets are served; declared as `immutableAssets`. */
export const uiAssetPrefix = '/static';
export interface UiExtensionOptions {
    /** The exact reviewed project revision, from `inspectExtensionRevision`. */
    projectSha256: string;
    /** The site directory; configured presentation files are confined to its ui/ subdirectory. */
    projectRoot: string;
    /** English catalogues from other extensions, registered before activation. */
    sources?: readonly Catalogue[] | undefined;
    /** Templates other extensions ship under their namespace. */
    extensions?: readonly ExtensionTemplates[] | undefined;
    /** Theme values the host sets that the project may not, none by default. */
    theme?: Theme | undefined;
    /**
     * Screen sources other extensions contribute, each with its contributor's name (`from`, stamped by composeHost);
     * each screen is served at an exact `extension: ui` mount, and errors name the contributor.
     */
    screens?: readonly UiScreenContribution[] | undefined;
}
export interface UiExtension {
    readonly registration: RuntimeExtension;
    /** The kit, available once the runtime has activated the extension. */
    readonly kit: Kit;
    readonly active: boolean;
}
const colorNames = ['background', 'foreground', 'card', 'cardForeground', 'popover', 'popoverForeground', 'primary', 'primaryForeground', 'secondary', 'secondaryForeground', 'muted', 'mutedForeground', 'accent', 'accentForeground', 'destructive', 'destructiveForeground', 'border', 'input', 'ring'];
const cssName = (name: string): string => name.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
const colorSchemes = (scheme: string) => ({ type: 'object', additionalProperties: false, properties: Object.fromEntries(colorNames.map(name => [name, { type: 'string', maxLength: 32, description: `Semantic colour --${cssName(name)}${scheme}: an HSL triple such as "222.2 47.4% 11.2%" or six-digit hex; anything else fails activation.` }])) });
const colors = colorSchemes('');
export const uiHookContracts = [{
    name: 'transformView', kind: 'filter',
    description: 'Runs before a named kit template renders and returns the view model to render.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['template', 'view'], properties: { template: { type: 'string', description: 'Name of the template about to render, for example layout.' }, view: { type: 'object', description: 'The view model; return it, changed or not, as the model to render.' } } },
    outputSchema: { type: 'object' },
}, {
    name: 'transformPage', kind: 'filter',
    description: 'Runs before the shared page layout renders and may change its title, layout, navigation, account menu or flash message.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['page'], properties: { page: { type: 'object', description: 'The page options (title, layout, navigation, account menu, flash); return the options to render.' } } },
    outputSchema: { type: 'object' },
}] as const satisfies readonly ExtensionHookContract[];
export const uiAuthoring: ExtensionAuthoringContract = Object.freeze({
    description: 'Keep the site as one application: customize the installed UI in the project and keep each extension\'s behavior in its package. Use a new extension only for a capability the installed extensions do not provide.',
    surfaces: Object.freeze([
        { kind: 'theme' as const, name: 'theme', description: 'Set brand name, local assets, semantic light/dark colours, radius and font in extensions.ui.config.theme.', path: 'urlcode.yaml#extensions.ui.config.theme' },
        { kind: 'copy' as const, name: 'copy', description: 'Override or translate catalogue entries without copying a screen.', path: 'ui/copy/<locale>.json' },
        { kind: 'template' as const, name: 'templates', description: 'Override only the screen or shared partial whose structure must change; doctor reports view-model drift.', path: 'ui/templates/<name>.html', command: 'urlcode-ui list --project .' },
        { kind: 'stylesheet' as const, name: 'stylesheet', description: 'Append project CSS after the shared stylesheet; use semantic shadcn tokens and existing ui-* component classes.', path: 'ui/extra.css' },
        { kind: 'hook' as const, name: 'transformView', description: 'Add computed project data to a named view immediately before its template renders.', path: 'extensions.ui.config.hooks.transformView' },
        { kind: 'hook' as const, name: 'transformPage', description: 'Customize the shared page shell, navigation, account menu and flash immediately before layout rendering.', path: 'extensions.ui.config.hooks.transformPage' },
    ]),
    fastChecks: Object.freeze([
        'urlcode-ui doctor --project . --copy ui/copy --templates ui/templates --stylesheet ui/extra.css',
        'urlcode validate --local',
    ]),
});
export const uiConfigSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', additionalProperties: false,
    properties: {
        theme: {
            description: 'Brand and design tokens for every page the kit renders. Values are checked against a narrow grammar at activation, so a theme never carries CSS syntax, URLs or markup.',
            type: 'object', additionalProperties: false,
            properties: {
                name: { type: 'string', maxLength: 80, description: 'Brand name shown in the page header; plain text.' },
                logo: { type: 'string', maxLength: 512, description: 'Local absolute path of the header logo image, for example /public/logo.svg; no scheme, query or traversal.' },
                favicon: { type: 'string', maxLength: 512, description: 'Local absolute path of the favicon; same rules as logo.' },
                backTo: { type: 'string', maxLength: 1024, description: 'Same-site path (optional query) the header links back to, for example /; never a scheme or protocol-relative URL.' },
                colors: { ...colors, description: 'Light-scheme colour overrides by semantic shadcn/ui token; unset tokens keep the kit defaults.', properties: { ...colors.properties, dark: { ...colorSchemes(' in the dark scheme'), description: 'Dark-scheme colour overrides, applied by media query and by the dark class.' } } },
                radius: { type: 'string', maxLength: 16, description: 'Corner radius --radius: 0 to 2rem or 0 to 32px.' },
                font: { type: 'string', maxLength: 128, description: 'Plain font-family list, for example Inter, sans-serif; no url() or escapes.' },
            },
        },
        languages: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', maxLength: 35 }, description: 'Language tags the site offers (default [en]); any other than en needs a copy directory with <copy>/<tag>.json.' },
        copy: { type: 'string', maxLength: 256, description: 'Relative directory under ui/ holding <locale>.json catalogues that override or translate catalogue entries by id, for example ui/copy.' },
        templates: { type: 'string', maxLength: 256, description: 'Relative directory under ui/ whose <name>.html files shadow a kit or extension template of that name, for example ui/templates.' },
        stylesheet: { description: 'Project CSS under ui/: a path is appended after the kit stylesheet; {file, replace: true} replaces it. Script, javascript:, expression() and @import are refused.', oneOf: [{ type: 'string', maxLength: 256 }, { type: 'object', additionalProperties: false, required: ['file'], properties: { file: { type: 'string', maxLength: 256, description: 'Relative path of the CSS file under ui/ (at most 512 KiB).' }, replace: { type: 'boolean', description: 'true: serve this file instead of the kit stylesheet; default false (append).' } } }] },
        hooks: { ...extensionHooksSchema(uiHookContracts), description: 'Trusted project filter hooks by name ({source, export} or a bare module path) that adjust a view model or the page shell before rendering; sandbox: true is refused.' },
    },
} as const;
/**
 * A data screen another extension contributes (see `UiContribution.screens`): a list and form for one
 * collection that the contributing extension serves over HTTP at `collection.mount`. ui knows nothing about
 * where the declaration came from; it only renders it at the screen's exact mount.
 */
export interface UiScreen {
    /** Page and heading text, 1 to 80 characters. */
    title: string;
    /** The collection's HTTP API mount and field declarations. */
    collection: CrudCollection;
    /** Fields to show and their order; default is every declared field. */
    columns?: readonly CrudColumn[] | undefined;
}
/**
 * Resolves the screens one contributing extension serves, keyed by exact mount path (`/todos`). Called once at
 * ui activation with the route project root; the contributor reads its own declaration there.
 */
export type UiScreenSource = (context: { readonly root: string }) => Readonly<Record<string, UiScreen>> | Promise<Readonly<Record<string, UiScreen>>>;
/** One contributed screen source and the name of the extension that contributed it. */
export interface UiScreenContribution { readonly from: string; readonly source: UiScreenSource }
const screenPath = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Collects every contributed screen once, refusing a malformed one or a path two sources both claim, naming the contributors. */
async function contributedScreens(contributions: readonly UiScreenContribution[], root: string): Promise<Map<string, UiScreen>> {
    const screens = new Map<string, UiScreen>(), owners = new Map<string, string>();
    for (const contribution of contributions) {
        const from = isRecord(contribution) && typeof contribution.from === 'string' ? contribution.from : undefined;
        if (!from || typeof contribution.source !== 'function') throw new Error('ui screens contributions must be {from, source} with a source function');
        const source = contribution.source;
        const resolved: unknown = await source(Object.freeze({ root }));
        if (!isRecord(resolved)) throw new Error(`ui screens contributed by extension "${from}" must resolve to an object keyed by path`);
        for (const [path, screen] of Object.entries(resolved)) {
            if (path.length > 256 || !screenPath.test(path)) throw new Error(`ui screen path ${path} contributed by extension "${from}" must be an absolute literal path such as /todos`);
            const owner = owners.get(path);
            if (owner !== undefined) throw new Error(`ui screen ${path} is contributed by extension "${owner}" and by extension "${from}"`);
            owners.set(path, from);
            if (!isRecord(screen) || typeof screen.title !== 'string' || !screen.title.trim() || screen.title.length > 80 || /[\u0000-\u001f\u007f]/.test(screen.title)) throw new Error(`ui screen ${path} needs a plain title of 1 to 80 characters`);
            const value = screen as unknown as UiScreen;
            // Validate the collection and columns at activation so a bad key fails the start, not the first request.
            try { crudFields(value.collection, value.columns); } catch (error) { throw new Error(`ui screen ${path}: ${(error as Error).message}`, { cause: error }); }
            screens.set(path, Object.freeze({ title: value.title, collection: value.collection, ...(value.columns ? { columns: value.columns } : {}) }));
        }
    }
    return screens;
}
export function createUiExtension(options: UiExtensionOptions): UiExtension {
    if (typeof options.projectSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('ui extension requires an explicit operator revision pin');
    if (typeof options.projectRoot !== 'string' || !options.projectRoot) throw new Error('ui extension requires the project root');
    // The kits of the live activations, oldest first; the newest serves. A reload activates the replacement before
    // the serving runtime closes, so closing one activation drops only its own kit: the retiring runtime's close
    // leaves the replacement's, and a failed replacement's close leaves the serving one's (RIM-EXT-HANDOFF-001).
    const live: Kit[] = [];
    let kit: Kit | undefined;
    const registration: RuntimeExtension = {
        name: 'ui', version: '1', projectSha256: options.projectSha256, targets: ['node', 'aws', 'vercel'], schema: uiConfigSchema, hooks: uiHookContracts, authoring: uiAuthoring, immutableAssets: { prefix: uiAssetPrefix },
        async activate(config: Readonly<Record<string, unknown>>, context: ExtensionActivation): Promise<ExtensionInstance> {
            const screens = await contributedScreens(options.screens ?? [], context.root);
            // Screen paths are exact page mounts; the one remaining mount serves the kit's assets.
            for (const path of screens.keys()) if (!context.mounts.includes(path)) throw new Error(`ui screen ${path} needs a route ${path}/* with extension: ui`);
            const assetMounts = context.mounts.filter(candidate => !screens.has(candidate));
            const mount = assetMounts[0];
            if (assetMounts.length !== 1 || !mount) throw new Error('ui extension needs exactly one route mount, for example /assets/ui/*');
            const project = await loadProjectUi(options.projectRoot, config as UiConfig);
            const theme = { ...(options.theme ?? {}), ...((config.theme as Theme | undefined) ?? {}) };
            const presentation = createPresentation({ defaults: mergeCatalogues([kitCatalogue, ...(options.sources ?? [])]), catalogues: project.catalogues, ...(project.languages[0] ? { defaultLocale: project.languages[0] } : {}) });
            const assetsBase = mount + uiAssetPrefix;
            const baseKit = createKit({ presentation, theme, templates: project.templates, extensions: options.extensions, stylesheet: project.stylesheet, assetsBase });
            const hooks = await loadExtensionHooks<'transformView' | 'transformPage'>(config.hooks as Readonly<Record<string, unknown>> | undefined, uiHookContracts, context);
            const transform = (name: string, view: ViewModel): ViewModel => {
                if (!hooks.transformView) return view;
                const result = hooks.transformView(Object.freeze({ template: name, view }), extensionHookContext());
                if (result instanceof Promise) throw new Error('ui transformView hook must return synchronously');
                if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('ui transformView hook must return a view object');
                return result as ViewModel;
            };
            const render = (name: string, view: ViewModel, renderContext: PresentationContext) => baseKit.render(name, transform(name, view), renderContext);
            const transformPage = (page: PageOptions): PageOptions => {
                if (!hooks.transformPage) return page;
                const editable = Object.freeze({
                    title: page.title,
                    layout: page.layout ?? 'default',
                    nav: page.nav ?? null,
                    menu: page.menu ?? null,
                    flash: page.flash ?? null,
                });
                const result = hooks.transformPage(Object.freeze({ page: editable }), extensionHookContext());
                if (result instanceof Promise) throw new Error('ui transformPage hook must return synchronously');
                if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('ui transformPage hook must return a page object');
                const changed = result as Record<string, unknown>;
                const allowed = new Set(['title', 'layout', 'nav', 'menu', 'flash']);
                if (Object.keys(changed).some(key => !allowed.has(key))) throw new Error('ui transformPage hook returned an unsupported page field');
                return { ...page, ...changed } as PageOptions;
            };
            const mine: Kit = Object.freeze({
                ...baseKit,
                render,
                wrap(content: ReturnType<typeof render>, page: PageOptions) {
                    return baseKit.wrap(content, transformPage(page));
                },
                page(name: string, view: ViewModel, page: PageOptions) {
                    const renderContext = page.context ?? baseKit.resolveContext(page.preferences);
                    return baseKit.wrap(render(name, view, renderContext), transformPage({ ...page, context: renderContext }));
                },
            });
            live.push(mine); kit = mine;
            const byPath = new Map(mine.assets.map(asset => [`${assetsBase}/${asset.name}`, asset]));
            return {
                // The one non-screen mount serves only the kit's content-hashed files and 404 for anything else, so audit
                // covers it by this contract after probing an unknown name; screen mounts keep ordinary fixture coverage.
                assetMounts: [mount],
                handle(request: ExtensionRequest): HandlerResult {
                    const screen = request.mount !== null ? screens.get(request.mount) : undefined;
                    if (screen) {
                        if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: [['allow', 'GET, HEAD'], ['content-type', 'text/plain; charset=utf-8']], body: 'Method not allowed' };
                        if (request.path !== request.mount) return { status: 404, headers: [['content-type', 'text/plain; charset=utf-8']], body: 'Not found' };
                        const language = request.headers.get('accept-language');
                        const page = crudScreen(mine, { collection: screen.collection, ...(screen.columns ? { columns: screen.columns } : {}), title: screen.title, preferences: { ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(language ? { acceptLanguage: language } : {}) } });
                        return { status: page.status, headers: page.headers, body: request.method === 'HEAD' ? undefined : page.body };
                    }
                    if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: [['allow', 'GET, HEAD'], ['content-type', 'text/plain; charset=utf-8']], body: 'Method not allowed' };
                    const asset = byPath.get(request.path);
                    if (!asset) return { status: 404, headers: [['content-type', 'text/plain; charset=utf-8']], body: 'Not found' };
                    // One strong ETag, no Set-Cookie and no Vary: the runtime's immutable cache exception depends on it.
                    const headers: [string, string][] = [['content-type', asset.contentType], ['etag', `"${asset.hash}"`], ['x-content-type-options', 'nosniff'], ['cross-origin-resource-policy', 'same-origin']];
                    if (request.headers.get('if-none-match') === `"${asset.hash}"`) return { status: 304, headers };
                    return { status: 200, headers, body: request.method === 'HEAD' ? undefined : asset.body };
                },
                close() { const index = live.indexOf(mine); if (index >= 0) live.splice(index, 1); kit = live.at(-1); },
            };
        },
    };
    return Object.freeze({
        registration,
        get kit(): Kit { if (!kit) throw new Error('ui extension is not active; the runtime activates it before requests are served'); return kit; },
        get active(): boolean { return kit !== undefined; },
    });
}
