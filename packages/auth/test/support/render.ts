/** The kit is the only render path: every HTTP suite supplies and activates the `ui` extension the way a host does. */
import type { TestContext } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createUiExtension } from '@jimhoyd/urlcode-ui/host';
import type { UiExtension } from '@jimhoyd/urlcode-ui/host';
import type { RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { englishCatalogue } from '../../src/presentation.ts';
import { authUiTemplates } from '../../src/auth-templates.ts';
export interface KitSetup { ui: UiExtension; registrations: RuntimeExtension[]; extensions: Record<string, unknown>; routes: Record<string, unknown> }
/** The `extensions.ui`, `audit` and `mail` blocks and ui's asset route, written into the project before there is a revision to pin. */
export function kitYaml(config: Record<string, unknown> = {}): { extensions: Record<string, unknown>; routes: Record<string, unknown> } {
    // Auth requires audit and mail: every project that hosts auth declares them (siteCompanions registers them).
    return { extensions: { ui: { version: '1', config }, audit: { version: '1', config: {} }, mail: { version: '1', config: {} } }, routes: { '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] } } };
}
/** The ui extension the host declares before auth, pinned to the written project's revision. */
export function kitSetup(project: string, projectSha256: string, config: Record<string, unknown> = {}): KitSetup {
    const ui = createUiExtension({ projectSha256, projectRoot: project, sources: [englishCatalogue], extensions: [authUiTemplates] });
    // The ui package mirrors the runtime contract structurally with `targets: string[]`; the runtime checks the shape at activation.
    return { ui, registrations: [ui.registration as unknown as RuntimeExtension], ...kitYaml(config) };
}
/** For suites that call `activate` directly: the real ui extension, activated on its asset mount the way the runtime would; `config` is `extensions.ui.config`. */
export async function activatedUi(t: TestContext, projectRoot: string, projectSha256: string, origin = 'https://example.test', config: Record<string, unknown> = {}): Promise<UiExtension> {
    const ui = createUiExtension({ projectSha256, projectRoot, sources: [englishCatalogue], extensions: [authUiTemplates] });
    const instance = await ui.registration.activate(config, { origin, target: 'node', projectSha256, mounts: ['/assets/ui'], root: projectRoot });
    t.after(() => instance.close?.());
    return ui;
}
/** A response body as text: core's JSON responses carry a string, the kit's pages bytes. */
export function bodyText(body: unknown): string {
    return typeof body === 'string' ? body : body === undefined || body === null ? '' : new TextDecoder().decode(body as Uint8Array);
}
/** Writes project copy catalogues to `<root>/ui/copy/<locale>.json`, the way a project translates auth, and returns the `extensions.ui.config` that loads them. */
export async function writeCopy(root: string, catalogues: Readonly<Record<string, Readonly<Record<string, string>>>>): Promise<Record<string, unknown>> {
    await mkdir(join(root, 'ui', 'copy'), { recursive: true });
    for (const [locale, catalogue] of Object.entries(catalogues))
        await writeFile(join(root, 'ui', 'copy', locale + '.json'), JSON.stringify(catalogue));
    return { languages: ['en', ...Object.keys(catalogues)], copy: 'ui/copy' };
}
