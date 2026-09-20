/** The kit is the only render path: every HTTP suite supplies and activates the `ui` extension the way a host does. */
import type { TestContext } from 'node:test';
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { englishCatalogue } from '../../src/presentation.ts';
import { authUiTemplates } from '../../src/auth-templates.ts';
export interface KitSetup { ui: UiExtension; registrations: RuntimeExtension[]; extensions: Record<string, unknown>; routes: Record<string, unknown> }
/** The `extensions.ui` block and its asset route, written into the project before there is a revision to pin. */
export function kitYaml(config: Record<string, unknown> = {}): { extensions: Record<string, unknown>; routes: Record<string, unknown> } {
    return { extensions: { ui: { version: '1', config } }, routes: { '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] } } };
}
/** The ui extension the host declares before auth, pinned to the written project's revision. */
export function kitSetup(project: string, projectSha256: string, config: Record<string, unknown> = {}): KitSetup {
    const ui = createUiExtension({ projectSha256, projectRoot: project, sources: [englishCatalogue], extensions: [authUiTemplates] });
    // The ui package mirrors the runtime contract structurally with `targets: string[]`; the runtime checks the shape at activation.
    return { ui, registrations: [ui.registration as unknown as RuntimeExtension], ...kitYaml(config) };
}
/** For suites that call `activate` directly: the real ui extension, activated on its asset mount the way the runtime would. */
export async function activatedUi(t: TestContext, projectRoot: string, projectSha256: string, origin = 'https://example.test'): Promise<UiExtension> {
    const ui = createUiExtension({ projectSha256, projectRoot, sources: [englishCatalogue], extensions: [authUiTemplates] });
    const instance = await ui.registration.activate({}, { origin, target: 'node', projectSha256, mounts: ['/assets/ui'], root: projectRoot });
    t.after(() => instance.close?.());
    return ui;
}
