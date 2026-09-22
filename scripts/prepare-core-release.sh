#!/usr/bin/env bash
# Candidate preparation. No GitHub credentials enter the container.
set -euo pipefail
image=$(node scripts/release.ts image)
docker run --rm -v "$PWD:/source" -w /source \
  -e URLCODE_SOURCE_SHA -e URLCODE_RELEASE_VERSION -e URLCODE_CHANNEL -e URLCODE_CANDIDATE_RUN \
  "$image" sh -ec '
    # Git is a test-tool dependency for temporary release/CI fixture repositories.
    # The runtime image and npm archives do not gain this dependency.
    apt-get update
    apt-get install --yes --no-install-recommends git
    rm -rf /var/lib/apt/lists/*
    # The Actions checkout is bind-mounted from the runner, so its owner need
    # not match the release container user. Trust only that fixed checkout:
    # package smoke clones it to exercise git-based npm installation.
    git config --global --add safe.directory /source
    npm ci --ignore-scripts
    npm audit --omit=dev --audit-level=low
    npm run verify
    npm run test:package:built
    node dist/scripts/operational-drills.js
    node scripts/build-candidate.ts
    if [ "$URLCODE_CHANNEL" = candidate ]; then
      node scripts/prepare-release-train.ts
    fi
    if [ "$URLCODE_CHANNEL" = release ]; then
      node scripts/render-homebrew.ts --tarball "candidate/$(node -p '\''require("./package.json").name.replace("@", "").replace("/", "-")'\'')-$URLCODE_RELEASE_VERSION.tgz"
    fi
  '
