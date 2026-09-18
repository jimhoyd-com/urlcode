import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUiExtension, uiConfigSchema } from '../src/host/extension.ts';
import type { ExtensionActivation, ExtensionRequest } from '../src/host/extension.ts';
import { loadProjectUi } from '../src/host/loader.ts';
const sha = 'a'.repeat(64);
async function project(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-'));
    await mkdir(join(root, 'ui', 'copy'), { recursive: true });
    await mkdir(join(root, 'ui', 'templates', 'auth'), { recursive: true });
    await writeFile(join(root, 'ui', 'copy', 'fr.json'), JSON.stringify({ 'ui.skip': 'Aller au contenu', 'auth.title': 'Connexion' }));
    await writeFile(join(root, 'ui', 'templates', 'layout.html'), '{{!-- viewModel: layout@1 --}}<html lang="{{lang}}"><body class="custom">{{content}}</body></html>');
    await writeFile(join(root, 'ui', 'templates', 'auth', 'sign-in.html'), '<div>{{t "auth.title"}}</div>');
    await writeFile(join(root, 'ui', 'extra.css'), '.mine{color:red}');
    return root;
}
const activation = (mounts: string[]): ExtensionActivation => ({ origin: 'https://example.test', target: 'node', projectSha256: sha, mounts });
const request = (path: string, method = 'GET', headers: Record<string, string> = {}): ExtensionRequest => ({ method, target: path, path, query: new URLSearchParams(), headers: new Headers(headers), headerCounts: {}, body: new Uint8Array(), origin: 'https://example.test', route: '/assets/ui/*', mount: '/assets/ui', client: null });
test('the ui extension owns extensions.ui, builds the kit from the project files and serves hashed assets at its mount', async () => {
    const root = await project();
    const ui = createUiExtension({ projectSha256: sha, projectRoot: root, sources: [{ 'auth.title': 'Sign in' }] });
    assert.equal(ui.registration.name, 'ui');
    assert.deepEqual(ui.registration.targets, ['node', 'aws', 'vercel']);
    assert.throws(() => ui.kit, /not active/);
    const instance = await ui.registration.activate({ languages: ['en', 'fr'], copy: 'ui/copy', templates: 'ui/templates', stylesheet: 'ui/extra.css', theme: { name: 'Acme', colors: { primary: '24 95% 53%' } } }, activation(['/assets/ui']));
    assert.ok(ui.active);
    const kit = ui.kit;
    assert.equal(kit.assetsBase, '/assets/ui');
    assert.equal(kit.info('layout')!.origin, 'project');
    assert.equal(kit.render('auth/sign-in', {}, kit.resolveContext({ queryLocale: 'fr' })).html, '<div>Connexion</div>');
    assert.ok(kit.assets[0]!.body.endsWith('.mine{color:red}'));
    const css = kit.assets[0]!;
    const served = await instance.handle(request(`/assets/ui/${css.name}`));
    assert.equal(served.status, 200);
    assert.equal(served.headers.find(([name]) => name === 'content-type')?.[1], 'text/css; charset=utf-8');
    assert.equal(served.body, css.body);
    assert.equal((await instance.handle(request(`/assets/ui/${css.name}`, 'GET', { 'if-none-match': `"${css.hash}"` }))).status, 304);
    assert.equal((await instance.handle(request(`/assets/ui/${css.name}`, 'HEAD'))).body, undefined);
    assert.equal((await instance.handle(request('/assets/ui/other.css'))).status, 404);
    assert.equal((await instance.handle(request(`/assets/ui/${css.name}`, 'POST'))).status, 405);
    const page = new TextDecoder().decode(kit.page('auth/sign-in', {}, { title: 'Sign in', preferences: { acceptLanguage: 'fr' } }).body);
    assert.match(page, /^<html lang="fr"><body class="custom"><div>Connexion<\/div><\/body><\/html>$/);
    await instance.close?.();
    assert.throws(() => ui.kit, /not active/);
});
test('activation refuses a wrong mount count, and the configuration schema rejects unknown keys', async () => {
    const root = await project();
    const ui = createUiExtension({ projectSha256: sha, projectRoot: root });
    await assert.rejects(async () => ui.registration.activate({}, activation([])), /exactly one route mount/);
    await assert.rejects(async () => ui.registration.activate({}, activation(['/a', '/b'])), /exactly one route mount/);
    assert.throws(() => createUiExtension({ projectSha256: 'short', projectRoot: root }), /revision pin/);
    await assert.rejects(async () => createUiExtension({ projectSha256: sha, projectRoot: root, sources: [{ 'ui.close': 'x' }] }).registration.activate({}, activation(['/assets/ui'])), /registered twice/);
    assert.equal(uiConfigSchema.additionalProperties, false);
    assert.ok('theme' in uiConfigSchema.properties && 'languages' in uiConfigSchema.properties);
});
test('the loader stays inside the project, bounds sizes and counts, ignores symlinks and rejects executable stylesheet content', async () => {
    const root = await project();
    await assert.rejects(() => loadProjectUi(root, { copy: '../outside' }), /relative path/);
    await assert.rejects(() => loadProjectUi(root, { copy: '/etc' }), /relative path/);
    await mkdir(join(root, 'link-target'));
    await symlink(tmpdir(), join(root, 'ui', 'escape'));
    await assert.rejects(() => loadProjectUi(root, { templates: 'ui/escape' }), /inside the project/);
    await assert.rejects(() => loadProjectUi(root, { languages: ['en', 'de'], copy: 'ui/copy' }), /ENOENT|missing/);
    await assert.rejects(() => loadProjectUi(root, { languages: ['en', 'de'] }), /need a copy directory/);
    await writeFile(join(root, 'ui', 'bad.css'), '.x{background:url(x)} @import "evil.css";');
    await assert.rejects(() => loadProjectUi(root, { stylesheet: 'ui/bad.css' }), /disallowed content/);
    await writeFile(join(root, 'ui', 'templates', 'Bad.html'), 'x');
    await assert.rejects(() => loadProjectUi(root, { templates: 'ui/templates' }), /not a template name/);
    const loaded = await loadProjectUi(root, { languages: ['en', 'fr'], copy: 'ui/copy' });
    assert.deepEqual(Object.keys(loaded.catalogues), ['fr']);
    assert.equal(loaded.stylesheet, undefined);
});
test('the asset handler answers 405 with an allow header for other methods and 304 only on a matching etag', async () => {
    const ui = createUiExtension({ projectSha256: sha, projectRoot: await project() });
    const instance = await ui.registration.activate({}, activation(['/assets/ui']));
    const css = ui.kit.assets[0]!, path = `/assets/ui/${css.name}`;
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'get']) {
        const result = await instance.handle(request(path, method));
        assert.equal(result.status, 405, method);
        assert.equal(result.headers.find(([name]) => name === 'allow')?.[1], 'GET, HEAD');
    }
    assert.equal((await instance.handle(request('/assets/ui/missing.css', 'POST'))).status, 405, 'method is checked before the path');
    for (const method of ['GET', 'HEAD']) {
        const hit = await instance.handle(request(path, method, { 'if-none-match': `"${css.hash}"` }));
        assert.equal(hit.status, 304, method);
        assert.equal(hit.body, undefined);
        assert.equal(hit.headers.find(([name]) => name === 'etag')?.[1], `"${css.hash}"`);
    }
    assert.equal((await instance.handle(request(path, 'GET', { 'if-none-match': css.hash }))).status, 200, 'unquoted tag does not match');
    assert.equal((await instance.handle(request(path, 'GET', { 'if-none-match': `W/"${css.hash}"` }))).status, 200, 'weak tag does not match');
    assert.equal((await instance.handle(request(path, 'GET', { 'if-none-match': '"other"' }))).status, 200);
    await instance.close?.();
});
