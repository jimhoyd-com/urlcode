/**
 * Node-only: loads the template namespaces and English copy that peer
 * extension packages contribute to the kit, so the CLI sees what a generated
 * host registers. It reads exactly what `composeHost` hands ui: the
 * `contributes.ui` value (`UiContribution`: `sources`, `templates`) of each
 * package's `./extension` definition.
 *
 * The packages are named by the operator and resolved with Node package
 * resolution from the project directory, so this package keeps no dependency
 * on any of them and stays the lower layer. Importing a definition runs no
 * `host()`. Nothing here imports the site's `host.mjs`: that module builds
 * services and reads secrets at its top level, and a read-only `list` or
 * `doctor` must not run it.
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionTemplates } from '../kit.ts';
import type { Catalogue } from '../presentation.ts';
import type { ViewModel } from '../template.ts';
import type { UiContribution } from './definition.ts';
/** Bounds on what one invocation may name; the composed site registers two packages. */
const namespaceLimits = Object.freeze({ specifiers: 16, specifierLength: 214 });
/** An npm package name with an optional subpath; nothing relative, absolute or URL-shaped. */
const specifierPattern = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[A-Za-z0-9-._~]+)*$/;
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;
interface LoadedNamespace { specifier: string; name: string; templates: number; catalogue: number; samples: number }
interface SkippedNamespace { specifier: string; reason: string }
interface NamespaceLoad {
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
/** One `contributes.ui.templates` entry, checked: the object `createUiExtension({ extensions })` takes. */
function asNamespace(value: unknown, specifier: string): ExtensionTemplates {
    if (!isRecord(value) || typeof value.name !== 'string' || !namePattern.test(value.name) || !stringRecord(value.templates) || (value.viewModels !== undefined && !stringRecord(value.viewModels)))
        throw new Error(`${specifier}/extension contributes an invalid ui template namespace`);
    return value as unknown as ExtensionTemplates;
}
/** The `contributes.ui` value of a package's `./extension` default export, when it has one. */
function uiContribution(module: Record<string, unknown>, specifier: string): UiContribution | undefined {
    const definition = (module.default as { definition?: unknown } | undefined)?.definition;
    if (!isRecord(definition)) throw new Error(`${specifier}/extension does not default-export an extension definition`);
    const ui = isRecord(definition.contributes) ? definition.contributes.ui : undefined;
    if (ui === undefined) return undefined;
    if (!isRecord(ui) || (ui.templates !== undefined && !Array.isArray(ui.templates)) || (ui.sources !== undefined && !Array.isArray(ui.sources)))
        throw new Error(`${specifier}/extension contributes an invalid ui value`);
    return ui as UiContribution;
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
 * Imports each package's `./extension` from `directory` and collects the kit
 * namespaces and copy its definition contributes to ui. A package that does
 * not resolve is skipped, so a command still runs in a site whose peers are
 * not installed; anything else the import throws is reported, rather than
 * leaving a namespace silently missing.
 */
export async function loadExtensionNamespaces(specifiers: readonly string[], directory: string): Promise<NamespaceLoad> {
    const load: NamespaceLoad = { namespaces: [], catalogues: [], sources: {}, samples: {}, loaded: [], skipped: [] };
    const require = createRequire(join(directory, 'urlcode-ui.resolution'));
    const seen = new Set<unknown>();
    for (const specifier of specifiers) {
        let module: Record<string, unknown>;
        let resolved: string;
        try { resolved = require.resolve(`${specifier}/extension`); }
        catch (error) {
            const code = (error as { code?: string } | null)?.code;
            if (code === 'MODULE_NOT_FOUND') { load.skipped.push({ specifier, reason: 'not installed' }); continue; }
            if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') { load.skipped.push({ specifier, reason: 'no ./extension entry' }); continue; }
            throw new Error(`Could not resolve ${specifier}/extension: ${error instanceof Error ? error.message : 'resolution failed'}`, { cause: error });
        }
        try { module = await import(pathToFileURL(resolved).href) as Record<string, unknown>; }
        catch (error) { throw new Error(`Could not load ${specifier}/extension: ${error instanceof Error ? error.message : 'import failed'}`, { cause: error }); }
        const contribution = uiContribution(module, specifier);
        // The contribution's copy, as composeHost hands it to ui (`sources`), each catalogue once.
        const sourceCatalogues = contribution?.sources ?? [];
        for (const catalogue of sourceCatalogues) {
            if (!isRecord(catalogue)) throw new Error(`${specifier}/extension contributes an invalid ui catalogue`);
            if (!seen.has(catalogue)) { seen.add(catalogue); load.catalogues.push(catalogue as Catalogue); }
        }
        let found = 0;
        for (const namespace of (contribution?.templates ?? []).map(value => asNamespace(value, specifier))) {
            if (seen.has(namespace)) continue;
            seen.add(namespace); found++;
            load.namespaces.push(namespace);
            const templates = namespace.templates ?? {};
            for (const [name, source] of Object.entries(templates)) load.sources[name] = source;
            const catalogue = namespace.catalogue;
            if (catalogue !== undefined) {
                if (!isRecord(catalogue)) throw new Error(`${specifier}/extension contributes an invalid catalogue for ${namespace.name}`);
                if (!seen.has(catalogue)) { seen.add(catalogue); load.catalogues.push(catalogue); }
            }
            const samples = namespace.samples;
            if (samples !== undefined) {
                if (!isRecord(samples)) throw new Error(`${specifier}/extension contributes invalid samples for ${namespace.name}`);
                for (const [name, sample] of Object.entries(samples)) if (isRecord(sample) && Object.hasOwn(templates, name)) load.samples[name] = sample;
            }
            // `catalogue` counts every key this namespace's copy brings: its own catalogue, or the contribution's sources.
            const copy = catalogue ?? Object.assign({}, ...sourceCatalogues) as Catalogue;
            load.loaded.push({ specifier, name: namespace.name, templates: Object.keys(templates).length, catalogue: Object.keys(copy).length, samples: isRecord(samples) ? Object.keys(samples).length : 0 });
        }
        if (!found) load.skipped.push({ specifier, reason: 'no ui templates contributed' });
    }
    return load;
}
