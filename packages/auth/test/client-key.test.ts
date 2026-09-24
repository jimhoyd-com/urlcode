import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clientKey } from '../src/client-key.ts';

// The same vectors pin core's clientKey (test/client-address.test.ts), so the two
// implementations cannot drift apart (#547).
test('auth client keys match the shared core vectors', () => {
    const { vectors } = JSON.parse(readFileSync(new URL('../../../test/client-key-vectors.json', import.meta.url), 'utf8')) as { vectors: [string | null, string | null][] };
    assert.ok(vectors.length > 10);
    for (const [input, expected] of vectors)
        assert.equal(clientKey(input), expected ?? undefined, String(input));
});
