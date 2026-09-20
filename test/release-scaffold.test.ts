import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyReleaseScaffold } from '../scripts/release-scaffold.ts';

test('candidate and published consumer scaffolds activate UI before dependent auth and admin', () => {
  verifyReleaseScaffold('/isolated/consumer', (_command, args, cwd) => {
    assert.equal(cwd, '/isolated/consumer');
    const layers = args[args.indexOf('--with') + 1]!.split(',');
    assert(layers.indexOf('ui') < layers.indexOf('auth'), 'Auth refuses a scaffold before its UI kit');
    assert(layers.indexOf('auth') < layers.indexOf('admin'), 'Admin needs auth first');
    return JSON.stringify({ extensions: layers });
  });
});

test('release smoke rejects an incomplete scaffold even when the CLI succeeds', () => {
  assert.throws(() => verifyReleaseScaffold('/isolated/consumer', () => JSON.stringify({ extensions: ['ui', 'auth'] })), /deep-equal/);
});
