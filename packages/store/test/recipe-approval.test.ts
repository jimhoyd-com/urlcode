// The store-approval recipe, alone and merged into a site (recipe-site.ts says how these sites run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showRecipe } from '@jimhoyd/urlcode';
import { commands, mergesReady, site } from './recipe-site.ts';

test('the store-approval recipe locks an approved request and serves reviewers a queue, with no handler code and no pin given', async t => {
  const approval = await site(t, 'store-approval');
  commands(approval);
  assert.equal(existsSync(approval.database), false, 'validate, test and audit under --local-review never open the configured database (#954)');
  // YAML only: the recipe copies no module a route could run.
  const { files } = await showRecipe('store-approval');
  assert.deepEqual(files.filter(file => !/\.(ya?ml|json|md)$/.test(file)), []);
  assert.doesNotMatch(await readFile(join(approval.project, 'urlcode.yaml'), 'utf8'), /\b(function|middleware|module):/);
});

test('recipes add store-approval --project merges it into an init + extensions add auth store site that validates, tests and audits ready', t => mergesReady(t, 'store-approval'));
