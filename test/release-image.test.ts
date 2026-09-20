import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateImage, assertPromotedImage, assertImageChannel } from '../scripts/release-image.ts';

const sha = 'a'.repeat(40);
const digest = `sha256:${'b'.repeat(64)}`;
const labels = { 'org.opencontainers.image.revision': sha, 'org.opencontainers.image.version': '0.4.1' };
const candidate = candidateImage({ digest, sourceCommit: sha, version: '0.4.1' }, sha, '0.4.1');

test('tested and promoted image must be the identical digest with matching labels', () => {
  assertPromotedImage(candidate, { digest, labels });
  assert.throws(() => assertPromotedImage(candidate, { digest: `sha256:${'c'.repeat(64)}`, labels }), /cannot substitute bytes/);
  assert.throws(() => assertPromotedImage(candidate, { digest, labels: { ...labels, 'org.opencontainers.image.revision': 'd'.repeat(40) } }), /revision/);
  assert.throws(() => assertPromotedImage(candidate, { digest, labels: { ...labels, 'org.opencontainers.image.version': '0.4.2' } }), /version/);
});
test('a rebuilt image with correct labels but different bytes is rejected on retry', () => {
  assert.throws(() => assertPromotedImage(candidate, { digest: `sha256:${'e'.repeat(64)}`, labels }));
});
test('candidate image records are validated', () => {
  for (const bad of [null, [], {}, { digest: 'sha256:short', sourceCommit: sha, version: '0.4.1' }, { digest, sourceCommit: 'f'.repeat(40), version: '0.4.1' }, { digest, sourceCommit: sha, version: '9.9.9' }])
    assert.throws(() => candidateImage(bad, sha, '0.4.1'));
});
test('image channel tags are monotonic', () => {
  assertImageChannel('0.4.1');
  assertImageChannel('0.4.1', '0.4.1');
  assertImageChannel('0.4.1', '0.4.0-alpha.3');
  assert.throws(() => assertImageChannel('0.4.0-alpha.3', '0.4.1'), /regression/);
});
