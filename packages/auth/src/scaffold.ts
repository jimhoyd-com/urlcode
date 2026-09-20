import { randomBytes } from 'node:crypto';
import { scaffold as uiScaffold } from '@jimhoyd/urlcode-ui/host';
import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join, relative, sep } from 'node:path';
export interface AuthenticationScaffold {
    directory: string;
    project: string;
    hostFile: string;
    operatorFile: string;
}
/** Shared scaffold contract (core `urlcode init --with`): what the caller is assembling. */
export interface ScaffoldRequest {
    /** Root of the generated site; file paths in the result are relative to it. */
    directory: string;
    /** Project directory holding urlcode.yaml. */
    project: string;
    /** Path of the combined host module the caller writes. */
    hostFile: string;
    /** Every extension name being scaffolded together, including this one. */
    names: readonly string[];
}
export interface ScaffoldFile {
    path: string;
    content: string | Uint8Array;
    mode?: number;
}
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
const OPERATOR_FILE = 'operator-service.mjs', ENCRYPTION_KEY = 'data/encryption.key', CSRF_KEY = 'data/csrf.key';
function moduleReference(from: string, to: string): string {
    const path = relative(from, to).split(sep).join('/');
    return path.startsWith('.') ? path : './' + path;
}
function shellReference(from: string, to: string): string {
    return relative(from, to).split(sep).join('/');
}
function serviceModule(directory: string): string {
    const here = dirname(join(directory, OPERATOR_FILE));
    return `import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createAuthService} from '@jimhoyd/urlcode-auth';
const key = await readFile(new URL('${moduleReference(here, join(directory, ENCRYPTION_KEY))}', import.meta.url));
let service;
try {
  service = await createAuthService({
    database: fileURLToPath(new URL('${moduleReference(here, join(directory, 'data/auth.sqlite'))}', import.meta.url)),
    encryptionKey: key,
    roles: {member: [], admin: ['*']},
    defaultRole: 'member',
    registrationMode: 'off',
    ...(process.env.AUTH_CONFIG_FROM ? {approveConfigurationChangeFrom: process.env.AUTH_CONFIG_FROM} : {}),
  });
} finally { key.fill(0); }
export default service;
`;
}
function readmeSection(request: ScaffoldRequest, admin: boolean): string {
    const operator = shellReference(request.directory, join(request.directory, OPERATOR_FILE)), project = shellReference(request.directory, request.project), host = shellReference(request.directory, request.hostFile);
    return `This directory separates untrusted route files in ${project}/ from trusted operator modules and private data/. Registration is off. No credentials appear in generated source or command output. Keep the whole data/ directory and operator environment private.${admin ? ' This starter includes auth and admin; the admin console is described in its own section.' : ' This starter includes auth only.'}

## Install

Use a supported patched Node release. From this directory, install the separately built repositories until packages are released:

\`\`\`sh
# First run npm ci && npm run build in each source repository.
npm install /absolute/path/to/urlcode /absolute/path/to/urlcode-auth${admin ? ' /absolute/path/to/urlcode-admin' : ''}
\`\`\`

Review the operator modules and ${project}/urlcode.yaml before activation. Set an HTTPS origin served by your TLS proxy. The runtime listener itself can remain on loopback behind that proxy.

\`\`\`sh
export AUTH_ORIGIN='https://accounts.example.com'
# Inspect only; this command does not grant or load operator code.
node --input-type=module -e 'import {inspectExtensionRevision} from "@jimhoyd/urlcode/extensions"; console.log(await inspectExtensionRevision("./${project}"))'
# Paste the reviewed hash explicitly. Re-review after any project change.
export PROJECT_SHA256='paste-reviewed-64-character-sha256'
\`\`\`

Bootstrap the first administrator using the operator service. Pass JSON on stdin from your secret manager or a private terminal; never put the password in argv or commit it. The JSON shape is {"email":"owner@example.com","password":"a unique password of at least 15 characters"}. The command prints account metadata, never the password or session token.

\`\`\`sh
npx urlcode-auth bootstrap --operator-file "$PWD/${operator}"
# Paste the JSON on stdin, then end input (Ctrl-D in a terminal).
npx urlcode serve --project "$PWD/${project}" --host-file "$PWD/${host}" --origin "$AUTH_ORIGIN"
\`\`\`

Sign in at /account/login; /private requires a valid session${admin ? ' and /admin requires the admin role' : ''}. Opening registration requires a reviewed operator configuration migration as well as changing the YAML and setting a new explicit project revision pin. Inspect the current database configuration with the configuration CLI command, then supply its exact hash as AUTH_CONFIG_FROM for the first startup with the new operator settings. This revokes old sessions and pending sign-ins. Stop/restart all service instances; old workers refuse requests after migration. Remove the approval environment variable after the migration. Email recovery is unavailable until an operator sender is configured. Do not serve hostile frontend scripts on this origin: browser JavaScript shares ambient session authority even though guest server code cannot read session headers.

Back up the SQLite database through the auth backup API, not by copying a live WAL database. Preserve encryption.key and csrf.key separately in your secret backup system, together with the exact operator configuration. Database backup does not include those key files. A restored snapshot can restore historical sessions and tokens: use a planned revocation and recovery procedure. Generated files and key material are local, not published.
`;
}
/**
 * Generates the auth pieces of a layered project without touching the filesystem.
 * Key material is created in memory and returned as files; the caller writes them with private modes.
 */
export async function scaffold(request: ScaffoldRequest): Promise<ScaffoldResult> {
    if (!request || typeof request !== 'object')
        throw new Error('A scaffold request is required');
    for (const key of ['directory', 'project', 'hostFile'] as const) {
        const value = request[key];
        if (typeof value !== 'string' || !value || value.includes('\0'))
            throw new Error(`Scaffold ${key} is required`);
    }
    if (!Array.isArray(request.names) || request.names.some(name => typeof name !== 'string'))
        throw new Error('Scaffold names must be strings');
    // Every account screen renders through the kit, and the runtime activates extensions in urlcode.yaml order,
    // which core writes in --with order. So ui must be named, and named first.
    if (!request.names.includes('ui'))
        throw new Error('Auth scaffold requires the ui extension: urlcode init --with ui,auth');
    if (request.names.indexOf('ui') > request.names.indexOf('auth'))
        throw new Error('Auth scaffold requires ui before auth so the kit activates first: urlcode init --with ui,auth');
    const directory = resolve(request.directory), project = resolve(directory, request.project), hostFile = resolve(directory, request.hostFile);
    const normalized: ScaffoldRequest = { directory, project, hostFile, names: request.names };
    const admin = request.names.includes('admin'), hostDirectory = dirname(hostFile);
    const operator = shellReference(directory, join(directory, OPERATOR_FILE)), projectPath = shellReference(directory, project), host = shellReference(directory, hostFile);
    return {
        name: 'auth',
        extensions: { auth: { version: '1', config: { registration: 'off' } } },
        routes: {
            '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] },
            '/private': { respond: { text: 'Signed in' }, policies: { extensions: { auth: {} } } },
        },
        hostImports: ["import {readFile} from 'node:fs/promises';", "import {authExtension} from '@jimhoyd/urlcode-auth';"],
        hostSetup: [
            '// Explicit operator approval, not computed from the project at activation.',
            'const projectSha256 = process.env.PROJECT_SHA256;',
            "if (!projectSha256 || !/^[a-f0-9]{64}$/.test(projectSha256)) throw new Error('Set the reviewed PROJECT_SHA256 revision');",
            "const origin = new URL(process.env.AUTH_ORIGIN || '');",
            "if (origin.protocol !== 'https:' || origin.origin !== process.env.AUTH_ORIGIN || origin.username || origin.password) throw new Error('Set a canonical HTTPS AUTH_ORIGIN');",
            `const {default: service} = await import('${moduleReference(hostDirectory, join(directory, OPERATOR_FILE))}');`,
            'let csrfKey;',
            'try {',
            `  csrfKey = await readFile(new URL('${moduleReference(hostDirectory, join(directory, CSRF_KEY))}', import.meta.url));`,
            "  if (csrfKey.length !== 32) throw new Error('Invalid CSRF key');",
            '} catch (error) { await service.close(); throw error; }',
        ],
        hostEntries: ['authExtension({service, csrfKey, projectSha256, ui})'],
        hostClose: ['csrfKey.fill(0);', 'await service.close();'],
        files: [
            { path: OPERATOR_FILE, content: serviceModule(directory), mode: 0o600 },
            { path: ENCRYPTION_KEY, content: randomBytes(32), mode: 0o600 },
            { path: CSRF_KEY, content: randomBytes(32), mode: 0o600 },
        ],
        readme: readmeSection(normalized, admin),
        nextSteps: [
            "export AUTH_ORIGIN='https://accounts.example.com'",
            "export PROJECT_SHA256='paste-reviewed-64-character-sha256'",
            `npx urlcode-auth bootstrap --operator-file "$PWD/${operator}"`,
            `npx urlcode serve --project "$PWD/${projectPath}" --host-file "$PWD/${host}" --origin "$AUTH_ORIGIN"`,
        ],
        env: {
            AUTH_ORIGIN: 'Canonical HTTPS origin of the site, as served by the TLS proxy.',
            PROJECT_SHA256: 'Reviewed project revision from inspectExtensionRevision; re-review after any project change.',
            AUTH_CONFIG_FROM: 'Optional: current configuration revision hash approving an operator configuration migration.',
        },
    };
}
const PLAIN = /^[A-Za-z_/][A-Za-z0-9_ ./*-]*$/, RESERVED = /^(true|false|yes|no|on|off|null|~)$/i;
function scalar(value: unknown): string {
    if (typeof value === 'string')
        return PLAIN.test(value) && !RESERVED.test(value) && !value.endsWith(' ') ? value : `'${value.replace(/'/g, "''")}'`;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    throw new Error('Unsupported YAML scalar');
}
/** Deterministic YAML for scaffold fragments: block mappings, flow lists of scalars, {} for empty maps. */
export function renderYaml(value: Record<string, unknown>, indent = ''): string {
    let out = '';
    for (const [key, entry] of Object.entries(value)) {
        const name = scalar(key);
        if (Array.isArray(entry))
            out += `${indent}${name}: [${entry.map(scalar).join(', ')}]\n`;
        else if (entry && typeof entry === 'object') {
            const nested = entry as Record<string, unknown>;
            out += Object.keys(nested).length ? `${indent}${name}:\n${renderYaml(nested, indent + '  ')}` : `${indent}${name}: {}\n`;
        }
        else
            out += `${indent}${name}: ${scalar(entry)}\n`;
    }
    return out;
}
function hostModule(result: ScaffoldResult): string {
    return [
        ...result.hostImports,
        ...result.hostSetup,
        'export default {',
        `  extensions: [${result.hostEntries.join(', ')}],`,
        `  async close() { ${(result.hostClose ?? []).join(' ')} },`,
        '};',
    ].join('\n') + '\n';
}
/** Creates a new private directory only; never merges or overwrites an existing project. */
export async function initAuthentication(directory: string): Promise<AuthenticationScaffold> {
    if (typeof directory !== 'string' || !directory || directory.includes('\0'))
        throw new Error('An output directory is required');
    const requested = resolve(directory), parent = await realpath(dirname(requested)), root = join(parent, basename(requested));
    const project = join(root, 'app'), hostFile = join(root, 'host.mjs');
    const names = ['ui', 'auth'];
    const kit = await uiScaffold({ directory: root, project, hostFile, names });
    const auth = await scaffold({ directory: root, project, hostFile, names });
    // ui first in both the YAML and the host: auth refuses to activate before the kit is active.
    const result: ScaffoldResult = {
        ...auth,
        extensions: { ...kit.extensions, ...auth.extensions },
        routes: { ...kit.routes, ...auth.routes },
        hostImports: [...kit.hostImports, ...auth.hostImports],
        hostSetup: [...kit.hostSetup, ...auth.hostSetup],
        hostEntries: [...kit.hostEntries, ...auth.hostEntries],
        files: [...kit.files, ...auth.files],
    };
    try {
        await mkdir(root, { mode: 0o700 });
    }
    catch (error) {
        for (const file of result.files)
            if (file.content instanceof Uint8Array)
                file.content.fill(0);
        throw error;
    }
    async function write(path: string, value: string | Uint8Array, mode = 0o600): Promise<void> {
        const file = await open(join(root, path), 'wx', mode);
        try {
            await file.writeFile(value);
            await file.sync();
        }
        finally {
            await file.close();
        }
    }
    try {
        await mkdir(project, { mode: 0o700 });
        await mkdir(join(root, 'data'), { mode: 0o700 });
        await write('app/urlcode.yaml', renderYaml({ version: '1', extensions: result.extensions, routes: result.routes }));
        await write('host.mjs', hostModule(result));
        await write('README.md', `# Auth project and operator host\n\n${result.readme}`);
        await write('package.json', JSON.stringify({ name: 'urlcode-auth-site', private: true, type: 'module' }, null, 2) + '\n');
        await write('.gitignore', 'node_modules/\ndata/\n.env\n.env.*\n');
        for (const file of result.files) {
            if (file.path.includes('\0') || resolve(root, file.path) !== join(root, file.path) || relative(root, resolve(root, file.path)).startsWith('..'))
                throw new Error('Invalid scaffold file path');
            // Composed scaffolds contribute nested paths of their own (the kit's ui/copy and ui/templates).
            await mkdir(dirname(join(root, file.path)), { recursive: true, mode: 0o700 });
            await write(file.path, file.content, file.mode);
        }
        return { directory: root, project, hostFile, operatorFile: join(root, OPERATOR_FILE) };
    }
    catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
    finally {
        for (const file of result.files)
            if (file.content instanceof Uint8Array)
                file.content.fill(0);
    }
}
