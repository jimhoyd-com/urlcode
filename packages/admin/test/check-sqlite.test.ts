import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, patched, requirement } from '../scripts/check-sqlite.mjs';
const script = fileURLToPath(new URL('../scripts/check-sqlite.mjs', import.meta.url));
test('SQLite pre-test gate matches the auth store rule at every boundary', () => {
    for (const version of ['3.51.3', '3.51.10', '3.52.0', '3.53.4', '4.0.0', '3.50.7', '3.50.9', '3.44.6', '3.44.9'])
        assert.equal(patched(version), true, version);
    for (const version of ['', '3', '3.51', '3.51.2', '3.50.6', '3.49.2', '3.45.0', '3.44.5', '3.43.9', '2.9.9', 'x.y.z'])
        assert.equal(patched(version), false, version);
});
test('gate message names the requirement and the current version', () => {
    assert.equal(check('3.51.3'), null);
    const message = check('3.51.2')!;
    assert.ok(message.includes(requirement));
    assert.ok(message.includes('SQLite 3.51.2'));
    assert.ok(message.includes(process.versions.node));
    assert.ok(!message.includes('\n'), 'one paragraph');
});
test('running the script exits 1 only on an unpatched SQLite', () => {
    const current = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(current.status, patched(process.versions.sqlite || '') ? 0 : 1);
    const forced = spawnSync(process.execPath, ['--input-type=module', '-e', `Object.defineProperty(process.versions,'sqlite',{value:'3.51.2'}); const {check}=await import(${JSON.stringify(script)}); const m=check(process.versions.sqlite); if(m){console.error(m);process.exit(1);}`], { encoding: 'utf8' });
    assert.equal(forced.status, 1);
    assert.match(forced.stderr, /3\.51\.3/);
});
