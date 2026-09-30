// Two store recipes merged into one site sign in more often than a served auth mount allows (recipe-site.ts says how
// these sites run).
import test from 'node:test';
import { mergedSignInsReady } from './recipe-site.ts';

for (const names of [['store-booking', 'store-credits'], ['store-credits', 'store-approval']]) {
  test(`${names.join(' and ')} merged sign in more than ten times and still test (twice) and audit ready`, t => mergedSignInsReady(t, names));
}
