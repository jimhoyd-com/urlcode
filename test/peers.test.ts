import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const SHA = /^[0-9a-f]{40}$/;

test('peers.json is the single source of verified peer revisions', async () => {
  const peers = JSON.parse(await readFile(new URL('peers.json', root), 'utf8')) as Record<string, string>;
  for (const name of ['urlcode', 'urlcode-ui']) assert.match(peers[name] ?? '', SHA, `${name} must be a 40-character commit sha`);
  const workflow = await readFile(new URL('.github/workflows/verify.yml', root), 'utf8');
  assert.match(workflow, /ref: \$\{\{ steps\.peers\.outputs\.urlcode \}\}/);
  assert.match(workflow, /ref: \$\{\{ steps\.peers\.outputs\.urlcode-ui \}\}/);
  assert.doesNotMatch(workflow, /ref: [0-9a-f]{40}/, 'workflow must not pin literal peer shas');
  for (const sha of Object.values(peers)) if (SHA.test(sha)) assert.doesNotMatch(workflow, new RegExp(sha));
});

test('check-sqlite.mjs agrees with patched() in src/auth-store.ts', async () => {
  const { patchedSqlite } = await import(pathToFileURL(new URL('scripts/check-sqlite.mjs', root).pathname).href) as { patchedSqlite: (v: string) => boolean };
  const { patched } = await import('../src/auth-store.ts');
  const matrix: Array<[string, boolean]> = [
    ['3.44.5', false], ['3.44.6', true], ['3.44.7', true],
    ['3.45.0', false], ['3.49.9', false],
    ['3.50.6', false], ['3.50.7', true], ['3.50.8', true],
    ['3.51.0', false], ['3.51.2', false], ['3.51.3', true], ['3.51.4', true],
    ['3.52.0', true], ['4.0.0', true], ['', false],
  ];
  for (const [version, expected] of matrix) {
    assert.equal(patched(version), expected, `patched(${version})`);
    assert.equal(patchedSqlite(version), expected, `check-sqlite(${version})`);
  }
});
