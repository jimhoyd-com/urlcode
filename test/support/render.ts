/** Runs an HTTP suite under both render paths: the shared primitives, and the urlcode-ui kit through the `ui` extension. */
import type { TestContext } from 'node:test';
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { englishCatalogue } from '../../src/presentation.ts';
import { authUiTemplates } from '../../src/auth-templates.ts';
export type RenderPath = 'primitives' | 'kit';
export const renderPaths: readonly RenderPath[] = ['primitives', 'kit'];
/** The path a parametrized test runs under, read from its name suffix. */
export const renderOf = (t: TestContext): RenderPath => t.name.endsWith('[kit]') ? 'kit' : 'primitives';
/** Registers one test per render path; the suite's app helper reads `renderOf(t)`. */
export function eachRenderPath(test: (name: string, fn: (t: TestContext) => Promise<void>) => void, name: string, fn: (t: TestContext) => Promise<void>): void {
    for (const path of renderPaths) test(`${name} [${path}]`, fn);
}
export interface KitSetup { ui: UiExtension | undefined; registrations: RuntimeExtension[]; extensions: Record<string, unknown>; routes: Record<string, unknown> }
/** The `extensions.ui` block, its asset route and the ui extension the host declares before auth, or nothing on the primitive path. */
export function kitSetup(path: RenderPath, project: string, projectSha256: string, config: Record<string, unknown> = {}): KitSetup {
    const yaml = { extensions: { ui: { version: '1', config } }, routes: { '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] } } };
    if (path === 'primitives') return { ui: undefined, registrations: [], extensions: {}, routes: {} };
    // Before the project is written there is no revision to pin; only the YAML blocks are needed then.
    if (!projectSha256) return { ui: undefined, registrations: [], ...yaml };
    const ui = createUiExtension({ projectSha256, projectRoot: project, sources: [englishCatalogue], extensions: [authUiTemplates] });
    // The ui package mirrors the runtime contract structurally with `targets: string[]`; the runtime checks the shape at activation.
    return { ui, registrations: [ui.registration as unknown as RuntimeExtension], ...yaml };
}
