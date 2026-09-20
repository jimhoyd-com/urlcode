import { cleanup } from './cleanup.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { validateProject } from '@jimhoyd/urlcode';
import * as pkg from '../src/index.ts';
import { initAuthentication, renderYaml, scaffold } from '../src/scaffold.ts';
import { scaffold as uiScaffold } from '@jimhoyd/urlcode-ui/host';
import type { ScaffoldResult } from '../src/scaffold.ts';
const request = { directory: '/srv/site', project: '/srv/site/app', hostFile: '/srv/site/host.mjs', names: ['ui', 'auth'] as const };
const expectedYaml = `version: '1'
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
function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}
test('scaffold returns the shared contract shape without touching the filesystem', async () => {
    const result: ScaffoldResult = await scaffold(request);
    assert.equal(result.name, 'auth');
    assert.deepEqual(Object.keys(result).sort(), ['env', 'extensions', 'files', 'hostClose', 'hostEntries', 'hostImports', 'hostSetup', 'name', 'nextSteps', 'provides', 'readme', 'requires', 'routes'].sort());
    for (const key of ['hostImports', 'hostSetup', 'hostEntries', 'hostClose', 'nextSteps'] as const)
        assert.ok(isStringList(result[key]), key);
    assert.ok(result.hostEntries.length === 1 && result.nextSteps.length > 0);
    assert.equal(typeof result.readme, 'string');
    assert.deepEqual(result.files.map(file => file.path).sort(), ['data/csrf.key', 'data/encryption.key', 'operator-service.mjs']);
    for (const file of result.files) {
        assert.ok(!file.path.startsWith('/') && !file.path.includes('..'));
        assert.equal(file.mode, 0o600);
        assert.ok(typeof file.content === 'string' || file.content instanceof Uint8Array);
    }
    for (const key of Object.values(result.env ?? {}))
        assert.equal(typeof key, 'string');
    assert.ok(result.env && 'AUTH_ORIGIN' in result.env && 'PROJECT_SHA256' in result.env);
    assert.ok(result.hostSetup.some(line => line.includes("import('./operator-service.mjs')")));
    assert.ok(result.hostSetup.some(line => line.includes("'./data/csrf.key'")));
    // Relative paths follow the host file location, not a fixed layout.
    const nested = await scaffold({ ...request, hostFile: '/srv/site/ops/host.mjs', project: '/srv/site/www' });
    assert.ok(nested.hostSetup.some(line => line.includes("import('../operator-service.mjs')")));
    assert.ok(nested.hostSetup.some(line => line.includes("'../data/csrf.key'")));
    assert.ok(nested.readme.includes('--project "$PWD/www"') && nested.readme.includes('--host-file "$PWD/ops/host.mjs"'));
});
test('scaffold fragments merged into a version 1 project validate with core', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-scaffold-contract-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const result = await scaffold(request);
    await mkdir(join(root, 'app'));
    await writeFile(join(root, 'app/urlcode.yaml'), JSON.stringify({ version: '1', extensions: result.extensions, routes: result.routes }));
    const report = await validateProject(join(root, 'app'));
    assert.equal(report.valid, true);
    assert.equal(report.routeCount, 2);
    // The deterministic YAML renderer emits the same document as the JSON form.
    assert.equal(renderYaml({ version: '1', extensions: result.extensions, routes: result.routes }), expectedYaml);
});
test('every host import names an export of the package', async () => {
    const result = await scaffold(request);
    for (const line of result.hostImports) {
        const match = /^import \{([^}]+)\} from '([^']+)';$/.exec(line);
        assert.ok(match, line);
        const names = match[1]!.split(',').map(name => name.trim().split(' as ')[0]!);
        const target = match[2] === '@jimhoyd/urlcode-auth' ? pkg : await import(match[2]!);
        for (const name of names)
            assert.ok(name in target, `${name} from ${match[2]}`);
    }
    for (const entry of result.hostEntries)
        assert.ok(/^authExtension\(/.test(entry));
    for (const line of result.hostSetup)
        assert.ok(!line.includes('inspectExtensionRevision') && !line.includes('createHash'));
});
test('readme and host code contain no secrets, and each call creates fresh key material', async () => {
    const first = await scaffold(request), second = await scaffold(request);
    const keys = (result: ScaffoldResult) => result.files.filter(file => file.path.endsWith('.key')).map(file => Buffer.from(file.content as Uint8Array));
    const [encryption, csrf] = keys(first), [encryption2, csrf2] = keys(second);
    assert.equal(encryption!.length, 32);
    assert.equal(csrf!.length, 32);
    assert.notDeepEqual(encryption, csrf);
    assert.notDeepEqual(encryption, encryption2);
    assert.notDeepEqual(csrf, csrf2);
    const text = [first.readme, ...first.hostImports, ...first.hostSetup, ...first.hostEntries, ...(first.hostClose ?? []), ...first.nextSteps, ...first.files.filter(file => typeof file.content === 'string').map(file => file.content as string)].join('\n');
    for (const key of [encryption!, csrf!])
        for (const encoding of ['hex', 'base64', 'base64url', 'latin1'] as const)
            assert.ok(!text.includes(key.toString(encoding)));
    assert.ok(!/password\s*[:=]\s*['"][^'"]+['"]/i.test(text.replace(/"password":"a unique password of at least 15 characters"/, '')));
    assert.ok(first.readme.includes('paste-reviewed-64-character-sha256'));
});
test('readme mentions admin only when admin is scaffolded alongside', async () => {
    const alone = await scaffold(request), combined = await scaffold({ ...request, names: ['ui', 'auth', 'admin'] });
    assert.ok(!alone.readme.includes('/admin') && !alone.readme.includes('urlcode-admin'));
    assert.ok(alone.readme.includes('auth only'));
    assert.ok(combined.readme.includes('/admin requires the admin role'));
    assert.ok(combined.readme.includes('urlcode-admin'));
    assert.ok(!combined.readme.includes('auth only'));
    assert.deepEqual(combined.extensions, alone.extensions);
    assert.deepEqual(combined.routes, alone.routes);
    assert.deepEqual(combined.files.map(file => file.path), alone.files.map(file => file.path));
});
test('scaffold rejects malformed requests', async () => {
    await assert.rejects(scaffold({ ...request, directory: '' }), /directory/);
    await assert.rejects(scaffold({ ...request, hostFile: 'host\0.mjs' }), /hostFile/);
    await assert.rejects(scaffold({ ...request, names: ['auth', 1 as unknown as string] }), /names/);
    // The kit is mandatory, and must activate first: urlcode.yaml order is activation order.
    await assert.rejects(scaffold({ ...request, names: ['auth'] }), /requires the ui extension/);
    assert.deepEqual((await scaffold({ ...request, names: ['auth', 'ui'] })).requires, ['ui.kit']);
});
test('initAuthentication output is assembled from scaffold and unchanged', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-scaffold-init-'));
    cleanup(t, () => rm(root, { recursive: true, force: true }));
    const output = await initAuthentication(join(root, 'site'));
    const files = (await readdir(output.directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).map(entry => relative(output.directory, join(entry.parentPath, entry.name)).split(sep).join('/')).sort();
    assert.deepEqual(files, ['.gitignore', 'README.md', 'app/urlcode.yaml', 'data/csrf.key', 'data/encryption.key', 'host.mjs', 'operator-service.mjs', 'package.json', 'ui/copy/.gitkeep', 'ui/extra.css', 'ui/templates/.gitkeep']);
    // initAuthentication composes the kit, so the project it writes is ui + auth, with ui declared first: the runtime
    // activates extensions in urlcode.yaml order and auth refuses before the kit is active. Built from both scaffolds
    // rather than a copied literal, so a change in either is caught here.
    const names = ['ui', 'auth'];
    const kit = await uiScaffold({ directory: output.directory, project: output.project, hostFile: output.hostFile, names });
    const fragment = await scaffold({ directory: output.directory, project: output.project, hostFile: output.hostFile, names });
    assert.equal(await readFile(join(output.project, 'urlcode.yaml'), 'utf8'), renderYaml({ version: '1', extensions: { ...kit.extensions, ...fragment.extensions }, routes: { ...kit.routes, ...fragment.routes } }));
    assert.ok(Object.keys({ ...kit.extensions, ...fragment.extensions })[0] === 'ui');
    const host = await readFile(output.hostFile, 'utf8');
    assert.ok(host.startsWith("import {fileURLToPath} from 'node:url';\nimport {createUiExtension} from '@jimhoyd/urlcode-ui/host';\n"));
    assert.ok(host.includes("import {authExtension} from '@jimhoyd/urlcode-auth';\n"));
    assert.ok(host.endsWith("export default {\n  extensions: [ui.registration, authExtension({service, csrfKey, projectSha256, ui})],\n  async close() { csrfKey.fill(0); await service.close(); },\n};\n"));
    const readme = await readFile(join(output.directory, 'README.md'), 'utf8');
    assert.ok(readme.startsWith('# Auth project and operator host\n\n'));
    assert.ok(readme.includes('This starter includes auth only.'));
    assert.equal(await readFile(join(output.directory, '.gitignore'), 'utf8'), 'node_modules/\ndata/\n.env\n.env.*\n');
    assert.deepEqual(JSON.parse(await readFile(join(output.directory, 'package.json'), 'utf8')), { name: 'urlcode-auth-site', private: true, version: '0.0.0', type: 'module', dependencies: output.dependencies });
});
