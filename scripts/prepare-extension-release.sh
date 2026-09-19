#!/usr/bin/env bash
set -euo pipefail
if [ "$PACKAGE_DIR" = packages/ui ]; then
  npm run build
  npm run verify --workspace "$PACKAGE_NAME"
else
  npm run release:peers
  npm run workspace:styles
  npm run typecheck --workspace "$PACKAGE_NAME"
  npm run build --workspace "$PACKAGE_NAME"
  node "$PACKAGE_DIR/scripts/check-sqlite.mjs"
  # Published peers contain dist, not their development export sources.
  (cd "$PACKAGE_DIR" && node --test test/*.test.ts)
fi
npm audit --omit=dev --audit-level=low
mkdir candidate
npm pack --workspace "$PACKAGE_NAME" --ignore-scripts --pack-destination candidate
(cd candidate && sha256sum -- *.tgz > SHA256SUMS)
