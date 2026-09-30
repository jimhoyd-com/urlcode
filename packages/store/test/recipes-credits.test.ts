import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showRecipe } from '@jimhoyd/urlcode';
import { commands, mergedSite, site } from './recipe-fixture.ts';

test('the store-credits recipe funds wallets from a members-only issuer, pays by a unique handle and keeps the total, with no pin given', async t => {
  const credits = await site(t, 'store-credits');
  const { database } = credits;
  // Who may issue is data: tests/seed.json seeds the issuer the fixtures sign in as into each run's throwaway database.
  commands(credits);
  assert.equal(existsSync(database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
});

const name = 'store-credits';
  test(`recipes add ${name} --project merges it into an init + extensions add auth store site that validates, tests and audits ready`, async t => {
    const merged = await mergedSite(t, [name]);
    assert.equal(merged.routes, (await showRecipe(name)).routes);
    // The audit's committed route count moved with the routes the merge added, so audit needs no --expect-routes.
    assert.deepEqual(JSON.parse(await readFile(join(merged.project, 'tests', 'audit.json'), 'utf8')), { expectRoutes: merged.routes });
    commands(merged);
    const audited = merged.run('audit');
    assert.equal(audited.status, 0, audited.stdout + audited.stderr);
    assert.match(audited.stdout, /"countMatches":true/);
    assert.equal(existsSync(merged.database), false);
  });
