// Every workspace package must resolve core, and any workspace sibling it
// peers on, to THIS repository, not the registry.
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
// "file:../.."` for core, and `"@jimhoyd/urlcode-<name>": "file:../<name>"`
// for any workspace sibling it peers on (auth on ui, admin on ui and auth,
// forms on ui, ...), and this asserts the result for all of them (#477).
import { readdir, readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolves the directory npm's `node_modules` would hand a `require(name)` in
 * `fromDir`, the way Node's CommonJS resolver walks `node_modules` directories
 * from `fromDir` up to the filesystem root -- but stopping at the directory,
 * never requiring an entry file to exist. A sibling package's restrictive
 * `exports` (only `.`, no `./package.json`) makes `require.resolve` an entry
 * file unusable here when `dist/` has not been built yet.
 */
function resolvePackageDir(fromDir: string, name: string): string | undefined {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const root = new URL('../', import.meta.url);
const rootDir = realpathSync(fileURLToPath(root));
const rootName = JSON.parse(await readFile(new URL('package.json', root), 'utf8')).name as string;

interface Manifest {
  name?: string;
  private?: unknown;
  publishConfig?: unknown;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const entries = await readdir(new URL('packages/', root), { withFileTypes: true }).catch(() => []);
const packageDirs = new Map<string, string>(); // package name -> directory name
const manifests = new Map<string, Manifest>(); // directory name -> manifest

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const manifestPath = `packages/${entry.name}/package.json`;
  const raw = await readFile(new URL(manifestPath, root), 'utf8').catch(() => null);
  if (raw === null) continue;
  const declared = JSON.parse(raw) as Manifest;
  manifests.set(entry.name, declared);
  if (declared.name) packageDirs.set(declared.name, entry.name);
}

const failures: string[] = [];
let checked = 0;

for (const [dir, declared] of manifests) {
  const manifestPath = `packages/${dir}/package.json`;
  // Every peer that resolves to core or to a sibling workspace package needs a "file:" devDependency link.
  const workspacePeers = Object.keys(declared.peerDependencies ?? {}).filter(
    name => name === rootName || packageDirs.has(name),
  );
  if (workspacePeers.length === 0) continue;
  checked += 1;

  // First-party extensions are source workspaces for signed bundle releases,
  // never independently publishable npm packages. `npm pack` still works for
  // a private package, so this guard cannot remove the bundle builder's input.
  if (declared.private !== true) {
    failures.push(`${manifestPath} depends on a workspace package but is not private; it could be republished to npm outside the signed bundle release`);
  }
  if (declared.publishConfig !== undefined) {
    failures.push(`${manifestPath} depends on a workspace package but retains publishConfig; remove legacy npm publication settings`);
  }

  for (const peerName of workspacePeers) {
    const peerDir = peerName === rootName ? '..' : packageDirs.get(peerName)!;
    const expectedLink = `file:../${peerDir}`;
    if (declared.devDependencies?.[peerName] !== expectedLink) {
      failures.push(
        `${manifestPath} declares ${peerName} as a peer but does not devDepend on "${expectedLink}", ` +
          'so npm is free to satisfy it from the registry',
      );
      continue;
    }

    const expectedDir = peerName === rootName ? rootDir : realpathSync(fileURLToPath(new URL(`packages/${peerDir}/`, root)));
    const resolved = resolvePackageDir(dirname(resolve(rootDir, manifestPath)), peerName);
    if (resolved === undefined) {
      failures.push(`packages/${dir} cannot resolve ${peerName} at all; run npm install`);
      continue;
    }
    if (resolved !== expectedDir) {
      failures.push(
        `packages/${dir} resolves ${peerName} to ${resolved}, not this repository's own ` +
          `packages/${peerName === rootName ? '' : peerDir} -- ` +
          'it would build against a published package instead of the tree it lives in',
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`Workspace packages are not linked to their workspace peers in this repository:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`Workspace link check: ${checked} package(s) resolve their workspace peers (core and siblings) to this checkout.`);
