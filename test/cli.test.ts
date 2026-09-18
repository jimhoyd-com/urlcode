import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kitTemplates } from '../src/partials.ts';
function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, ['--conditions=development', '--disable-warning=ExperimentalWarning', 'src/host/cli.ts', ...args], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
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
