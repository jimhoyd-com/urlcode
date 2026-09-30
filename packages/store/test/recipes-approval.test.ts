import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showRecipe } from '@jimhoyd/urlcode';
import { commands, mergedSite, site } from './recipe-fixture.ts';

test('the store-approval recipe locks an approved request and serves reviewers a queue, with no handler code and no pin given', async t => {
  const approval = await site(t, 'store-approval');
  commands(approval);
  assert.equal(existsSync(approval.database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
  // YAML only: the recipe copies no module a route could run.
  const { files } = await showRecipe('store-approval');
  assert.deepEqual(files.filter(file => !/\.(ya?ml|json|md)$/.test(file)), []);
  assert.doesNotMatch(await readFile(join(approval.project, 'urlcode.yaml'), 'utf8'), /\b(function|middleware|module):/);
});

const name = 'store-approval';
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
