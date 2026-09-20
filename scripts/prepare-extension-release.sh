#!/usr/bin/env bash
set -euo pipefail
if [ "$PACKAGE_DIR" = packages/ui ]; then
  npm run build
  npm run verify --workspace "$PACKAGE_NAME"
else
  npm run workspace:styles
  npm run typecheck --workspace "$PACKAGE_NAME"
  npm run build --workspace "$PACKAGE_NAME"
  # Test a separate copy against registry peers, never workspace links.
  npm run release:peers
fi
npm audit --omit=dev --audit-level=low
mkdir candidate
npm pack --workspace "$PACKAGE_NAME" --ignore-scripts --pack-destination candidate
(cd candidate && sha256sum -- *.tgz > SHA256SUMS)
