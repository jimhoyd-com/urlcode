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
 * depending on one: the CLI resolves whatever `--extensions` names with Node package resolution from
 * `--project`, and reads the contribution off the package's own export.
 */
async function site(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'urlcode-ui-site-'));
    const pkg = join(root, 'node_modules', '@fixture', 'peer');
    await mkdir(join(pkg), { recursive: true });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@fixture/peer', version: '1.0.0', type: 'module', main: 'index.js' }));
    await writeFile(join(pkg, 'index.js'), `export const peerUiTemplates = Object.freeze({
        name: 'peer',
        templates: {'peer/card': '{{!-- viewModel: peer/card@2 --}}<p>{{t "peer.greeting"}}</p><p>{{message}}</p>'},
        catalogue: {'peer.greeting': 'Hello from the peer'},
        samples: {'peer/card': {message: 'Sample message'}},
    });
    export const peerAlias = peerUiTemplates;
    export const notANamespace = {name: 'peer', helpers: {}};
    `);
    const plain = join(root, 'node_modules', '@fixture', 'plain');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'package.json'), JSON.stringify({ name: '@fixture/plain', version: '1.0.0', type: 'module', main: 'index.js' }));
    await writeFile(join(plain, 'index.js'), 'export const helpers = {};\n');
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
    // The alias export is the same object and must not register the namespace, or its copy, twice.
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
    assert.match(cli(['list', '--project', root, '--extensions', '@fixture/plain']).stderr, /^skipped @fixture\/plain: no kit templates exported$/m);
    // Only package names: nothing relative, absolute or URL-shaped, and a bounded number of them.
    for (const value of ['../evil', '/etc/passwd', 'file:///etc/passwd', './peer'])
        assert.equal(cli(['list', '--project', root, '--extensions', value]).status, 1, value);
    assert.equal(cli(['list', '--project', root, '--extensions', Array.from({ length: 17 }, (_, index) => `pkg-${index}`).join(',')]).status, 1);
    // Without the flag the CLI is the bare kit, as before.
    const bare = cli(['list', '--project', root]);
    assert.equal(bare.stdout.trim().split('\n').length, Object.keys(kitTemplates).length);
});
