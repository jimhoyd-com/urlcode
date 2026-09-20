#!/usr/bin/env bash
set -euo pipefail
if [ "$PACKAGE_DIR" = packages/ui ]; then
  npm run build
  npm run verify --workspace "$PACKAGE_NAME"
else
  # Build what this package typechecks against, in dependency order. Its
  # imports resolve through each dependency's exports map to dist/types, so an
  # unbuilt core or ui fails with TS2307 "cannot find module" rather than
  # anything that names the real cause. Nothing else in this branch builds
  # them: the ui branch above runs a root build, this one never did, so auth
  # and admin released green only while a previous job had left dist behind.
  npm run build
  npm run workspace:styles
  npm run build --workspace @jimhoyd/urlcode-ui
  if [ "$PACKAGE_DIR" != packages/auth ]; then
    npm run build --workspace @jimhoyd/urlcode-auth
  fi
  npm run typecheck --workspace "$PACKAGE_NAME"
  npm run build --workspace "$PACKAGE_NAME"
  # Test a separate copy against registry peers, never workspace links.
  npm run release:peers
fi
npm audit --omit=dev --audit-level=low
node scripts/package-audit.ts "$PACKAGE_DIR"
mkdir candidate
npm pack --workspace "$PACKAGE_NAME" --ignore-scripts --pack-destination candidate
(cd candidate && sha256sum -- *.tgz > SHA256SUMS)
