/**
 * `scaffold(request)` for `urlcode extensions add ui`: the `extensions.ui`
 * configuration, routes and `ui/` override files for a site. It writes nothing
 * (core writes the result); it only loads the installed extensions' definitions
 * to learn which contribute ui templates.
 */
import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { loadExtensionNamespaces } from './namespaces.ts';

/** Where the site keeps its presentation overrides, relative to the site directory (outside `app/`). */
export const uiDirectory = 'ui';
const segments = (path: string): string[] => path.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.');
/** Basename of a path without `node:path`; a trailing separator is ignored. */
export const directoryName = (path: string): string => segments(path).at(-1) ?? '';
/**
 * `--extensions` for the generated commands: every installed extension package whose definition contributes ui
 * templates, found the way the CLI loads them. One that cannot be resolved or loaded from the site is left out.
 */
async function extensionsFlag(site: string, installed: readonly string[]): Promise<string> {
    const packages: string[] = [];
    for (const specifier of installed.filter(name => name !== 'ui').map(name => `@jimhoyd/urlcode-${name}`)) {
        try { if ((await loadExtensionNamespaces([specifier], site)).loaded.length) packages.push(specifier); }
        catch { /* Not loadable here: the hint omits it, and the CLI reports it when named. */ }
    }
    return packages.length ? ` --extensions ${packages.join(',')}` : '';
}
/** Describes ui's configuration, routes and override files for a site without writing anything. */
export async function scaffold(request: ScaffoldRequest): Promise<ScaffoldResult> {
    const { site, installed } = request;
    const name = directoryName(site).replace(/[^A-Za-z0-9 ._-]/g, ' ').trim().slice(0, 80) || 'Site';
    const withAuth = installed.includes('auth');
    const flag = await extensionsFlag(site, installed);
    return {
        config: {
            theme: { name, colors: { primary: '220 9% 46%', primaryForeground: '0 0% 100%', dark: { primary: '220 9% 72%', primaryForeground: '224 10% 10%' } } },
            languages: ['en'],
            // Resolved against the site directory (the host's projectRoot), so ui/ lives beside host.mjs, outside app/.
            copy: `${uiDirectory}/copy`,
            templates: `${uiDirectory}/templates`,
            stylesheet: `${uiDirectory}/extra.css`,
        },
        routes: {
            '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] },
        },
        files: [
            { path: `${uiDirectory}/copy/.gitkeep`, content: '' },
            { path: `${uiDirectory}/templates/.gitkeep`, content: '' },
            { path: `${uiDirectory}/extra.css`, content: `/* Appended after the kit stylesheet (extensions.ui.stylesheet). Override shadcn/ui variables or add rules here; imports, scripts and expressions are refused. */\n` },
        ],
        notes: [
            `Customize ui/copy/<locale>.json, ui/templates/<name>.html and ui/extra.css; check them with npx urlcode-ui doctor --project .${flag} --copy ${uiDirectory}/copy --templates ${uiDirectory}/templates --stylesheet ${uiDirectory}/extra.css`,
            `Copy a shipped template to customize it: npx urlcode-ui eject ${withAuth ? 'auth/sign-in' : 'layout'} --out ${uiDirectory}/templates${flag}`,
        ],
    };
}
