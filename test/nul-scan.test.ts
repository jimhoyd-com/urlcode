import test from 'node:test';
import assert from 'node:assert/strict';
import { findNul, trackedTextFilesWithNul } from '../scripts/nul-scan.ts';

test('findNul flags text files with a literal NUL and ignores binary assets', () => {
  const nul = new Uint8Array([0x2f, 0x5b, 0x00, 0x5d]);
  const clean = new TextEncoder().encode('/[\\x00]/u');
  assert.deepEqual(findNul([
    { path: 'src/a.ts', bytes: nul },
    { path: 'docs/b.md', bytes: nul },
    { path: 'src/ok.ts', bytes: clean },
    { path: 'assets/logo.png', bytes: nul },
  ]), ['src/a.ts', 'docs/b.md']);
});

test('no tracked text file contains a literal NUL byte', async () => {
  assert.deepEqual(await trackedTextFilesWithNul(process.cwd()), []);
});
