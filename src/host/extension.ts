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
import type { ExtensionTemplates, Kit } from '../kit.ts';
import { loadProjectUi } from './loader.ts';
import type { UiConfig } from './loader.ts';
/*
 * Structural copies of the runtime's extension contract (`@jimhoyd/urlcode/extensions`,
 * core PRs #59 and #93), so this package keeps no dependency on the runtime. The
 * runtime checks the registration shape at activation.
 */
export type HeaderPair = [string, string];
/** The runtime's deployment targets, copied literally from core's `TargetName` (`src/types.ts`) so `targets` needs no cast. */
export type TargetName = 'node' | 'vercel' | 'aws' | 'cloudflare';
export interface HandlerResult { status: number; headers: HeaderPair[]; body?: string | Uint8Array | null | undefined; contentLength?: number }
export interface ExtensionActivation { origin: string; target: TargetName; projectSha256: string; mounts: readonly string[] }
export interface ExtensionRequest {
    method: string; target: string; path: string; query: URLSearchParams; headers: Headers;
    headerCounts: Record<string, number>; body: Uint8Array; origin: string; route: string; mount: string | null; client: string | null;
}
export interface ExtensionInstance {
    handle(request: ExtensionRequest): HandlerResult | Promise<HandlerResult>;
    authorize?(requirement: Readonly<Record<string, unknown>>, request: ExtensionRequest): HandlerResult | undefined | Promise<HandlerResult | undefined>;
    close?(): void | Promise<void>;
}
/**
 * Content-hashed assets under `<mount><prefix>/` may be cached publicly: the
 * runtime relaxes its no-store floor to `public, max-age=31536000, immutable`
 * only for a GET/HEAD 200/304 that carries exactly one strong ETag, sets no
 * cookie and does not vary on Cookie or Authorization.
 */
export interface ExtensionImmutableAssets { prefix: string }
export interface RuntimeExtension {
    name: string; version: '1'; projectSha256: string; targets: TargetName[];
    schema: object; policySchema?: object; credentialHeaders?: string[]; immutableAssets?: ExtensionImmutableAssets;
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
    },
} as const;
export function createUiExtension(options: UiExtensionOptions): UiExtension {
    if (typeof options.projectSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('ui extension requires an explicit operator revision pin');
    if (typeof options.projectRoot !== 'string' || !options.projectRoot) throw new Error('ui extension requires the project root');
    let kit: Kit | undefined;
    const registration: RuntimeExtension = {
        name: 'ui', version: '1', projectSha256: options.projectSha256, targets: ['node', 'aws', 'vercel'], schema: uiConfigSchema, immutableAssets: { prefix: uiAssetPrefix },
        async activate(config: Readonly<Record<string, unknown>>, context: ExtensionActivation): Promise<ExtensionInstance> {
            const mount = context.mounts[0];
            if (context.mounts.length !== 1 || !mount) throw new Error('ui extension needs exactly one route mount, for example /assets/ui/*');
            const project = await loadProjectUi(options.projectRoot, config as UiConfig);
            const theme = { ...(options.theme ?? {}), ...((config.theme as Theme | undefined) ?? {}) };
            const presentation = createPresentation({ defaults: mergeCatalogues([kitCatalogue, ...(options.sources ?? [])]), catalogues: project.catalogues, ...(project.languages[0] ? { defaultLocale: project.languages[0] } : {}) });
            const assetsBase = mount + uiAssetPrefix;
            kit = createKit({ presentation, theme, templates: project.templates, extensions: options.extensions, stylesheet: project.stylesheet, assetsBase });
            const byPath = new Map(kit.assets.map(asset => [`${assetsBase}/${asset.name}`, asset]));
            return {
                handle(request: ExtensionRequest): HandlerResult {
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
