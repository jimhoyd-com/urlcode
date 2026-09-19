import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readdir, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scaffold, directoryName } from '../src/host/scaffold.ts';
import { writeFile } from 'node:fs/promises';
import { createUiExtension } from '../src/host/extension.ts';
import * as host from '../src/host/index.ts';
import * as main from '../src/index.ts';
const request = { directory: '/srv/acme-site', project: '/srv/acme-site/app', hostFile: '/srv/acme-site/host.mjs', names: ['ui', 'auth', 'admin'] };
test('scaffold returns the shared contract: theme from the directory, the assets mount, a relocatable host fragment and ui/ files', async () => {
    const result = await scaffold(request);
    assert.equal(result.name, 'ui');
    const block = result.extensions.ui as { version: string; config: Record<string, unknown> };
    assert.equal(block.version, '1');
    assert.deepEqual(block.config.theme, { name: 'acme-site', colors: { primary: '220 9% 46%', primaryForeground: '0 0% 100%', dark: { primary: '220 9% 72%', primaryForeground: '224 10% 10%' } } });
    assert.deepEqual({ copy: block.config.copy, templates: block.config.templates, stylesheet: block.config.stylesheet, languages: block.config.languages }, { copy: 'ui/copy', templates: 'ui/templates', stylesheet: 'ui/extra.css', languages: ['en'] });
    assert.deepEqual(result.routes, { '/assets/ui/*': { extension: 'ui', methods: ['GET', 'HEAD'] } });
    assert.deepEqual(result.hostEntries, ['ui.registration']);
    assert.ok(result.hostImports.includes("import {createUiExtension} from '@jimhoyd/urlcode-ui/host';"));
    assert.ok(result.hostSetup.some(line => line.includes("createUiExtension({projectSha256: uiProjectSha256, projectRoot: fileURLToPath(new URL('./', import.meta.url)), sources: []})")));
    assert.ok(result.hostSetup.some(line => line.includes('process.env.PROJECT_SHA256')));
    assert.equal(result.hostClose, undefined);
    assert.deepEqual(result.files.map(file => file.path), ['ui/copy/.gitkeep', 'ui/templates/.gitkeep', 'ui/extra.css']);
    assert.ok(result.files.every(file => typeof file.content === 'string' && file.mode === undefined && !file.path.startsWith('app/')));
    assert.match(String(result.files[2]!.content), /^\/\*.*\*\/\n$/s);
    assert.match(result.readme, /`ui\.registration` first/); assert.match(result.readme, /--with ui,auth,admin/);
    assert.deepEqual(result.nextSteps.map(step => step.split(' ').slice(0, 3).join(' ')), ['npx urlcode-ui doctor', 'npx urlcode-ui eject']);
    assert.equal(result.env?.PROJECT_SHA256, 'Reviewed project revision from inspectExtensionRevision; re-review after any project change.');
    // The site reference follows the host file's location.
    const nested = await scaffold({ ...request, hostFile: '/srv/acme-site/ops/host.mjs' });
    assert.ok(nested.hostSetup.some(line => line.includes("new URL('../', import.meta.url)")));
    assert.equal(directoryName('/srv/acme-site/'), 'acme-site'); assert.equal(directoryName('C:\\sites\\acme'), 'acme');
    const weird = (await scaffold({ ...request, directory: '/srv/<weird>' })).extensions.ui as { config: { theme: { name: string } } };
    assert.equal(weird.config.theme.name, 'weird');
});
test('scaffold refuses bad requests, never writes, and both entries export it Node-free', async () => {
    await assert.rejects(scaffold({ ...request, names: ['auth'] }), /must include ui/);
    await assert.rejects(scaffold({ ...request, directory: 'relative' }), /absolute directory/);
    await assert.rejects(scaffold({ ...request, hostFile: '' }), /absolute hostFile/);
    await assert.rejects(scaffold(null as never), /request is required/);
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-scaffold-'));
    await scaffold({ directory: join(root, 'site'), project: join(root, 'site', 'app'), hostFile: join(root, 'site', 'host.mjs'), names: ['ui'] });
    assert.deepEqual(await readdir(root), []);
    // The placeholder files activate under the block the fragment declares.
    const site = join(root, 'site');
    const generated = await scaffold({ directory: site, project: join(site, 'app'), hostFile: join(site, 'host.mjs'), names: ['ui'] });
    for (const file of generated.files) { await mkdir(join(site, file.path, '..'), { recursive: true }); await writeFile(join(site, file.path), file.content); }
    const ui = createUiExtension({ projectSha256: 'a'.repeat(64), projectRoot: site, sources: [] });
    const instance = await ui.registration.activate((generated.extensions.ui as { config: Record<string, unknown> }).config, { origin: 'https://example.test', target: 'node', projectSha256: 'a'.repeat(64), mounts: ['/assets/ui'], root: site });
    assert.ok(ui.kit.assets[0]!.body.includes('Appended after the kit stylesheet'));
    assert.equal(ui.kit.info('layout')!.origin, 'kit');
    await instance.close?.();
    assert.equal(main.scaffold, scaffold); assert.equal(host.scaffold, scaffold);
    // Every identifier the host fragment imports from ./host is a real export.
    const result = await scaffold(request);
    for (const line of result.hostImports) {
        const match = /^import \{([^}]+)\} from '@jimhoyd\/urlcode-ui\/host';$/.exec(line);
        if (!match) { assert.match(line, /^import \{fileURLToPath\} from 'node:url';$/); continue; }
        for (const name of match[1]!.split(',').map(s => s.trim())) assert.equal(typeof (host as Record<string, unknown>)[name], 'function', name);
    }
    for (const line of result.hostSetup) assert.doesNotMatch(line, /\/srv\//, 'no absolute request path leaks into the host module');
});
// The fragment validates with core when a checkout with a build is present.
const core = '/home/user/wt/core-main-admin10';
const coreAbsent = await access(join(core, 'dist', 'index.js')).then(() => false, () => true);
test('the ui fragment validates as a project document with core', { skip: coreAbsent ? `core checkout not built at ${core}` : false }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-core-'));
    await mkdir(join(root, 'node_modules', '@jimhoyd'), { recursive: true });
    await symlink(core, join(root, 'node_modules', '@jimhoyd', 'urlcode'), 'dir');
    const entry = createRequire(join(root, 'package.json')).resolve('@jimhoyd/urlcode');
    const { validateDocument } = await import(pathToFileURL(entry).href) as { validateDocument(document: unknown): unknown };
    const result = await scaffold(request);
    assert.doesNotThrow(() => validateDocument({ version: '1', extensions: result.extensions, routes: result.routes }));
    assert.doesNotThrow(() => validateDocument({ version: '1', routes: result.routes }));
});
