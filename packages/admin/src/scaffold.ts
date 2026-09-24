import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { initAuthentication } from '@jimhoyd/urlcode-auth';
import { scaffold as uiScaffold } from '@jimhoyd/urlcode-ui/host';
/** Shared scaffold contract (core `urlcode init --with`, auth, admin): what the caller has decided so far. */
export interface ScaffoldRequest {
    /** Absolute output directory the caller will create; nothing is written by `scaffold`. */
    directory: string;
    /** Absolute route-project directory (contains urlcode.yaml). */
    project: string;
    /** Absolute host module path the caller will write. */
    hostFile: string;
    /** Every extension name being composed, in canonical order independent of the `--with` spelling. */
    names: readonly string[];
    /** `bundle`: core's --with always requests this. `npm`, from the operator's own install, is reachable only from
     *  each package's own standalone init CLI (urlcode-auth init, urlcode-admin init), not from --with. */
    distribution?: 'npm' | 'bundle';
}
export interface ScaffoldFile {
    path: string;
    content: string | Uint8Array;
    mode?: number;
}
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
const readme = `## Administration

The admin extension shares auth's operator service, CSRF key and explicit project revision. Its host entry references the \`service\`, \`csrfKey\` and \`projectSha256\` identifiers that auth's host setup defines; admin adds no key files, database or environment variables of its own. After bootstrapping and signing in as the first administrator, open /admin. Public registration is off. User invitations, account setup mail and impersonation require explicit sender callbacks; impersonation is disabled by default. Do not put operator modules or data/ into the app directory.`;
/** Describes admin's contribution to a composed project without writing anything. Requires the auth extension in the same host. */
export async function scaffold(request: ScaffoldRequest): Promise<ScaffoldResult> {
    for (const key of ['directory', 'project', 'hostFile'] as const)
        if (typeof request[key] !== 'string' || !request[key])
            throw new Error(`Scaffold request needs an absolute ${key}`);
    if (!request.names.includes('auth'))
        throw new Error('admin requires the auth extension, which is not part of this composition; add auth to --with');
    // The console renders only through the kit; core orders ui before admin from `requires` below.
    if (!request.names.includes('ui'))
        throw new Error('admin requires the ui extension, which is not part of this composition; add ui to --with');
    return {
        name: 'admin',
        requires: ['ui.kit', 'auth.service'],
        extensions: { admin: { version: '1', config: {} } },
        routes: { '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] } },
        hostImports: request.distribution === 'bundle' ? [] : ["import {adminExtension} from '@jimhoyd/urlcode-admin';"],
        ...(request.distribution === 'bundle' ? { hostBundleExports: ['adminExtension', 'adminUiTemplates'] } : {}),
        hostSetup: ['// Admin reuses service, csrfKey and projectSha256 from the auth setup above, and the kit from the ui setup.'],
        hostEntries: ["adminExtension({service, csrfKey, projectSha256, authMount: '/account', ui})"],
        files: [],
        readme,
        nextSteps: ['Bootstrap the first administrator with `npx urlcode-auth bootstrap`, sign in at /account/login, then open /admin.', 'Configure sender callbacks before inviting users; impersonation stays disabled until explicitly enabled.'],
    };
}
/** Separate operator host and route project; both extensions remain explicitly pinned. */
export async function initAdministration(directory: string): Promise<{directory:string;project:string;hostFile:string;operatorFile:string}> {
    const created = await initAuthentication(directory);
    try {
        const names = ['ui', 'auth', 'admin'];
        const kit = await uiScaffold({ directory: created.directory, project: created.project, hostFile: created.hostFile, names });
        const admin = await scaffold({ directory: created.directory, project: created.project, hostFile: created.hostFile, names });
        // ui is declared first: the runtime activates extensions in this order, and auth and admin both refuse before the kit is active.
        const document = { version: '1', extensions: { ...kit.extensions, auth: { version: '1', config: { registration: 'off' } }, ...admin.extensions }, routes: { ...kit.routes, '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] }, ...admin.routes, '/private': { respond: { text: 'Signed in' }, auth: true } } };
        await writeFile(join(created.project, 'urlcode.yaml'), JSON.stringify(document, null, 2) + '\n');
        const host = await readFile(created.hostFile, 'utf8');
        const marker = 'extensions: [ui.registration, authExtension({service, csrfKey, projectSha256, ui})]';
        if (!host.includes(marker))
            throw new Error('Incompatible auth scaffold');
        await writeFile(created.hostFile, admin.hostImports.join('\n') + '\n' + host.replace(marker, `extensions: [ui.registration, authExtension({service, csrfKey, projectSha256, ui}), ${admin.hostEntries.join(', ')}]`));
        const instructions = await readFile(join(created.directory, 'README.md'), 'utf8');
        await writeFile(join(created.directory, 'README.md'), instructions.replace('This starter includes auth only.', 'This starter includes auth and admin.').replace('/absolute/path/to/urlcode/packages/auth', '/absolute/path/to/urlcode/packages/auth /absolute/path/to/urlcode/packages/admin') + '\n' + admin.readme + '\n');
        return created;
    }
    catch (error) {
        await rm(created.directory, { recursive: true, force: true });
        throw error;
    }
}
