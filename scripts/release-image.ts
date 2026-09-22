// Container promotion invariants (issue #233). Pure and NOT wired into any workflow:
// nothing here builds, pushes or tags an image. See docs/CONTAINER-PROMOTION.md.
// A candidate records the image manifest digest it tested; a publisher may only
// promote exactly that digest, and a retry may only accept a registry tag that
// already resolves to it.
import assert from 'node:assert/strict';
import { assertChannel } from './release.ts';

interface CandidateImage { digest: string; sourceCommit: string; version: string }
interface RegistryImage { digest: string; labels: Record<string, string | undefined> }
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function candidateImage(value: unknown, sha: string, version: string): CandidateImage {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Candidate manifest records no image');
  const image = value as Record<string, unknown>;
  assert(typeof image.digest === 'string' && DIGEST.test(image.digest), 'Candidate image digest must be sha256:<64 hex>');
  assert.equal(image.sourceCommit, sha, 'Candidate image source commit mismatch');
  assert.equal(image.version, version, 'Candidate image version mismatch');
  return { digest: image.digest, sourceCommit: sha, version };
}
/** The registry object promoted (or found by a retry) must be the tested digest with the tested labels. */
export function assertPromotedImage(candidate: CandidateImage, registry: RegistryImage): void {
  assert(DIGEST.test(registry.digest), 'Registry digest is malformed');
  assert.equal(registry.digest, candidate.digest, 'Registry image differs from the tested candidate digest; a retry cannot substitute bytes');
  assert.equal(registry.labels['org.opencontainers.image.revision'], candidate.sourceCommit, 'Image revision label mismatch');
  assert.equal(registry.labels['org.opencontainers.image.version'], candidate.version, 'Image version label mismatch');
}
/** Channel tags move forward only; an absent channel is allowed. */
export function assertImageChannel(version: string, priorVersionLabel?: string): void {
  assertChannel(version, priorVersionLabel);
}
