import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scaffold as uiScaffold } from '@jimhoyd/urlcode-ui';
import { initAdministration, scaffold } from '../src/scaffold.ts';
test('admin initialization keeps both trusted hosts and credentials outside the route project', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-admin-init-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const output = await initAdministration(join(root, 'site'));
    const project = JSON.parse(await readFile(join(output.project, 'urlcode.yaml'), 'utf8'));
    assert.equal(project.extensions.auth.config.registration, 'off');
    assert.equal(project.routes['/admin/*'].extension, 'admin');
    // The runtime activates extensions in declaration order, and auth/admin render through the ui kit.
    assert.deepEqual(Object.keys(project.extensions), ['ui', 'auth', 'admin']);
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
    const ui = await uiScaffold({ directory: output.directory, project: output.project, hostFile: output.hostFile, names: ['ui', 'auth', 'admin'] });
    const expected = { version: '1', extensions: { ...ui.extensions, auth: { version: '1', config: { registration: 'off' } }, admin: { version: '1', config: {} } }, routes: { ...ui.routes, '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] }, '/admin/*': { extension: 'admin', methods: ['GET', 'HEAD', 'POST'] }, '/private': { respond: { text: 'Signed in' }, policies: { extensions: { auth: {} } } } } };
    assert.equal(await readFile(join(output.project, 'urlcode.yaml'), 'utf8'), JSON.stringify(expected, null, 2) + '\n');
    const host = await readFile(output.hostFile, 'utf8');
    assert.ok(host.startsWith("import {adminExtension} from '@jimhoyd/urlcode-admin';\nimport {fileURLToPath} from 'node:url';\nimport {createUiExtension} from '@jimhoyd/urlcode-ui/host';\nimport {readFile} from 'node:fs/promises';\n"));
    assert.ok(host.includes("extensions: [ui.registration, authExtension({service, csrfKey, projectSha256, ui}), adminExtension({service, csrfKey, projectSha256, ui, authMount: '/account'})],"));
    const readme = await readFile(join(output.directory, 'README.md'), 'utf8');
    assert.ok(readme.includes('This starter includes auth and admin.'));
    assert.ok(readme.includes('npm install /absolute/path/to/urlcode /absolute/path/to/urlcode-ui /absolute/path/to/urlcode-auth /absolute/path/to/urlcode-admin'));
    assert.ok(readme.endsWith('\n\n## Administration\n\nThe admin extension shares auth\'s operator service, CSRF key and explicit project revision. Its host entry references the `service`, `csrfKey` and `projectSha256` identifiers that auth\'s host setup defines and the `ui` extension the ui setup defines; admin adds no key files, database or environment variables of its own. After bootstrapping and signing in as the first administrator, open /admin. Public registration is off. User invitations, account setup mail and impersonation require explicit sender callbacks; impersonation is disabled by default. Do not put operator modules or data/ into the app directory.\n'));
});
test('admin scaffold refuses an order the runtime cannot activate', async () => {
    const request = { directory: '/srv/site', project: '/srv/site/app', hostFile: '/srv/site/host.mjs', names: ['ui', 'auth', 'admin'] };
    await assert.rejects(scaffold({ ...request, names: ['ui', 'admin'] }), /requires the auth extension/);
    await assert.rejects(scaffold({ ...request, names: ['auth', 'admin'] }), /requires the ui extension: urlcode init --with ui,auth,admin/);
    await assert.rejects(scaffold({ ...request, names: ['auth', 'admin', 'ui'] }), /requires the ui extension before admin/);
});
