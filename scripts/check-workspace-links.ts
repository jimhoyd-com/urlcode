// Every workspace package must resolve core to THIS repository, not the registry.
//
// Core is the repository root rather than a workspace member (layout A, see
// docs/SPIKE-MONOREPO.md), so npm does not link it as a sibling automatically.
// That has already failed silently twice on this branch:
//
//   1. With nothing declared, npm resolved `@jimhoyd/urlcode` from the REGISTRY
//      at the published 0.4.0-alpha.2 -- 24 commits behind the tree it sat in.
//      Every test still passed, against the wrong core.
//   2. With a root `"overrides": {"@jimhoyd/urlcode": "file:."}`, the on-disk
//      symlink was right but the lockfile recorded the link as resolving to
//      `packages/auth`, so `npm ci` refused the tree outright.
//
// Both failures are invisible to the test suites, which is why this is a check
// rather than a comment. Each package declares `"@jimhoyd/urlcode":
// "file:../.."` and this asserts the result.
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = new URL('../', import.meta.url);
const rootDir = realpathSync(fileURLToPath(root));
const rootName = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).name as string;

const entries = await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []);
const failures: string[] = [];
let checked = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const manifestPath = `packages/${entry.name}/package.json`;
  const manifest = await readFile(new URL(manifestPath, root), 'utf8').catch(() => null);
  if (manifest === null) continue;
  const declared = JSON.parse(manifest) as {
    private?: unknown;
    publishConfig?: unknown;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  // Only packages that actually depend on core need the link.
  if (declared.peerDependencies?.[rootName] === undefined) continue;
  checked += 1;

  // First-party extensions are source workspaces for signed bundle releases,
  // never independently publishable npm packages. `npm pack` still works for
  // a private package, so this guard cannot remove the bundle builder's input.
  if (declared.private !== true) {
    failures.push(`${manifestPath} depends on core but is not private; it could be republished to npm outside the signed bundle release`);
  }
  if (declared.publishConfig !== undefined) {
    failures.push(`${manifestPath} depends on core but retains publishConfig; remove legacy npm publication settings`);
  }

  if (declared.devDependencies?.[rootName] !== 'file:../..') {
    failures.push(
      `${manifestPath} declares ${rootName} as a peer but does not devDepend on "file:../..", ` +
        'so npm is free to satisfy it from the registry',
    );
    continue;
  }

  let resolved: string;
  try {
    resolved = realpathSync(
      createRequire(resolve(rootDir, manifestPath)).resolve(`${rootName}/package.json`),
    );
  } catch {
    failures.push(`packages/${entry.name} cannot resolve ${rootName} at all; run npm install`);
    continue;
  }
  if (resolved !== resolve(rootDir, 'package.json')) {
    failures.push(
      `packages/${entry.name} resolves ${rootName} to ${resolved}, not this repository's own ` +
        `package.json -- it would build against a published core instead of the tree it lives in`,
    );
  }
}

if (failures.length > 0) {
  console.error(`Workspace packages are not linked to ${rootName} in this repository:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`Workspace link check: ${checked} package(s) resolve ${rootName} to this checkout.`);
