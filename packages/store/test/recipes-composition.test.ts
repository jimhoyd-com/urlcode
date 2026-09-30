import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commands, mergedSite } from './recipe-fixture.ts';

// #1019: every fixture signs in from one client address, and together these recipes sign in more than the ten times
// a minute a served auth mount allows. A hermetic run allows ten times that, so the merged site tests and audits ready.
for (const names of [['store-booking', 'store-credits'], ['store-credits', 'store-approval']]) {
  test(`${names.join(' and ')} merged sign in more than ten times and still test (twice) and audit ready`, async t => {
    const merged = await mergedSite(t, names);
    const signIns = (await readFile(join(merged.project, 'tests', 'requests.json'), 'utf8')).match(/"\/api\/auth\/sign-in\/email"/g)?.length ?? 0;
    assert.ok(signIns > 10, `${signIns} sign-ins`);
    commands(merged);
  });
}

test('two recipes merge into one site when they do not clash, sharing its auth mount, and a clash refuses with nothing written', async t => {
  const merged = await mergedSite(t, ['store-booking', 'protected-download']);
  commands(merged);
  const seed = JSON.parse(await readFile(join(merged.project, 'tests', 'seed.json'), 'utf8')) as { auth: { users: { id: string }[] } };
  assert.deepEqual(seed.auth.users.map(user => user.id), ['alice', 'bob', 'carol', 'ada']);

  // A site whose bookings collection was changed after the merge: adding the recipe again names that clash.
  const file = join(merged.project, 'urlcode.yaml'), text = (await readFile(file, 'utf8')).replace('enum: [atlas, borealis]', 'enum: [atlas, borealis, cosmos]');
  await writeFile(file, text);
  const before = await readFile(join(merged.project, 'tests', 'requests.json'), 'utf8');
  const refused = merged.add('store-booking');
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /extensions\.store\.config\.collections\.bookings in urlcode\.yaml differs/);
  assert.equal(await readFile(file, 'utf8'), text);
  assert.equal(await readFile(join(merged.project, 'tests', 'requests.json'), 'utf8'), before);
});
