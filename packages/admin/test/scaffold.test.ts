import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initAdministration } from '../src/scaffold.ts';
import { scaffold as uiScaffold } from '@jimhoyd/urlcode-ui/host';
test('admin initialization keeps both trusted hosts and credentials outside the route project', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-admin-init-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const output = await initAdministration(join(root, 'site'));
    const project = JSON.parse(await readFile(join(output.project, 'urlcode.yaml'), 'utf8'));
    assert.equal(project.extensions.auth.config.registration, 'off');
    assert.equal(project.routes['/admin/*'].extension, 'admin');
    const host = await readFile(output.hostFile, 'utf8');
    assert.match(host, /adminExtension/);
    assert.match(host, /process.env.PROJECT_SHA256/);
    assert.ok(!output.hostFile.startsWith(output.project + '/'));
    assert.equal((await stat(join(output.directory, 'data/csrf.key'))).size, 32);
    await assert.rejects(initAdministration(output.directory));
    assert.equal((await stat(join(output.directory, 'data/csrf.key'))).size, 32);
});
test('init output is byte-for-byte what the pre-scaffold initializer wrote', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-admin-init-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const output = await initAdministration(join(root, 'site'));
    // ui is composed in and declared first: the runtime activates in this order, and auth and admin both refuse
    // before the kit is active. The ui block comes from ui's own scaffold rather than a copied literal.
    const names = ['ui', 'auth', 'admin'];
    const kit = await uiScaffold({ directory: output.directory, project: output.project, hostFile: output.hostFile, names });
    const expected = { version: '1', extensions: { ...kit.extensions, auth: { version: '1', config: { registration: 'off' } }, admin: { version: '1', config: {} } }, routes: { ...kit.routes, '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] }, '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] }, '/private': { respond: { text: 'Signed in' }, policies: { extensions: { auth: {} } } } } };
    assert.equal(Object.keys(expected.extensions)[0], 'ui');
    assert.equal(await readFile(join(output.project, 'urlcode.yaml'), 'utf8'), JSON.stringify(expected, null, 2) + '\n');
    const host = await readFile(output.hostFile, 'utf8');
    // admin prepends its import to the ui+auth host that initAuthentication wrote.
    assert.ok(host.startsWith("import {adminExtension} from '@jimhoyd/urlcode-admin';\nimport {fileURLToPath} from 'node:url';\nimport {createUiExtension} from '@jimhoyd/urlcode-ui/host';\n"));
    assert.ok(host.includes("import {readFile} from 'node:fs/promises';\n"));
    assert.ok(host.includes("extensions: [ui.registration, authExtension({service, csrfKey, projectSha256, ui}), adminExtension({service, csrfKey, projectSha256, authMount: '/account', ui})],"));
    const readme = await readFile(join(output.directory, 'README.md'), 'utf8');
    assert.ok(readme.includes('This starter includes auth and admin.'));
    assert.ok(readme.includes('npm install /absolute/path/to/urlcode /absolute/path/to/urlcode/packages/ui /absolute/path/to/urlcode/packages/auth /absolute/path/to/urlcode/packages/admin'));
    assert.ok(readme.endsWith('\n\n## Administration\n\nThe admin extension shares auth\'s operator service, CSRF key and explicit project revision. Its host entry references the `service`, `csrfKey` and `projectSha256` identifiers that auth\'s host setup defines; admin adds no key files, database or environment variables of its own. After bootstrapping and signing in as the first administrator, open /admin. Public registration is off. User invitations, account setup mail and impersonation require explicit sender callbacks; impersonation is disabled by default. Do not put operator modules or data/ into the app directory.\n'));
});
