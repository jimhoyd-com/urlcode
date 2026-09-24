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
    /** `bundle`: core's --with always requests this. `npm`, from the operator's own install, is reachable only from
     *  each package's own standalone init CLI (urlcode-auth init, urlcode-admin init), not from --with. */
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
/**
 * `--extensions` for the generated commands; empty when this site composes nothing but ui, or when the named
 * packages could not resolve here anyway. `--extensions` is Node package resolution from `--project` (see
 * `namespaces.ts`): it needs `@jimhoyd/urlcode-auth`/`@jimhoyd/urlcode-admin` as real npm dependencies under that
 * directory. A bundle-only site never has that -- each locked bundle is cached in its own directory under
 * `.urlcode/extension-bundles`, not merged into a shared `node_modules` -- so naming them would only add a
 * `skipped` note to every command's output, not the `auth/*`/`admin/*` coverage the flag promises elsewhere.
 */
function extensionsFlag(names: readonly string[], distribution: ScaffoldRequest['distribution']): string {
    if (distribution === 'bundle') return '';
    const packages = namespacePackages(names);
    return packages.length ? ` --extensions ${packages.join(',')}` : '';
}
/**
 * `urlcode-ui <args>`, routed to however this site can actually reach that CLI. A bundle-only site (the only
 * `--with` mode today) has no `@jimhoyd/urlcode-ui` npm dependency to resolve -- its extensions are signed GitHub
 * Release bundles cached under `.urlcode/extension-bundles`, not npm packages -- so `npx urlcode-ui` would fall
 * through to the npm registry: the unscoped `urlcode-ui` name is unclaimed (a 404) and the scoped
 * `@jimhoyd/urlcode-ui` package, while real, is deprecated in favour of these bundles and is not what this site's
 * lockfile actually pins. `urlcode extension-bundles run` invokes the locked bundle's own packaged CLI directly
 * from the verified, cached bytes instead. The `npm` distribution (only reachable from `urlcode-ui`'s own
 * standalone `init`, never from `--with`) really does install the npm package, so `npx urlcode-ui` there finds it
 * locally.
 */
function uiCommand(distribution: ScaffoldRequest['distribution'], args: string): string {
    return distribution === 'bundle' ? `npx urlcode extension-bundles run ui -- ${args}` : `npx urlcode-ui ${args}`;
}
function readmeSection(request: ScaffoldRequest): string {
    const { names, distribution } = request;
    const flag = extensionsFlag(names, distribution);
    const composesPeers = namespacePackages(names).length > 0;
    const cliNote = flag
        ? ' The commands below carry the packages this site composes, so `list` and `doctor` cover the `auth/*` and `admin/*` templates beside the kit templates, a project override of an extension template is checked against the shipped view model it has to keep up with, `eject` can copy one, and `copy --missing` covers the copy ids the account screens use.'
        : distribution === 'bundle' && composesPeers
            ? ' This site\'s extensions are signed bundles, each cached in its own directory rather than a shared `node_modules`, so `--extensions` cannot resolve `auth`/`admin` here: the commands below report the kit alone, without `auth/*`/`admin/*` template coverage.'
            : '';
    const bundleNote = distribution === 'bundle'
        ? ' This site composes `--with`, so its extensions are signed bundles, not npm packages: the commands below run the kit\'s own CLI through `urlcode extension-bundles run ui`, which loads it from the verified bytes already cached under `.urlcode/extension-bundles` -- there is no local `urlcode-ui` package here for a plain `npx` to resolve instead.'
        : '';
    return `The \`ui\` extension owns \`extensions.ui\` in \`app/urlcode.yaml\` and serves the kit's content-hashed stylesheet and scripts under \`/assets/ui/static/\`. The starter theme carries the site name and a neutral primary colour; edit the block to set a logo, favicon, colours, radius or font. The \`${uiDirectory}/\` directory beside the host holds the project's presentation overrides and stays outside \`app/\`: \`${uiDirectory}/copy/<locale>.json\` translates or rewords catalogue ids for the listed languages, any \`${uiDirectory}/templates/<name>.html\` shadows a kit or extension template, and \`${uiDirectory}/extra.css\` is appended after the kit stylesheet. Templates are data in the kit language: they cannot add scripts, change what a form validates or what a page sends in headers.

The host lists \`ui.registration\` first so \`ui.kit\` is active before the extensions that render through it. \`--with\` is an unordered set: core places \`ui\` before the extensions that declare they require it, whatever order they were named in, so \`urlcode init <directory> --with ui,auth,admin\` and any permutation of it emit the same host. The ui setup reads the reviewed project revision from \`PROJECT_SHA256\` under its own identifier and needs nothing from the other extensions. Extensions that ship English copy or templates are registered through \`sources\` and \`extensions\` in the generated host automatically: \`urlcode init --with ui,auth,admin\` wires \`authCatalogue\`, \`authUiTemplates\` and \`adminUiTemplates\` into the \`createUiExtension\` call, because those extensions render only through the kit and refuse to activate without it.

The \`urlcode-ui\` CLI sees the kit alone unless it is told which packages ship the other namespaces. \`--extensions\` names them: each is resolved from \`--project\` with Node package resolution, and one that is not installed there is skipped.${cliNote}${bundleNote}

\`\`\`sh
# List templates, overrides and translation coverage as the runtime would see them.
${uiCommand(distribution, `doctor --project .${flag} --copy ${uiDirectory}/copy --templates ${uiDirectory}/templates --stylesheet ${uiDirectory}/extra.css`)}
# Copy a shipped template into the project to customise it (never overwrites).
${uiCommand(distribution, `eject layout --out ${uiDirectory}/templates`)}
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
    // In bundle distribution, authCatalogue/authUiTemplates/adminUiTemplates need no import of their own here: each
    // extension's own loadExtensionBundle call already binds them into this same generated host module's scope.
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
        readme: readmeSection(request) + (withStore ? storeSection : ''),
        nextSteps: [
            ...(withStore ? [`Open ${todosScreen} in the served site: a list and form generated from the todos collection declared in app/urlcode.yaml under extensions.store.`] : []),
            uiCommand(request.distribution, `doctor --project .${extensionsFlag(request.names, request.distribution)} --copy ${uiDirectory}/copy --templates ${uiDirectory}/templates --stylesheet ${uiDirectory}/extra.css`),
            // eject needs the template's own package in --extensions to find it; without that (a bundle-only site,
            // above) only kit templates like layout are reachable, so auth/sign-in is not offered there.
            uiCommand(request.distribution, `eject ${request.names.includes('auth') && request.distribution !== 'bundle' ? 'auth/sign-in' : 'layout'} --out ${uiDirectory}/templates${extensionsFlag(request.names, request.distribution)}`),
        ],
        env: { PROJECT_SHA256: 'Reviewed project revision from inspectExtensionRevision; re-review after any project change.' },
    };
}
