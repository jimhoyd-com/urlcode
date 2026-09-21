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
    /** Every extension name being composed, including this one, in a canonical order independent of the `--with` spelling. */
    names: readonly string[];
    distribution?: 'npm' | 'bundle';
}
export interface ScaffoldFile { path: string; content: string | Uint8Array; mode?: number }
export interface ScaffoldResult {
    name: string;
    /** Composition contract: capabilities offered, extensions or capabilities required (and ordered before), ordered-after-if-present, and refused together. */
    provides?: string[];
    requires?: string[];
    after?: string[];
    conflicts?: string[];
    extensions: Record<string, unknown>;
    routes: Record<string, unknown>;
    hostImports: string[];
    hostSetup: string[];
    hostEntries: string[];
    hostClose?: string[];
    hostBundleExports?: string[];
    files: ScaffoldFile[];
    readme: string;
    nextSteps: string[];
    env?: Record<string, string>;
}
/** Path of the generated list and form screen when `store` is composed. */
const todosScreen = '/todos';
const storeSection = `
The \`store\` extension is composed too, so \`extensions.ui.config.screens\` serves \`${todosScreen}\` as a list and create/edit form for the \`todos\` collection. The ui extension reads that collection's fields from \`extensions.store\` in \`app/urlcode.yaml\` when it starts, so a field added there appears in the API and on the screen without a second declaration. The screen calls the store's own \`/api/todos\` from the browser with the kit's nonce-checked script; it adds no handler code and no inline script. Remove the \`screens\` entry and the \`${todosScreen}\` route to keep the API without the screen.
`;
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
/** The packages whose kit namespaces `urlcode-ui` should load for this composition, in a fixed order. */
function namespacePackages(names: readonly string[]): string[] {
    return ['auth', 'admin'].filter(name => names.includes(name)).map(name => `@jimhoyd/urlcode-${name}`);
}
/** `--extensions` for the generated commands; empty when this site composes nothing but ui. */
function extensionsFlag(names: readonly string[]): string {
    const packages = namespacePackages(names);
    return packages.length ? ` --extensions ${packages.join(',')}` : '';
}
function readmeSection(names: readonly string[]): string {
    const flag = extensionsFlag(names);
    const cliNote = flag
        ? ' The commands below carry the packages this site composes, so `list` and `doctor` cover the `auth/*` and `admin/*` templates beside the kit templates, a project override of an extension template is checked against the shipped view model it has to keep up with, `eject` can copy one, and `copy --missing` covers the copy ids the account screens use.'
        : '';
    return `The \`ui\` extension owns \`extensions.ui\` in \`app/urlcode.yaml\` and serves the kit's content-hashed stylesheet and scripts under \`/assets/ui/static/\`. The starter theme carries the site name and a neutral primary colour; edit the block to set a logo, favicon, colours, radius or font. The \`${uiDirectory}/\` directory beside the host holds the project's presentation overrides and stays outside \`app/\`: \`${uiDirectory}/copy/<locale>.json\` translates or rewords catalogue ids for the listed languages, any \`${uiDirectory}/templates/<name>.html\` shadows a kit or extension template, and \`${uiDirectory}/extra.css\` is appended after the kit stylesheet. Templates are data in the kit language: they cannot add scripts, change what a form validates or what a page sends in headers.

The host lists \`ui.registration\` first so \`ui.kit\` is active before the extensions that render through it. \`--with\` is an unordered set: core places \`ui\` before the extensions that declare they require it, whatever order they were named in, so \`urlcode init <directory> --with ui,auth,admin\` and any permutation of it emit the same host. The ui setup reads the reviewed project revision from \`PROJECT_SHA256\` under its own identifier and needs nothing from the other extensions. Extensions that ship English copy or templates are registered through \`sources\` and \`extensions\` in the generated host automatically: \`urlcode init --with ui,auth,admin\` wires \`authCatalogue\`, \`authUiTemplates\` and \`adminUiTemplates\` into the \`createUiExtension\` call, because those extensions render only through the kit and refuse to activate without it.

The \`urlcode-ui\` CLI sees the kit alone unless it is told which packages ship the other namespaces. \`--extensions\` names them: each is resolved from \`--project\` with Node package resolution, and one that is not installed there is skipped.${cliNote}

\`\`\`sh
# List templates, overrides and translation coverage as the runtime would see them.
npx urlcode-ui doctor --project .${flag} --copy ${uiDirectory}/copy --templates ${uiDirectory}/templates --stylesheet ${uiDirectory}/extra.css
# Copy a shipped template into the project to customise it (never overwrites).
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
    // Extensions that render through the kit must have their copy and templates registered here, or they refuse to
    // activate. `names` carries the whole composed set, so the generated host wires the peers this project actually has.
    const peers = { imports: [] as string[], sources: [] as string[], templates: [] as string[] };
    if (request.names.includes('auth')) {
        if (request.distribution !== 'bundle') peers.imports.push("import {authCatalogue, authUiTemplates} from '@jimhoyd/urlcode-auth';");
        peers.sources.push('authCatalogue');
        peers.templates.push('authUiTemplates');
    }
    if (request.names.includes('admin')) {
        if (request.distribution !== 'bundle') peers.imports.push("import {adminUiTemplates} from '@jimhoyd/urlcode-admin';");
        peers.templates.push('adminUiTemplates');
    }

    const withStore = request.names.includes('store');
    // The host resolves the site directory from its own location, so the generated module stays relocatable.
    const hostDirectory = segments(request.hostFile).slice(0, -1).join('/');
    const siteReference = relativeReference('/' + hostDirectory, request.directory);
    return {
        name: 'ui',
        provides: ['ui.kit'],
        extensions: {
            ui: {
                version: '1',
                config: {
                    theme: { name, colors: { primary: '220 9% 46%', primaryForeground: '0 0% 100%', dark: { primary: '220 9% 72%', primaryForeground: '224 10% 10%' } } },
                    languages: ['en'],
                    copy: `${uiDirectory}/copy`,
                    templates: `${uiDirectory}/templates`,
                    stylesheet: `${uiDirectory}/extra.css`,
                    ...(withStore ? { screens: { [todosScreen]: { collection: 'todos', title: 'Todos' } } } : {}),
                },
            },
        },
        routes: {
            '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] },
            // The screen reads the collection the store declares, so its fields are written once, in extensions.store.
            ...(withStore ? { [`${todosScreen}/*`]: { extension: 'ui', methods: ['GET', 'HEAD'], ...(request.names.includes('auth') ? { auth: true } : {}) } } : {}),
        },
        hostImports: ["import {fileURLToPath} from 'node:url';", ...(request.distribution === 'bundle' ? [] : ["import {createUiExtension} from '@jimhoyd/urlcode-ui/host';"]), ...peers.imports],
        ...(request.distribution === 'bundle' ? { hostBundleExports: ['createUiExtension'] } : {}),
        hostSetup: [
            '// The ui extension pins the same reviewed revision as the runtime; it defines its own identifier so it needs nothing from the other extensions.',
            'const uiProjectSha256 = process.env.PROJECT_SHA256;',
            "if (!uiProjectSha256 || !/^[a-f0-9]{64}$/.test(uiProjectSha256)) throw new Error('Set the reviewed PROJECT_SHA256 revision');",
            `// The ui block's copy, templates and stylesheet paths resolve inside this directory (${uiDirectory}/ lives beside the host, outside app/).`,
            `const ui = createUiExtension({projectSha256: uiProjectSha256, projectRoot: fileURLToPath(new URL('${siteReference}', import.meta.url)), sources: [${peers.sources.join(', ')}], extensions: [${peers.templates.join(', ')}]});`,
        ],
        hostEntries: ['ui.registration'],
        files: [
            { path: `${uiDirectory}/copy/.gitkeep`, content: '' },
            { path: `${uiDirectory}/templates/.gitkeep`, content: '' },
            { path: `${uiDirectory}/extra.css`, content: `/* Appended after the kit stylesheet (extensions.ui.stylesheet). Override shadcn/ui variables or add rules here; imports, scripts and expressions are refused. */\n` },
        ],
        readme: readmeSection(request.names) + (withStore ? storeSection : ''),
        nextSteps: [
            ...(withStore ? [`Open ${todosScreen} in the served site: a list and form generated from the todos collection declared in app/urlcode.yaml under extensions.store.`] : []),
            `npx urlcode-ui doctor --project .${extensionsFlag(request.names)} --copy ${uiDirectory}/copy --templates ${uiDirectory}/templates --stylesheet ${uiDirectory}/extra.css`,
            `npx urlcode-ui eject ${request.names.includes('auth') ? 'auth/sign-in' : 'layout'} --out ${uiDirectory}/templates${extensionsFlag(request.names)}`,
        ],
        env: { PROJECT_SHA256: 'Reviewed project revision from inspectExtensionRevision; re-review after any project change.' },
    };
}
