import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showRecipe } from '@jimhoyd/urlcode';
import { commands, site } from './recipe-fixture.ts';

test('the store-booking recipe books one-hour slots for staff only, refuses overlaps and frees a cancelled slot, with no pin given', async t => {
  const booking = await site(t, 'store-booking');
  const { database } = booking;
  commands(booking);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

test('the store-credits recipe funds wallets from a members-only issuer, pays by a unique handle and keeps the total, with no pin given', async t => {
  const credits = await site(t, 'store-credits');
  const { database } = credits;
  // Who may issue is data: tests/seed.json seeds the issuer the fixtures sign in as into each run's throwaway database.
  commands(credits);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

test('the store-approval recipe locks an approved request and serves reviewers a queue, with no handler code and no pin given', async t => {
  const approval = await site(t, 'store-approval');
  commands(approval);
  assert.equal(existsSync(approval.database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
  // YAML only: the recipe copies no module a route could run.
  const { files } = await showRecipe('store-approval');
  assert.deepEqual(files.filter(file => !/\.(ya?ml|json|md)$/.test(file)), []);
  assert.doesNotMatch(await readFile(join(approval.project, 'urlcode.yaml'), 'utf8'), /\b(function|middleware|module):/);
});
