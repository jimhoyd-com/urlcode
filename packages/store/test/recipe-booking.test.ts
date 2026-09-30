// The store-booking recipe, alone and merged into a site (recipe-site.ts says how these sites run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { commands, mergesReady, site } from './recipe-site.ts';

test('the store-booking recipe books one-hour slots for staff only, refuses overlaps and frees a cancelled slot, with no pin given', async t => {
  const booking = await site(t, 'store-booking');
  const { database } = booking;
  commands(booking);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

test('recipes add store-booking --project merges it into an init + extensions add auth store site that validates, tests and audits ready', t => mergesReady(t, 'store-booking'));
