// The store-credits recipe, alone and merged into a site (recipe-site.ts says how these sites run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { commands, mergesReady, site } from './recipe-site.ts';

test('the store-credits recipe funds wallets from a members-only issuer, pays by a unique handle and keeps the total, with no pin given', async t => {
  const credits = await site(t, 'store-credits');
  const { database } = credits;
  // Who may issue is data: tests/seed.json seeds the issuer the fixtures sign in as into each run's throwaway database.
  commands(credits);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

test('recipes add store-credits --project merges it into an init + extensions add auth store site that validates, tests and audits ready', t => mergesReady(t, 'store-credits'));
