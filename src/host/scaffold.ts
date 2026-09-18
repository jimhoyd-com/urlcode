/**
 * `scaffold(request)` for core's `urlcode init --with ui`: the `ui` fragments
 * of a composed site, computed without touching the filesystem. Core resolves
 * `scaffold` from the package's main entry, so this module uses no Node
 * imports and is re-exported from both entries; the host module it describes
 * imports `createUiExtension` from `./host`.
 */
/** Shared scaffold contract (core `urlcode init --with`, auth, admin): what the caller has decided so far. */
export interface ScaffoldRequest {
    /** Absolute site directory the caller will create; file paths in the result are relative to it. Nothing is written by `scaffold`. */
    directory: string;
    /** Absolute route-project directory, `<directory>/app` (holds urlcode.yaml). */
    project: string;
    /** Absolute combined host module the caller writes, `<directory>/host.mjs`. */
    hostFile: string;
    /** Every extension name being composed, in `--with` order, including this one. */
    names: readonly string[];
}
export interface ScaffoldFile { path: string; content: string | Uint8Array; mode?: number }
export interface ScaffoldResult {
    name: string;
    extensions: Record<string, unknown>;
    routes: Record<string, unknown>;
    hostImports: string[];
    hostSetup: string[];
    hostEntries: string[];
    hostClose?: string[];
    files: ScaffoldFile[];
    readme: string;
    nextSteps: string[];
    env?: Record<string, string>;
}
/** Where the site keeps its presentation overrides, relative to the site directory (outside `app/`). */
export const uiDirectory = 'ui';
const segments = (path: string): string[] => path.replace(/\\/g, '/').split('/').filter(part => part !== '' && part !== '.');
const isAbsolute = (path: string): boolean => path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path);
/** Basename of a path without `node:path`; a trailing separator is ignored. */
export const directoryName = (path: string): string => segments(path).at(-1) ?? '';
/** POSIX-style relative path from one absolute directory to another, for a `new URL(..., import.meta.url)` reference. */
function relativeReference(from: string, to: string): string {
    const source = segments(from), target = segments(to);
    let common = 0;
    while (common < source.length && common < target.length && source[common] === target[common]) common++;
    const parts = [...Array.from({ length: source.length - common }, () => '..'), ...target.slice(common)];
    return (parts.length ? parts.join('/') : '.') + '/';
}
function readmeSection(): string {
    return `The \`ui\` extension owns \`extensions.ui\` in \`app/urlcode.yaml\` and serves the kit's content-hashed stylesheet and scripts under \`/assets/ui/static/\`. The starter theme carries the site name and a neutral primary colour; edit the block to set a logo, favicon, colours, radius or font. The \`${uiDirectory}/\` directory beside the host holds the project's presentation overrides and stays outside \`app/\`: \`${uiDirectory}/copy/<locale>.json\` translates or rewords catalogue ids for the listed languages, any \`${uiDirectory}/templates/<name>.html\` shadows a kit or extension template, and \`${uiDirectory}/extra.css\` is appended after the kit stylesheet. Templates are data in the kit language: they cannot add scripts, change what a form validates or what a page sends in headers.

The host lists \`ui.registration\` first so \`ui.kit\` is active before the extensions that render through it. Core composes \`host.mjs\` in \`--with\` order, so name \`ui\` first: \`urlcode init <directory> --with ui,auth,admin\`. The ui setup reads the reviewed project revision from \`PROJECT_SHA256\` under its own identifier and needs nothing from the other extensions. Extensions that ship English copy or templates are registered through \`sources\` and \`extensions\` in the host once they adopt the kit.

\`\`\`sh
# List templates, overrides and translation coverage as the runtime would see them.
npx urlcode-ui doctor --project . --copy ${uiDirectory}/copy --templates ${uiDirectory}/templates --stylesheet ${uiDirectory}/extra.css
# Copy the shipped layout into the project to customise it (never overwrites).
npx urlcode-ui eject layout --out ${uiDirectory}/templates
\`\`\`
`;
}
/** Describes ui's contribution to a composed project without writing anything. */
export async function scaffold(request: ScaffoldRequest): Promise<ScaffoldResult> {
    if (!request || typeof request !== 'object') throw new Error('A scaffold request is required');
    for (const key of ['directory', 'project', 'hostFile'] as const) {
        const value = request[key];
        if (typeof value !== 'string' || !value || value.includes('\0') || !isAbsolute(value)) throw new Error(`Scaffold request needs an absolute ${key}`);
    }
    if (!Array.isArray(request.names) || request.names.some(name => typeof name !== 'string')) throw new Error('Scaffold names must be strings');
    if (!request.names.includes('ui')) throw new Error('Scaffold names must include ui');
    const name = directoryName(request.directory).replace(/[^A-Za-z0-9 ._-]/g, ' ').trim().slice(0, 80) || 'Site';
    // The host resolves the site directory from its own location, so the generated module stays relocatable.
    const hostDirectory = segments(request.hostFile).slice(0, -1).join('/');
    const siteReference = relativeReference('/' + hostDirectory, request.directory);
    return {
        name: 'ui',
        extensions: {
            ui: {
                version: '1',
                config: {
                    theme: { name, colors: { primary: '220 9% 46%', primaryForeground: '0 0% 100%', dark: { primary: '220 9% 72%', primaryForeground: '224 10% 10%' } } },
                    languages: ['en'],
                    copy: `${uiDirectory}/copy`,
                    templates: `${uiDirectory}/templates`,
                    stylesheet: `${uiDirectory}/extra.css`,
                },
            },
        },
        routes: { '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] } },
        hostImports: ["import {fileURLToPath} from 'node:url';", "import {createUiExtension} from '@jimhoyd/urlcode-ui/host';"],
        hostSetup: [
            '// The ui extension pins the same reviewed revision as the runtime; it defines its own identifier so any --with order composes.',
            'const uiProjectSha256 = process.env.PROJECT_SHA256;',
            "if (!uiProjectSha256 || !/^[a-f0-9]{64}$/.test(uiProjectSha256)) throw new Error('Set the reviewed PROJECT_SHA256 revision');",
            `// The ui block's copy, templates and stylesheet paths resolve inside this directory (${uiDirectory}/ lives beside the host, outside app/).`,
            `const ui = createUiExtension({projectSha256: uiProjectSha256, projectRoot: fileURLToPath(new URL('${siteReference}', import.meta.url)), sources: []});`,
        ],
        hostEntries: ['ui.registration'],
        files: [
            { path: `${uiDirectory}/copy/.gitkeep`, content: '' },
            { path: `${uiDirectory}/templates/.gitkeep`, content: '' },
            { path: `${uiDirectory}/extra.css`, content: `/* Appended after the kit stylesheet (extensions.ui.stylesheet). Override shadcn/ui variables or add rules here; imports, scripts and expressions are refused. */\n` },
        ],
        readme: readmeSection(),
        nextSteps: [
            `npx urlcode-ui doctor --project . --copy ${uiDirectory}/copy --templates ${uiDirectory}/templates --stylesheet ${uiDirectory}/extra.css`,
            `npx urlcode-ui eject layout --out ${uiDirectory}/templates`,
        ],
        env: { PROJECT_SHA256: 'Reviewed project revision from inspectExtensionRevision; re-review after any project change.' },
    };
}
