/**
 * The `ui` extension definition: what `urlcode extensions add ui` scaffolds and
 * what host.mjs activates through `composeHost`. Published as the package's
 * `./extension` entry.
 */
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { Catalogue } from '../presentation.ts';
import type { ExtensionTemplates } from '../kit.ts';
import type { Theme } from '../theme.ts';
import { createUiExtension, uiAuthoring, uiConfigSchema, uiHookContracts } from './extension.ts';
import type { UiExtension, UiScreenSource } from './extension.ts';
import { scaffold } from './scaffold.ts';

/**
 * What another extension contributes to ui through its definition's `contributes: {ui: ...}`: English copy
 * registered in the presentation defaults, templates shipped under its own namespace, and optionally the data
 * screens it wants ui to serve. ui never reads another extension's configuration: a contributor that owns
 * collections resolves its own declaration in `screens` and hands ui a generic description of each screen.
 */
export interface UiContribution {
    sources?: readonly Catalogue[] | undefined;
    templates?: readonly ExtensionTemplates[] | undefined;
    /** Resolves `{path: {title, collection: {mount, fields, ...}, columns?}}` once at ui activation. */
    screens?: UiScreenSource | undefined;
}
/** Operator options from host.mjs, `ui({...})`; all optional. */
export interface UiHostOptions {
    /** Extra English catalogues, registered after the installed extensions' contributions. */
    sources?: readonly Catalogue[] | undefined;
    /** Extra extension templates, registered after the installed extensions' contributions. */
    extensions?: readonly ExtensionTemplates[] | undefined;
    /** Theme values the host sets that the project may not. */
    theme?: Theme | undefined;
}

export default defineExtension<UiHostOptions>({
    name: 'ui',
    description: 'Shared presentation kit: theme, copy, templates and the data screens other extensions contribute, for every extension page.',
    schema: uiConfigSchema,
    hooks: uiHookContracts,
    authoring: uiAuthoring,
    agent: {description: 'Local, revision-pinned references for agents configuring the UI extension.', references: [{name: 'UI extension guide', description: 'Configuration and theming guidance for the UI extension.', path: 'README.md'}]},
    scaffold,
    host(context, options) {
        const contributions = context.contributions<UiContribution>('ui');
        const ui: UiExtension = createUiExtension({
            projectSha256: context.projectSha256,
            // The block's copy, templates and stylesheet paths resolve against the site: ui/ lives beside host.mjs.
            projectRoot: context.site,
            sources: [...contributions.flatMap(contribution => contribution.sources ?? []), ...(options.sources ?? [])],
            extensions: [...contributions.flatMap(contribution => contribution.templates ?? []), ...(options.extensions ?? [])],
            screens: contributions.flatMap(contribution => contribution.screens ? [contribution.screens] : []),
            ...(options.theme ? { theme: options.theme } : {}),
        });
        return { registration: ui.registration, exports: ui };
    },
});
