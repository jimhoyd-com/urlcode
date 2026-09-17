import { randomBytes } from 'node:crypto';
import { mkdir, open, realpath, rm } from 'node:fs/promises';
import { resolve, dirname, basename, join } from 'node:path';
export interface AuthenticationScaffold {
    directory: string;
    project: string;
    hostFile: string;
    operatorFile: string;
}
const project = `version: '1'
extensions:
  auth:
    version: '1'
    config:
      registration: 'off'
routes:
  /account/*:
    extension: auth
    methods: [GET, HEAD, POST]
  /private:
    respond:
      text: Signed in
    policies:
      extensions:
        auth: {}
`;
const service = `import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createAuthService} from '@jimhoyd/urlcode-auth';
const key = await readFile(new URL('./data/encryption.key', import.meta.url));
let service;
try {
  service = await createAuthService({
    database: fileURLToPath(new URL('./data/auth.sqlite', import.meta.url)),
    encryptionKey: key,
    roles: {member: [], admin: ['*']},
    defaultRole: 'member',
    registrationMode: 'off',
    ...(process.env.AUTH_CONFIG_FROM ? {approveConfigurationChangeFrom: process.env.AUTH_CONFIG_FROM} : {}),
  });
} finally { key.fill(0); }
export default service;
`;
const host = `import {readFile} from 'node:fs/promises';
import {authExtension} from '@jimhoyd/urlcode-auth';
// Explicit operator approval, not computed from the project at activation.
const projectSha256 = process.env.PROJECT_SHA256;
if (!projectSha256 || !/^[a-f0-9]{64}$/.test(projectSha256)) throw new Error('Set the reviewed PROJECT_SHA256 revision');
const origin = new URL(process.env.AUTH_ORIGIN || '');
if (origin.protocol !== 'https:' || origin.origin !== process.env.AUTH_ORIGIN || origin.username || origin.password) throw new Error('Set a canonical HTTPS AUTH_ORIGIN');
const {default: service} = await import('./operator-service.mjs');
let csrfKey;
try {
  csrfKey = await readFile(new URL('./data/csrf.key', import.meta.url));
  if (csrfKey.length !== 32) throw new Error('Invalid CSRF key');
} catch (error) { await service.close(); throw error; }
export default {
  extensions: [authExtension({service, csrfKey, projectSha256})],
  async close() { csrfKey.fill(0); await service.close(); },
};
`;
const instructions = `# Auth project and operator host

This directory separates untrusted route files in app/ from trusted operator modules and private data/. Registration is off. No credentials appear in generated source or command output. Keep the whole data/ directory and operator environment private. This starter includes auth only.

## Install

Use a supported patched Node release. From this directory, install the separately built repositories until packages are released:

\`\`\`sh
# First run npm ci && npm run build in each source repository.
npm install /absolute/path/to/urlcode /absolute/path/to/urlcode-auth
\`\`\`

Review the operator modules and app/urlcode.yaml before activation. Set an HTTPS origin served by your TLS proxy. The runtime listener itself can remain on loopback behind that proxy.

\`\`\`sh
export AUTH_ORIGIN='https://accounts.example.com'
# Inspect only; this command does not grant or load operator code.
node --input-type=module -e 'import {inspectExtensionRevision} from "@jimhoyd/urlcode/extensions"; console.log(await inspectExtensionRevision("./app"))'
# Paste the reviewed hash explicitly. Re-review after any project change.
export PROJECT_SHA256='paste-reviewed-64-character-sha256'
\`\`\`

Bootstrap the first administrator using the operator service. Pass JSON on stdin from your secret manager or a private terminal; never put the password in argv or commit it. The JSON shape is {"email":"owner@example.com","password":"a unique password of at least 15 characters"}. The command prints account metadata, never the password or session token.

\`\`\`sh
npx urlcode-auth bootstrap --operator-file "$PWD/operator-service.mjs"
# Paste the JSON on stdin, then end input (Ctrl-D in a terminal).
npx urlcode serve --project "$PWD/app" --host-file "$PWD/host.mjs" --origin "$AUTH_ORIGIN"
\`\`\`

Sign in at /account/login; /private requires a valid session. Opening registration requires a reviewed operator configuration migration as well as changing the YAML and setting a new explicit project revision pin. Inspect the current database configuration with the configuration CLI command, then supply its exact hash as AUTH_CONFIG_FROM for the first startup with the new operator settings. This revokes old sessions and pending sign-ins. Stop/restart all service instances; old workers refuse requests after migration. Remove the approval environment variable after the migration. Email recovery is unavailable until an operator sender is configured. Do not serve hostile frontend scripts on this origin: browser JavaScript shares ambient session authority even though guest server code cannot read session headers.

Back up the SQLite database through the auth backup API, not by copying a live WAL database. Preserve encryption.key and csrf.key separately in your secret backup system, together with the exact operator configuration. Database backup does not include those key files. A restored snapshot can restore historical sessions and tokens: use a planned revocation and recovery procedure. Generated files and key material are local, not published.
`;
/** Creates a new private directory only; never merges or overwrites an existing project. */
export async function initAuthentication(directory: string): Promise<AuthenticationScaffold> {
    if (typeof directory !== 'string' || !directory || directory.includes('\0'))
        throw new Error('An output directory is required');
    const requested = resolve(directory), parent = await realpath(dirname(requested)), root = join(parent, basename(requested));
    await mkdir(root, { mode: 0o700 });
    async function write(path: string, value: string | Uint8Array): Promise<void> {
        const file = await open(join(root, path), 'wx', 0o600);
        try {
            await file.writeFile(value);
            await file.sync();
        }
        finally {
            await file.close();
        }
    }
    try {
        await mkdir(join(root, 'app'), { mode: 0o700 });
        await mkdir(join(root, 'data'), { mode: 0o700 });
        await write('app/urlcode.yaml', project);
        await write('operator-service.mjs', service);
        await write('host.mjs', host);
        await write('README.md', instructions);
        await write('package.json', JSON.stringify({ name: 'urlcode-auth-site', private: true, type: 'module' }, null, 2) + '\n');
        await write('.gitignore', 'node_modules/\ndata/\n.env\n.env.*\n');
        for (const name of ['encryption.key', 'csrf.key']) {
            const key = randomBytes(32);
            try {
                await write('data/' + name, key);
            }
            finally {
                key.fill(0);
            }
        }
        return { directory: root, project: join(root, 'app'), hostFile: join(root, 'host.mjs'), operatorFile: join(root, 'operator-service.mjs') };
    }
    catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}
