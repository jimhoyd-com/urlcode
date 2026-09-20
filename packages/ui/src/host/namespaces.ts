/**
 * Node-only: loads the template namespaces and English copy that peer
 * extension packages contribute to the kit (`@jimhoyd/urlcode-auth`'s
 * `authUiTemplates`, `@jimhoyd/urlcode-admin`'s `adminUiTemplates`), so the
 * CLI sees what a generated host registers.
 *
 * The packages are named by the operator and resolved with Node package
 * resolution from the project directory, so this package keeps no dependency
 * on any of them and stays the lower layer. Nothing here imports the site's
 * `host.mjs`: that module builds services and reads secrets at its top level,
 * and a read-only `list` or `doctor` must not run it.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionTemplates } from '../kit.ts';
import type { Catalogue } from '../presentation.ts';
import type { ViewModel } from '../template.ts';
/** Bounds on what one invocation may name; the composed site registers two packages. */
export const namespaceLimits = Object.freeze({ specifiers: 16, specifierLength: 214 });
/** An npm package name with an optional subpath; nothing relative, absolute or URL-shaped. */
const specifierPattern = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[A-Za-z0-9-._~]+)*$/;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
export interface LoadedNamespace { specifier: string; name: string; templates: number; catalogue: number; samples: number }
export interface SkippedNamespace { specifier: string; reason: string }
export interface NamespaceLoad {
    /** What `createKit({ extensions })` takes, in the order the packages were named. */
    namespaces: ExtensionTemplates[];
    /** English catalogues to register in the presentation defaults, as a host's `sources` does. */
    catalogues: Catalogue[];
    /** Template sources by full name, so `eject` can copy an extension's shipped template. */
    sources: Record<string, string>;
    /** View model samples by full name, so `preview` can render an extension's template. */
    samples: Record<string, ViewModel>;
    loaded: LoadedNamespace[];
    skipped: SkippedNamespace[];
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringRecord = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every(entry => typeof entry === 'string');
/**
 * A namespace contribution: the object a package hands to
 * `createUiExtension({ extensions })`. The shape is distinctive enough to find
 * by structure, so a package declares what it contributes once instead of
 * exporting it again under a name this module would have to know.
 */
function asNamespace(value: unknown): ExtensionTemplates | undefined {
    if (!isRecord(value) || typeof value.name !== 'string' || !namePattern.test(value.name)) return undefined;
    if (!stringRecord(value.templates)) return undefined;
    if (value.viewModels !== undefined && !stringRecord(value.viewModels)) return undefined;
    return value as unknown as ExtensionTemplates;
}
/** Splits `--extensions` into validated package specifiers. */
export function parseSpecifiers(value: string): string[] {
    const specifiers = value.split(',').map(entry => entry.trim()).filter(Boolean);
    if (specifiers.length > namespaceLimits.specifiers) throw new Error(`At most ${namespaceLimits.specifiers} extension packages`);
    for (const specifier of specifiers)
        if (specifier.length > namespaceLimits.specifierLength || !specifierPattern.test(specifier))
            throw new Error(`Not a package name: ${specifier.slice(0, 64)}`);
    return [...new Set(specifiers)];
}
/**
 * Imports each package from `directory` and collects the kit namespaces it
 * exports. A package that does not resolve is skipped, so a command still runs
 * in a site whose peers are not installed; anything else the import throws is
 * reported, rather than leaving a namespace silently missing.
 */
export async function loadExtensionNamespaces(specifiers: readonly string[], directory: string): Promise<NamespaceLoad> {
    const load: NamespaceLoad = { namespaces: [], catalogues: [], sources: {}, samples: {}, loaded: [], skipped: [] };
    const require = createRequire(join(directory, 'urlcode-ui.resolution'));
    const seen = new Set<unknown>();
    for (const specifier of specifiers) {
        let module: Record<string, unknown>;
        try { module = await import(pathToFileURL(require.resolve(specifier)).href) as Record<string, unknown>; }
        catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') { load.skipped.push({ specifier, reason: 'not installed' }); continue; }
            throw new Error(`Could not load ${specifier}: ${error instanceof Error ? error.message : 'import failed'}`, { cause: error });
        }
        let found = 0;
        for (const value of Object.values(module)) {
            const namespace = asNamespace(value);
            if (!namespace || seen.has(value)) continue;
            seen.add(value);
            found++;
            load.namespaces.push(namespace);
            const templates = namespace.templates ?? {};
            for (const [name, source] of Object.entries(templates)) load.sources[name] = source;
            const catalogue = (value as { catalogue?: unknown }).catalogue;
            if (catalogue !== undefined) {
                if (!isRecord(catalogue)) throw new Error(`${specifier} exports an invalid catalogue for ${namespace.name}`);
                if (!seen.has(catalogue)) { seen.add(catalogue); load.catalogues.push(catalogue as Catalogue); }
            }
            const samples = (value as { samples?: unknown }).samples;
            if (samples !== undefined) {
                if (!isRecord(samples)) throw new Error(`${specifier} exports invalid samples for ${namespace.name}`);
                for (const [name, sample] of Object.entries(samples)) if (isRecord(sample) && Object.hasOwn(templates, name)) load.samples[name] = sample as ViewModel;
            }
            load.loaded.push({ specifier, name: namespace.name, templates: Object.keys(templates).length, catalogue: isRecord(catalogue) ? Object.keys(catalogue).length : 0, samples: isRecord(samples) ? Object.keys(samples).length : 0 });
        }
        if (!found) load.skipped.push({ specifier, reason: 'no kit templates exported' });
    }
    return load;
}
