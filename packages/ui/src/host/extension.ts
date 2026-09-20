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
import { extensionHooksSchema, loadExtensionHooks } from '@jimhoyd/urlcode/extensions';
import type { ExtensionHookContract } from '@jimhoyd/urlcode/extensions';
import { crudFields, crudScreen, fieldLabel } from '../crud.ts';
import type { CrudCollection, CrudColumn } from '../crud.ts';
import { loadProjectUi } from './loader.ts';
import type { UiConfig } from './loader.ts';
/*
 * Structural copies of the runtime's extension contract (`@jimhoyd/urlcode/extensions`,
 * core PRs #59 and #93), so this package keeps no dependency on the runtime. The
 * runtime checks the registration shape at activation.
 *
 * This copy is pinned to core's contract as of PRs #127/#130 (`ExtensionActivation.root`,
 * `ExtensionInstance.middleware()`) and is not auto-synced with core's `src/extensions.ts`;
 * re-check that file for drift before relying on this copy being current. This package's
 * own extension implements `handle()` only and doesn't need `root` (it already receives
 * the project directory as `UiExtensionOptions.projectRoot`, resolved independently of
 * activation) or `middleware()` today, but the copied types must still match core's real
 * shape so a stale copy doesn't silently misrepresent the contract.
 */
export type HeaderPair = [string, string];
/** The runtime's deployment targets, copied literally from core's `TargetName` (`src/types.ts`) so `targets` needs no cast. */
export type TargetName = 'node' | 'vercel' | 'aws' | 'cloudflare';
export interface HandlerResult { status: number; headers: HeaderPair[]; body?: string | Uint8Array | null | undefined; contentLength?: number }
export interface ExtensionActivation { origin: string; target: TargetName; projectSha256: string; mounts: readonly string[]; root: string }
export interface ExtensionRequest {
    method: string; target: string; path: string; query: URLSearchParams; headers: Headers;
    headerCounts: Record<string, number>; body: Uint8Array; origin: string; route: string; mount: string | null; client: string | null;
}
export interface ExtensionInstance {
    handle(request: ExtensionRequest): HandlerResult | Promise<HandlerResult>;
    authorize?(requirement: Readonly<Record<string, unknown>>, request: ExtensionRequest): HandlerResult | undefined | Promise<HandlerResult | undefined>;
    middleware?(config: Readonly<Record<string, unknown>>, request: ExtensionRequest, next: () => Promise<HandlerResult>): HandlerResult | Promise<HandlerResult>;
    close?(): void | Promise<void>;
}
/**
 * Content-hashed assets under `<mount><prefix>/` may be cached publicly: the
 * runtime relaxes its no-store floor to `public, max-age=31536000, immutable`
 * only for a GET/HEAD 200/304 that carries exactly one strong ETag, sets no
 * cookie and does not vary on Cookie or Authorization.
 */
export interface ExtensionImmutableAssets { prefix: string }
export interface ExtensionAuthoringSurface { kind: 'configuration' | 'theme' | 'copy' | 'component' | 'template' | 'stylesheet' | 'hook' | 'extension'; name: string; description: string; path?: string; command?: string }
export interface ExtensionAuthoringContract { description: string; surfaces: readonly ExtensionAuthoringSurface[]; fastChecks?: readonly string[] }
export interface RuntimeExtension {
    name: string; version: '1'; projectSha256: string; targets: TargetName[];
    schema: object; policySchema?: object; credentialHeaders?: string[]; immutableAssets?: ExtensionImmutableAssets; hooks?: readonly ExtensionHookContract[]; authoring?: ExtensionAuthoringContract;
    activate(config: Readonly<Record<string, unknown>>, context: ExtensionActivation): ExtensionInstance | Promise<ExtensionInstance>;
}
/** Mount-relative prefix under which the kit's content-hashed assets are served; declared as `immutableAssets`. */
export const uiAssetPrefix = '/static';
export interface UiExtensionOptions {
    /** The exact reviewed project revision, from `inspectExtensionRevision`. */
    projectSha256: string;
    /** The project directory, so the extension can read the copy, template and stylesheet files the block names. */
    projectRoot: string;
    /** English catalogues from other extensions, registered before activation. */
    sources?: readonly Catalogue[] | undefined;
    /** Templates other extensions ship under their namespace. */
    extensions?: readonly ExtensionTemplates[] | undefined;
    /** Theme values the host sets that the project may not, none by default. */
    theme?: Theme | undefined;
}
export interface UiExtension {
    readonly registration: RuntimeExtension;
    /** The kit, available once the runtime has activated the extension. */
    readonly kit: Kit;
    readonly active: boolean;
}
const colorSchema = { type: 'string', maxLength: 32 };
const colors = { type: 'object', additionalProperties: false, properties: Object.fromEntries(['background', 'foreground', 'card', 'cardForeground', 'popover', 'popoverForeground', 'primary', 'primaryForeground', 'secondary', 'secondaryForeground', 'muted', 'mutedForeground', 'accent', 'accentForeground', 'destructive', 'destructiveForeground', 'border', 'input', 'ring'].map(name => [name, colorSchema])) };
export const uiHookContracts = [{
    name: 'transformView', kind: 'filter',
    description: 'Runs before a named kit template renders and returns the view model to render.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['template', 'view'], properties: { template: { type: 'string' }, view: { type: 'object' } } },
    outputSchema: { type: 'object' },
}, {
    name: 'transformPage', kind: 'filter',
    description: 'Runs before the shared page layout renders and may change its title, layout, navigation, account menu or flash message.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['page'], properties: { page: { type: 'object' } } },
    outputSchema: { type: 'object' },
}] as const satisfies readonly ExtensionHookContract[];
export const uiAuthoring: ExtensionAuthoringContract = Object.freeze({
    description: 'Keep the site as one application: customize the installed UI in the project and keep auth/admin behavior in their packages. Use a new extension only for a capability the installed extensions do not provide.',
    surfaces: Object.freeze([
        { kind: 'theme' as const, name: 'theme', description: 'Set brand name, local assets, semantic light/dark colours, radius and font in extensions.ui.config.theme.', path: 'urlcode.yaml#extensions.ui.config.theme' },
        { kind: 'copy' as const, name: 'copy', description: 'Override or translate catalogue entries without copying a screen.', path: 'ui/copy/<locale>.json' },
        { kind: 'template' as const, name: 'templates', description: 'Override only the screen or shared partial whose structure must change; doctor reports view-model drift.', path: 'ui/templates/<name>.html', command: 'urlcode-ui list --project . --extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin' },
        { kind: 'stylesheet' as const, name: 'stylesheet', description: 'Append project CSS after the shared stylesheet; use semantic shadcn tokens and existing ui-* component classes.', path: 'ui/extra.css' },
        { kind: 'hook' as const, name: 'transformView', description: 'Add computed project data to a named view immediately before its template renders.', path: 'extensions.ui.config.hooks.transformView' },
        { kind: 'hook' as const, name: 'transformPage', description: 'Customize the shared page shell, navigation, account menu and flash immediately before layout rendering.', path: 'extensions.ui.config.hooks.transformPage' },
    ]),
    fastChecks: Object.freeze([
        'urlcode-ui doctor --project . --extensions @jimhoyd/urlcode-auth,@jimhoyd/urlcode-admin --copy ui/copy --templates ui/templates --stylesheet ui/extra.css',
        'urlcode validate --local',
    ]),
});
export const uiConfigSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object', additionalProperties: false,
    properties: {
        theme: {
            type: 'object', additionalProperties: false,
            properties: {
                name: { type: 'string', maxLength: 80 }, logo: { type: 'string', maxLength: 512 }, favicon: { type: 'string', maxLength: 512 }, backTo: { type: 'string', maxLength: 1024 },
                colors: { ...colors, properties: { ...colors.properties, dark: colors } },
                radius: { type: 'string', maxLength: 16 }, font: { type: 'string', maxLength: 128 },
            },
        },
        languages: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', maxLength: 35 } },
        copy: { type: 'string', maxLength: 256 },
        templates: { type: 'string', maxLength: 256 },
        stylesheet: { oneOf: [{ type: 'string', maxLength: 256 }, { type: 'object', additionalProperties: false, required: ['file'], properties: { file: { type: 'string', maxLength: 256 }, replace: { type: 'boolean' } } }] },
        hooks: extensionHooksSchema(uiHookContracts),
        screens: {
            type: 'object', maxProperties: 16,
            propertyNames: { pattern: '^/[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$', maxLength: 256 },
            additionalProperties: { type: 'object', additionalProperties: false, required: ['collection'], properties: { collection: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, title: { type: 'string', minLength: 1, maxLength: 80 }, columns: { type: 'array', minItems: 1, maxItems: 64, items: { oneOf: [{ type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string', pattern: '^[a-z][A-Za-z0-9_]{0,63}$' }, label: { type: 'string', minLength: 1, maxLength: 80 } } }] } } } },
        },
    },
} as const;
/** A screen the project declares: a mounted path served as a list and form for one store collection. */
interface ScreenConfig { collection: string; title?: string; columns?: CrudColumn[] }
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Reads the store's collection declarations from the reviewed project document, the one place the fields are declared. */
async function storeCollections(root: string): Promise<Record<string, CrudCollection>> {
    const { loadDocument } = await import('@jimhoyd/urlcode');
    const loaded = await loadDocument(root);
    const config = loaded.document.extensions?.store?.config;
    const collections = isRecord(config) && isRecord(config.collections) ? config.collections : undefined;
    if (!collections) throw new Error('ui screens read collections from extensions.store, which this project does not declare');
    return collections as unknown as Record<string, CrudCollection>;
}
export function createUiExtension(options: UiExtensionOptions): UiExtension {
    if (typeof options.projectSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('ui extension requires an explicit operator revision pin');
    if (typeof options.projectRoot !== 'string' || !options.projectRoot) throw new Error('ui extension requires the project root');
    let kit: Kit | undefined;
    const registration: RuntimeExtension = {
        name: 'ui', version: '1', projectSha256: options.projectSha256, targets: ['node', 'aws', 'vercel'], schema: uiConfigSchema, hooks: uiHookContracts, authoring: uiAuthoring, immutableAssets: { prefix: uiAssetPrefix },
        async activate(config: Readonly<Record<string, unknown>>, context: ExtensionActivation): Promise<ExtensionInstance> {
            const screens = (config.screens ?? {}) as Record<string, ScreenConfig>;
            // Screen paths are exact page mounts; the one remaining mount serves the kit's assets.
            const screenMounts = new Set(Object.keys(screens));
            for (const path of screenMounts) if (!context.mounts.includes(path)) throw new Error(`ui screen ${path} needs a route ${path}/* with extension: ui`);
            const assetMounts = context.mounts.filter(candidate => !screenMounts.has(candidate));
            const mount = assetMounts[0];
            if (assetMounts.length !== 1 || !mount) throw new Error('ui extension needs exactly one route mount, for example /assets/ui/*');
            let collections: Record<string, CrudCollection> = {};
            if (screenMounts.size) {
                collections = await storeCollections(context.root);
                for (const [path, screen] of Object.entries(screens)) {
                    if (!Object.hasOwn(collections, screen.collection)) throw new Error(`ui screen ${path} names collection ${screen.collection}, which extensions.store does not declare`);
                    // Validate columns at activation so a bad key fails the start, not the first request.
                    try { crudFields(collections[screen.collection]!, screen.columns); } catch (error) { throw new Error(`ui screen ${path}: ${(error as Error).message}`, { cause: error }); }
                }
            }
            const project = await loadProjectUi(options.projectRoot, config as UiConfig);
            const theme = { ...(options.theme ?? {}), ...((config.theme as Theme | undefined) ?? {}) };
            const presentation = createPresentation({ defaults: mergeCatalogues([kitCatalogue, ...(options.sources ?? [])]), catalogues: project.catalogues, ...(project.languages[0] ? { defaultLocale: project.languages[0] } : {}) });
            const assetsBase = mount + uiAssetPrefix;
            const baseKit = createKit({ presentation, theme, templates: project.templates, extensions: options.extensions, stylesheet: project.stylesheet, assetsBase });
            const hooks = await loadExtensionHooks<'transformView' | 'transformPage'>(config.hooks as Readonly<Record<string, unknown>> | undefined, uiHookContracts, context);
            const transform = (name: string, view: ViewModel): ViewModel => {
                if (!hooks.transformView) return view;
                const result = hooks.transformView(Object.freeze({ template: name, view }));
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
                const result = hooks.transformPage(Object.freeze({ page: editable }));
                if (result instanceof Promise) throw new Error('ui transformPage hook must return synchronously');
                if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('ui transformPage hook must return a page object');
                const changed = result as Record<string, unknown>;
                const allowed = new Set(['title', 'layout', 'nav', 'menu', 'flash']);
                if (Object.keys(changed).some(key => !allowed.has(key))) throw new Error('ui transformPage hook returned an unsupported page field');
                return { ...page, ...changed } as PageOptions;
            };
            kit = Object.freeze({
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
            const byPath = new Map(kit.assets.map(asset => [`${assetsBase}/${asset.name}`, asset]));
            return {
                handle(request: ExtensionRequest): HandlerResult {
                    const screen = request.mount !== null && Object.hasOwn(screens, request.mount) ? screens[request.mount] : undefined;
                    if (screen) {
                        if (request.method !== 'GET' && request.method !== 'HEAD') return { status: 405, headers: [['allow', 'GET, HEAD'], ['content-type', 'text/plain; charset=utf-8']], body: 'Method not allowed' };
                        if (request.path !== request.mount) return { status: 404, headers: [['content-type', 'text/plain; charset=utf-8']], body: 'Not found' };
                        const language = request.headers.get('accept-language');
                        const page = crudScreen(kit!, { collection: collections[screen.collection]!, ...(screen.columns ? { columns: screen.columns } : {}), title: screen.title ?? fieldLabel(screen.collection), preferences: { ...(request.query.get('lang') ? { queryLocale: request.query.get('lang')! } : {}), ...(language ? { acceptLanguage: language } : {}) } });
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
                close() { kit = undefined; },
            };
        },
    };
    return Object.freeze({
        registration,
        get kit(): Kit { if (!kit) throw new Error('ui extension is not active; the runtime activates it before requests are served'); return kit; },
        get active(): boolean { return kit !== undefined; },
    });
}
