import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commands, mergedSite } from './recipe-fixture.ts';

// #1019: combined recipes must not exhaust the hermetic sign-in budget.
test('store-booking and store-credits merged sign in more than ten times and still test (twice) and audit ready', async t => {
    const merged = await mergedSite(t, ['store-booking', 'store-credits']);
    const signIns = (await readFile(join(merged.project, 'tests', 'requests.json'), 'utf8')).match(/"\/api\/auth\/sign-in\/email"/g)?.length ?? 0;
    assert.ok(signIns > 10, `${signIns} sign-ins`);
    commands(merged);
});
