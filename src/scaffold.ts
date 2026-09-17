import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { initAuthentication } from '@jimhoyd/urlcode-auth';
/** Separate operator host and route project; both extensions remain explicitly pinned. */
export async function initAdministration(directory: string): Promise<{directory:string;project:string;hostFile:string;operatorFile:string}> {
    const created = await initAuthentication(directory);
    try {
        const document = { version: '1', extensions: { auth: { version: '1', config: { registration: 'off' } }, admin: { version: '1', config: {} } }, routes: { '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] }, '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] }, '/private': { respond: { text: 'Signed in' }, policies: { extensions: { auth: {} } } } } };
        await writeFile(join(created.project, 'urlcode.yaml'), JSON.stringify(document, null, 2) + '\n');
        const host = await readFile(created.hostFile, 'utf8');
        const marker = 'extensions: [authExtension({service, csrfKey, projectSha256})]';
        if (!host.includes(marker))
            throw new Error('Incompatible auth scaffold');
        await writeFile(created.hostFile, "import {adminExtension} from '@jimhoyd/urlcode-admin';\n" + host.replace(marker, 'extensions: [authExtension({service, csrfKey, projectSha256}), adminExtension({service, csrfKey, projectSha256, authMount: \'/account\'})]'));
        const instructions = await readFile(join(created.directory, 'README.md'), 'utf8');
        await writeFile(join(created.directory, 'README.md'), instructions.replace('This starter includes auth only.', 'This starter includes auth and admin.').replace('/absolute/path/to/urlcode-auth', '/absolute/path/to/urlcode-auth /absolute/path/to/urlcode-admin') + '\n## Administration\n\nAfter bootstrapping and signing in as the first administrator, open /admin. Both extensions share the same operator service and explicit project revision. Public registration is off. User invitations, account setup mail and impersonation require explicit sender callbacks; impersonation is disabled by default. Do not put operator modules or data/ into the app directory.\n');
        return created;
    }
    catch (error) {
        await rm(created.directory, { recursive: true, force: true });
        throw error;
    }
}
