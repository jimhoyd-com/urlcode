import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitTemplates } from '../src/partials.ts';
function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--conditions=development', '--disable-warning=ExperimentalWarning', 'src/host/cli.ts', ...args], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
test('list names every template with its origin and view model', () => {
    const { status, stdout } = cli(['list']);
    assert.equal(status, 0);
    assert.match(stdout, /^layout\tkit\tlayout@3$/m);
    assert.equal(stdout.trim().split('\n').length, Object.keys(kitTemplates).length);
});
test('eject copies a shipped template into a new file and never overwrites', async () => {
    const out = await mkdtemp(join(tmpdir(), 'urlcode-ui-eject-'));
    const first = cli(['eject', 'layout', '--out', out]);
    assert.equal(first.status, 0);
    assert.equal(await readFile(join(out, 'layout.html'), 'utf8'), kitTemplates.layout!.source);
    const second = cli(['eject', 'layout', '--out', out]);
    assert.equal(second.status, 1);
    assert.deepEqual(await readdir(out), ['layout.html']);
    assert.equal(cli(['eject', 'nope', '--out', out]).status, 1);
});
test('preview renders a complete page for a template, and doctor reports as JSON', () => {
    const preview = cli(['preview', 'card', '--lang', 'en', '--theme', '{"name":"Acme"}']);
    assert.equal(preview.status, 0);
    assert.match(preview.stdout, /^<!doctype html>/);
    assert.match(preview.stdout, /Welcome back/);
    assert.match(preview.stdout, /· Acme<\/title>/);
    const doctor = cli(['doctor']);
    assert.equal(doctor.status, 0);
    const report = JSON.parse(doctor.stdout) as { templates: unknown[]; assets: { name: string }[] };
    assert.equal(report.templates.length, Object.keys(kitTemplates).length);
    assert.match(report.assets[0]!.name, /^kit\.[0-9a-f]{12}\.css$/);
    assert.equal(cli(['nope']).status, 1);
    assert.match(cli([]).stdout, /^urlcode-ui list/);
});
/**
 * A peer extension package, stood up on disk so this package can exercise the namespace loader without
 * depending on one: the CLI resolves `<name>/extension` for whatever `--extensions` names, with Node package
 * resolution from `--project`, and reads `definition.contributes.ui` off its default export. The package root
 * exports nothing: discovery never scans exports by shape.
 */
async function site(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-site-'));
    const pkg = join(root, 'node_modules', '@fixture', 'peer');
    await mkdir(join(pkg), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/peer', version: '1.0.0', type: 'module', exports: { '.': './index.js', './extension': './extension.js' } }));
    await writeFile(join(pkg, 'index.js'), 'export {};\n');
    await writeFile(join(pkg, 'extension.js'), `const catalogue = {'peer.greeting': 'Hello from the peer'};
    const peerUiTemplates = Object.freeze({
        name: 'peer',
        templates: {'peer/card': '{{!-- viewModel: peer/card@2 --}}<p>{{t "peer.greeting"}}</p><p>{{message}}</p>'},
        samples: {'peer/card': {message: 'Sample message'}},
    });
    const definition = {name: 'peer', description: 'Peer', schema: {type: 'object'}, contributes: {ui: {sources: [catalogue], templates: [peerUiTemplates, peerUiTemplates]}}, host() { throw new Error('must not run'); }};
    const entry = options => ({definition, options: options ?? {}});
    entry.definition = definition;
    export default entry;
    `);
    const plain = join(root, 'node_modules', '@fixture', 'plain');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'package.json'), JSON.stringify({ name: '@fixture/plain', version: '1.0.0', type: 'module', exports: { '.': './index.js', './extension': './extension.js' } }));
    await writeFile(join(plain, 'index.js'), 'export const helpers = {};\n');
    await writeFile(join(plain, 'extension.js'), "export default {definition: {name: 'plain', description: 'Plain', schema: {type: 'object'}, host() { throw new Error('must not run'); }}};\n");
    const library = join(root, 'node_modules', '@fixture', 'library');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'package.json'), JSON.stringify({ name: '@fixture/library', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }));
    await writeFile(join(library, 'index.js'), 'export const helpers = {};\n');
    // A package whose definition contributes a template namespace under another extension's name.
    const impostor = join(root, 'node_modules', '@fixture', 'impostor');
    await mkdir(impostor, { recursive: true });
    await writeFile(join(impostor, 'package.json'), JSON.stringify({ name: '@fixture/impostor', version: '1.0.0', type: 'module', exports: { './extension': './extension.js' } }));
    await writeFile(join(impostor, 'extension.js'), "export default {definition: {name: 'impostor', description: 'Impostor', schema: {type: 'object'}, contributes: {ui: {templates: [{name: 'peer', templates: {'peer/card': '<p>x</p>'}}]}}, host() { throw new Error('must not run'); }}};\n");
    await mkdir(join(root, 'ui', 'templates', 'peer'), { recursive: true });
    await mkdir(join(root, 'ui', 'copy'), { recursive: true });
    await writeFile(join(root, 'ui', 'copy', 'fr.json'), '{}');
    return root;
}
test('a named package contributes its templates, copy and samples to every command', async () => {
    const root = await site();
    const peer = ['--project', root, '--extensions', '@fixture/peer'];
    const listed = cli(['list', ...peer]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^peer\/card\textension:peer\tpeer\/card@2$/m);
    assert.equal(listed.stdout.trim().split('\n').length, Object.keys(kitTemplates).length + 1);
    // A namespace contributed twice registers once, its copy with it.
    assert.equal(listed.stderr, '');
    // preview renders the extension's own sample through the kit, and its copy resolves.
    const preview = cli(['preview', 'peer/card', ...peer]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /Hello from the peer/);
    assert.match(preview.stdout, /Sample message/);
    // eject copies the extension's shipped source, not just the kit's.
    const out = await mkdtemp(join(tmpdir(), 'urlcode-ui-peer-eject-'));
    assert.equal(cli(['eject', 'peer/card', '--out', out, ...peer]).status, 0);
    assert.match(await readFile(join(out, 'peer', 'card.html'), 'utf8'), /viewModel: peer\/card@2/);
    // A project override of an extension template is checked against the shipped view model it has to keep
    // up with: that check is the whole point of the flag, and without the package there is nothing to check.
    await writeFile(join(root, 'ui', 'templates', 'peer', 'card.html'), '{{!-- viewModel: peer/card@1 --}}<p>stale</p>');
    const config = ['--copy', 'ui/copy', '--templates', 'ui/templates', '--languages', 'en,fr'];
    const doctor = cli(['doctor', ...peer, ...config]);
    assert.equal(doctor.status, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout) as { behind: { name: string; expected: string }[]; extensions: { specifier: string; name: string; templates: number }[]; languages: { locale: string; missing: string[] }[] };
    assert.deepEqual(report.behind.map(entry => [entry.name, entry.expected]), [['peer/card', 'peer/card@2']]);
    assert.deepEqual(report.extensions, [{ specifier: '@fixture/peer', name: 'peer', templates: 1, catalogue: 1, samples: 1 }]);
    assert.ok(report.languages[0]!.missing.includes('peer.greeting'));
    // A translator is offered the extension's ids with the English text, like any other.
    const missing = JSON.parse(cli(['copy', '--missing', 'fr', ...peer, ...config]).stdout) as { skeleton: Record<string, string> };
    assert.equal(missing.skeleton['peer.greeting'], 'Hello from the peer');
});
test('extension packages are named, resolved from the project and bounded', async () => {
    const root = await site();
    // Not installed in this project: the command still reports the kit rather than failing.
    const absent = cli(['list', '--project', root, '--extensions', '@fixture/peer,@fixture/absent']);
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stderr, /^skipped @fixture\/absent: not installed$/m);
    // Installed, but contributing no namespace, is worth saying too.
    assert.match(cli(['list', '--project', root, '--extensions', '@fixture/plain']).stderr, /^skipped @fixture\/plain: no ui templates contributed$/m);
    // A package with no ./extension entry is not an extension.
    assert.match(cli(['list', '--project', root, '--extensions', '@fixture/library']).stderr, /^skipped @fixture\/library: no \.\/extension entry$/m);
    // A namespace must be its contributing definition's own name, exactly as ui refuses at host composition.
    const impostor = cli(['list', '--project', root, '--extensions', '@fixture/impostor']);
    assert.equal(impostor.status, 1);
    assert.match(impostor.stderr, /ui template namespace "peer" is contributed by extension "impostor"/);
    // Only package names: nothing relative, absolute or URL-shaped, and a bounded number of them.
    for (const value of ['../evil', '/etc/passwd', 'file:///etc/passwd', './peer'])
        assert.equal(cli(['list', '--project', root, '--extensions', value]).status, 1, value);
    assert.equal(cli(['list', '--project', root, '--extensions', Array.from({ length: 17 }, (_, index) => `pkg-${index}`).join(',')]).status, 1);
    // Without the flag the CLI is the bare kit, as before.
    const bare = cli(['list', '--project', root]);
    assert.equal(bare.stdout.trim().split('\n').length, Object.keys(kitTemplates).length);
});
