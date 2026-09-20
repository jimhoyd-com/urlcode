import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '@jimhoyd/urlcode';
import * as admin from '../src/index.ts';
import { scaffold as uiScaffold } from '@jimhoyd/urlcode-ui';
import { scaffold } from '../src/scaffold.ts';
// ui first: admin renders through its kit and the runtime activates extensions in declaration order.
const request = { directory: '/tmp/site', project: '/tmp/site/app', hostFile: '/tmp/site/host.mjs', names: ['ui', 'auth', 'admin'] as const };
test('scaffold returns the shared contract shape and never writes', async () => {
    const result = await scaffold(request);
    assert.equal(result.name, 'admin');
    for (const key of ['extensions', 'routes'])
        assert.equal(typeof (result as unknown as Record<string, unknown>)[key], 'object');
    for (const key of ['hostImports', 'hostSetup', 'hostEntries', 'files', 'nextSteps'] as const)
        assert.ok(Array.isArray(result[key]), key);
    assert.equal(typeof result.readme, 'string');
    assert.deepEqual(result.files, [], 'auth owns keys and the operator service');
    assert.equal(result.env, undefined);
    assert.equal(result.hostClose, undefined, 'auth closes the shared service');
    assert.deepEqual(result.extensions, { admin: { version: '1', config: {} } });
    assert.deepEqual(Object.keys(result.routes), ['/admin/*']);
    assert.equal(result.hostEntries.length, 1);
    assert.match(result.hostEntries[0]!, /adminExtension\(\{service, csrfKey, projectSha256, ui, authMount: '\/account'\}\)/);
    for (const identifier of ['service', 'csrfKey', 'projectSha256', 'ui'])
        assert.ok(result.readme.includes(`\`${identifier}\``), `readme states the shared ${identifier} identifier`);
    assert.match(result.readme, /^## Administration/);
});
test('scaffold refuses a host without auth, or without ui before admin', async () => {
    await assert.rejects(scaffold({ ...request, names: ['ui', 'admin'] }), /auth/);
    await assert.rejects(scaffold({ ...request, names: ['auth', 'admin'] }), /requires the ui extension/);
    await assert.rejects(scaffold({ ...request, names: ['auth', 'admin', 'ui'] }), /requires the ui extension before admin/);
    await assert.rejects(scaffold({ ...request, project: '' }), /project/);
});
test('merged extensions and routes validate with core', async () => {
    const result = await scaffold(request), ui = await uiScaffold(request);
    const document = validateDocument({
        version: '1',
        extensions: { ...ui.extensions, auth: { version: '1', config: { registration: 'off' } }, ...result.extensions },
        routes: { ...ui.routes, '/account/*': { extension: 'auth', methods: ['GET', 'HEAD', 'POST'] }, ...result.routes },
    });
    assert.equal(document.routes['/admin/*']?.extension, 'admin');
    assert.deepEqual(Object.keys(document.extensions ?? {}), ['ui', 'auth', 'admin']);
});
test('host imports name real package exports', async () => {
    const result = await scaffold(request);
    for (const line of result.hostImports) {
        const match = /^import \{([^}]+)\} from '@jimhoyd\/urlcode-admin';$/.exec(line);
        assert.ok(match, line);
        for (const name of match![1]!.split(',').map((s) => s.trim()))
            assert.equal(typeof (admin as Record<string, unknown>)[name], 'function', name);
    }
    for (const entry of result.hostEntries)
        assert.ok(result.hostImports.some((line) => line.includes(entry.slice(0, entry.indexOf('(')))), entry);
});
