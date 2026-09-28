import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {addRecipe, runProjectTests, startServer} from '@jimhoyd/urlcode';
import {inspectExtensionRevision} from '@jimhoyd/urlcode/extensions';
import {composeHost} from '@jimhoyd/urlcode/host';
import audit from '@jimhoyd/urlcode-audit/extension';
import mail from '@jimhoyd/urlcode-mail/extension';
import ui from '@jimhoyd/urlcode-ui/extension';
import auth from '../src/extension.ts';
import {createAuthService} from '../src/index.ts';
import {cleanup} from './cleanup.ts';

test('authenticated handlers recipe keeps native auth and explicit function routes through repeatable client fixtures', async t => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-auth-handlers-'));
    cleanup(t, () => rm(root, {recursive: true, force: true}));
    const project = join(root, 'app'), data = join(root, 'data');
    await mkdir(data);
    await addRecipe('authenticated-handlers', project);
    // Resolve only the public package import to this checkout; the copied handler behavior is unchanged.
    for (const name of ['me', 'echo']) {
        const file = join(project, 'functions', `${name}.mjs`);
        const source = await readFile(file, 'utf8');
        assert.ok(source.includes("from '@jimhoyd/urlcode-auth'"));
        await writeFile(file, source.replace("'@jimhoyd/urlcode-auth'", JSON.stringify(new URL('../src/index.ts', import.meta.url).href)));
    }
    const service = await createAuthService({database: join(data, 'auth.sqlite'), encryptionKey: randomBytes(32), roles: {member: [], admin: ['*']}, defaultRole: 'member', registrationMode: 'open'});
    cleanup(t, () => service.close());
    const previous = process.env.PROJECT_SHA256;
    process.env.PROJECT_SHA256 = await inspectExtensionRevision(project);
    cleanup(t, () => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
    const host = await composeHost(pathToFileURL(join(root, 'host.mjs')), [audit({database: join(data, 'audit.sqlite')}), mail({transport: null}), ui(), auth({service, csrfKey: randomBytes(32)})]);
    cleanup(t, () => host.close?.());
    const origin = 'https://api.example.com', events: object[] = [];
    const first = await runProjectTests(project, {extensions: host.extensions!, origin, log: event => events.push(event)});
    assert.ok(first.total >= 30);
    assert.equal(first.failed, 0, JSON.stringify(events));
    assert.deepEqual(await runProjectTests(project, {extensions: host.extensions!, origin}), first);
    const server = await startServer({project, extensions: host.extensions!, origin, port: 0, log: () => {}});
    cleanup(t, () => server.close());
    const routes = server.testPlan().inventory;
    assert.equal(routes.length, 4);
    assert.equal((await readFile(join(project, 'urlcode.yaml'), 'utf8')).includes('/api/*'), false, 'application routes remain visible individually');
    // The shipped source stays a normal package import; the test does not bake its temporary path into the recipe.
    const recipe = join(dirname(fileURLToPath(import.meta.url)), '../../../recipes/authenticated-handlers/functions/me.mjs');
    assert.match(await readFile(recipe, 'utf8'), /from '@jimhoyd\/urlcode-auth'/);
});
