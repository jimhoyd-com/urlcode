---
"@jimhoyd/urlcode": patch
---

Make extension bundle install failures diagnosable (#579). An attestation refusal now quotes a bounded, sanitized excerpt of the `gh attestation verify` output and the policy applied (signer workflow and `refs/tags/<release>` source ref) instead of discarding it. `urlcode init --with` and `urlcode extension-bundles install` check bundle names against the ones this core release builds before any network call, with a did-you-mean suggestion for typos. An unreachable GitHub is reported as such, naming the release being fetched, instead of the generic "Operation failed" message. The bundle release workflow now builds and attests only on the release tag ref (a dispatch from `main` creates the tag and re-dispatches on it) and verifies its assets with the CLI's own policy before and after publishing.
