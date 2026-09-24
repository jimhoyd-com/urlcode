import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDocument } from '@jimhoyd/urlcode';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldRequest, ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { composeHost } from '@jimhoyd/urlcode/host';
import ui from '../src/extension.ts';
import type { UiContribution } from '../src/extension.ts';
import type { UiExtension } from '../src/host/extension.ts';
import { directoryName } from '../src/host/scaffold.ts';
import * as host from '../src/host/index.ts';
import * as main from '../src/index.ts';

const request = (installed: string[], site = '/srv/acme-site'): ScaffoldRequest => ({ site, project: `${site}/app`, installed, acknowledgements: [] });
const scaffold = async (installed: string[], site?: string): Promise<ScaffoldResult> => ui.definition.scaffold!(request(installed, site));
const sha = 'a'.repeat(64);

test('the definition names ui, requires nothing and carries the runtime schema, hooks and authoring', () => {
    const { definition } = ui;
    assert.equal(definition.name, 'ui');
    assert.deepEqual(definition.requires ?? [], []);
    assert.equal(definition.schema, host.uiConfigSchema);
    assert.equal(definition.authoring, host.uiAuthoring);
    assert.deepEqual(definition.hooks?.map(hook => hook.name), ['transformView', 'transformPage']);
    assert.ok(definition.description.length > 0 && !definition.description.includes('\n'));
    // The old composition contract is gone from both entries; only ./extension is the add-on entry.
    assert.equal('scaffold' in main, false); assert.equal('scaffold' in host, false);
});

test('ui alone: theme from the site name, the assets mount and the ui/ override files', async () => {
    const result = await scaffold(['ui']);
    assert.deepEqual(Object.keys(result).sort(), ['config', 'files', 'notes', 'routes']);
    assert.deepEqual(result.config.theme, { name: 'acme-site', colors: { primary: '220 9% 46%', primaryForeground: '0 0% 100%', dark: { primary: '220 9% 72%', primaryForeground: '224 10% 10%' } } });
    assert.deepEqual({ copy: result.config.copy, templates: result.config.templates, stylesheet: result.config.stylesheet, languages: result.config.languages }, { copy: 'ui/copy', templates: 'ui/templates', stylesheet: 'ui/extra.css', languages: ['en'] });
    assert.equal('screens' in result.config, false);
    assert.equal('version' in result.config, false, 'config is the inner block; core wraps it');
    assert.deepEqual(result.routes, { '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] } });
    assert.deepEqual(result.files!.map(file => file.path), ['ui/copy/.gitkeep', 'ui/templates/.gitkeep', 'ui/extra.css']);
    assert.ok(result.files!.every(file => typeof file.content === 'string' && file.mode === undefined && !file.path.startsWith('app/') && !file.path.startsWith('node_modules/')));
    assert.match(String(result.files![2]!.content), /^\/\*.*\*\/\n$/s);
    assert.ok(result.notes!.every(note => !note.includes('\n') && !note.includes('--extensions')), result.notes!.join('\n'));
    assert.ok(result.notes!.some(note => note.includes('eject layout')));
    assert.equal(directoryName('/srv/acme-site/'), 'acme-site'); assert.equal(directoryName('C:\\sites\\acme'), 'acme');
    assert.equal(((await scaffold(['ui'], '/srv/<weird>')).config.theme as { name: string }).name, 'weird');
});

test('ui with store adds the /todos screen and route; with auth too the route is signed-in', async () => {
    const withStore = await scaffold(['store', 'ui']);
    assert.deepEqual(withStore.config.screens, { '/todos': { collection: 'todos', title: 'Todos' } });
    assert.deepEqual(withStore.routes, { '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] }, '/todos/*': { extension: 'ui', methods: ['GET', 'HEAD'] } });
    assert.ok(withStore.notes!.some(note => note.includes('/todos')));
    const signedIn = await scaffold(['auth', 'store', 'ui']);
    assert.deepEqual(signedIn.routes['/todos/*'], { extension: 'ui', methods: ['GET', 'HEAD'], auth: true });
    assert.ok(signedIn.notes!.some(note => note.includes('--extensions @jimhoyd/urlcode-auth') && !note.includes('urlcode-admin')));
    assert.ok(signedIn.notes!.some(note => note.includes('eject auth/sign-in')));
    // auth without store adds no screen, so nothing needs signing in.
    assert.deepEqual(Object.keys((await scaffold(['auth', 'ui'])).routes), ['/assets/ui/*']);
});

test('the scaffold validates as a project document with core and never writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-scaffold-'));
    try {
        for (const installed of [['ui'], ['store', 'ui'], ['auth', 'store', 'ui']]) {
            const result = await scaffold(installed, join(root, 'site'));
            assert.doesNotThrow(() => validateDocument({ version: '1', extensions: { ui: { version: '1', config: result.config } }, routes: result.routes }));
        }
        assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('host() through composeHost registers ui with the definition schema, resolves ui/ in the site and receives contributions', async t => {
    const site = await mkdtemp(join(tmpdir(), 'urlcode-ui-host-'));
    t.after(() => rm(site, { recursive: true, force: true }));
    const previous = process.env.PROJECT_SHA256;
    process.env.PROJECT_SHA256 = sha;
    t.after(() => { if (previous === undefined) delete process.env.PROJECT_SHA256; else process.env.PROJECT_SHA256 = previous; });
    const scaffolded = await scaffold(['demo', 'ui'], site);
    for (const file of scaffolded.files!) { await mkdir(join(site, file.path, '..'), { recursive: true }); await writeFile(join(site, file.path), file.content); }
    // A peer that renders through the kit contributes its copy and templates the way auth and admin do.
    const contribution: UiContribution = { sources: [{ 'demo.title': 'Demo title' }], templates: [{ name: 'demo', templates: { 'demo/page': '<p>{{title}}</p>' } }] };
    let received: UiExtension | undefined;
    const demoSchema = { type: 'object', additionalProperties: false };
    const demo = defineExtension({
        name: 'demo', description: 'Test peer', requires: ['ui'], schema: demoSchema, contributes: { ui: contribution },
        host(context) {
            received = context.get<UiExtension>('ui');
            return { registration: { name: 'demo', version: '1', projectSha256: context.projectSha256, targets: ['node'], schema: demoSchema, activate: () => ({ handle: () => ({ status: 404, headers: [] }) }) } };
        },
    });
    // The list order is irrelevant: demo requires ui, so ui is hosted first.
    const composed = await composeHost(pathToFileURL(join(site, 'host.mjs')), [demo(), ui()]);
    t.after(() => composed.close?.());
    const registration = composed.extensions!.find(extension => extension.name === 'ui')!;
    assert.equal(registration.projectSha256, sha);
    assert.equal(JSON.stringify(registration.schema), JSON.stringify(ui.definition.schema));
    assert.ok(received && received.registration === registration, 'ui exports the UiExtension its dependants read with get("ui")');
    const instance = await registration.activate(scaffolded.config, { origin: 'https://example.test', target: 'node', projectSha256: sha, mounts: ['/assets/ui'], root: join(site, 'app') } as never);
    t.after(() => instance.close?.());
    assert.ok(received!.active);
    assert.ok(received!.kit.assets[0]!.body.includes('Appended after the kit stylesheet'), 'ui/extra.css resolves against the site');
    assert.equal(received!.kit.info('demo/page')?.origin, 'extension:demo');
    assert.equal(received!.kit.presentation.english['demo.title'], 'Demo title');
});

test('host options add sources and templates after the contributions', async t => {
    const site = await mkdtemp(join(tmpdir(), 'urlcode-ui-host-'));
    t.after(() => rm(site, { recursive: true, force: true }));
    const { registration, exports } = await ui.definition.host({ projectSha256: sha, site, get: () => { throw new Error('ui requires nothing'); }, contributions: <T>() => [{ sources: [{ 'a.one': 'One' }] }] as T[] }, { sources: [{ 'b.two': 'Two' }] });
    const kit = exports as UiExtension;
    await registration.activate({}, { origin: 'https://example.test', target: 'node', projectSha256: sha, mounts: ['/assets/ui'], root: site } as never);
    assert.equal(kit.kit.presentation.english['a.one'], 'One'); assert.equal(kit.kit.presentation.english['b.two'], 'Two');
});
