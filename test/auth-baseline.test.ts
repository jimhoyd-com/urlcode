import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAuthBaseline } from '../src/auth-baseline.ts';

test('offline synthetic baseline exercises runtime boundaries and removes fixtures', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'baseline-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const result = await runAuthBaseline({ temporaryDirectory: directory });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.liveProviders, 'unverified');
    assert.ok(result.checks.some(check => check.name === 'guest.credentials-and-derived-context-withheld'));
    assert.ok(result.checks.some(check => check.name === 'enrollment.protected-route-denied'));
    assert.ok(result.checks.every(check => check.passed));
    assert.deepEqual(await readdir(directory), []);
    const timed = await runAuthBaseline({ temporaryDirectory: directory, timeoutMs: 100 });
    assert.equal(timed.passed, false);
    assert.equal(timed.checks[0]?.name, 'baseline.completed-within-deadline');
    assert.deepEqual(await readdir(directory), []);
});

test('baseline CLI needs no operator module and rejects one rather than importing it', () => {
    const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    const run = spawnSync(process.execPath, ['--conditions=development', cli, 'auth-baseline'], { encoding: 'utf8', timeout: 40000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.equal(JSON.parse(run.stdout).passed, true);
    const rejected = spawnSync(process.execPath, [cli, 'auth-baseline', '--operator-file', '/SECRET/operator.mjs'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(rejected.status, 1);
    assert.ok(!rejected.stderr.includes('SECRET'));
});
