import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cross-repository tests need a built core checkout: a urlcode working copy whose
// dist/index.js exists, because they resolve @jimhoyd/urlcode through the package's
// published export map rather than its source. Resolve it the way verify.yml in the
// sibling repos does -- an explicit path, or a checkout symlinked into
// node_modules/@jimhoyd -- instead of hardcoding one machine's directory.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Since this package moved into core's repository as packages/ui, the core
// checkout is no longer something to go and find: it is two directories up,
// always present, always the exact revision this package is being tested
// against. That is the drift this consolidation removes -- there is no pinned
// peer revision left to go stale. It still has to be *built*, because the
// cross-repository tests resolve @jimhoyd/urlcode through its published export
// map rather than its source.
const monorepoCore = fileURLToPath(new URL('../../../../', import.meta.url));

async function isMonorepoCore(root: string): Promise<boolean> {
  const manifest = await readFile(join(root, 'package.json'), 'utf8').catch(() => null);
  if (manifest === null) return false;
  try {
    return (JSON.parse(manifest) as { name?: unknown }).name === '@jimhoyd/urlcode';
  } catch {
    return false;
  }
}

export const coreHint =
  'run `npm run build` at the repository root to build core, ' +
  'or set URLCODE_CORE to a built urlcode checkout elsewhere';

async function isBuilt(root: string): Promise<boolean> {
  return access(join(root, 'dist', 'index.js')).then(() => true, () => false);
}

export type CoreCheckout = { root: string; reason?: undefined } | { root?: undefined; reason: string };

export async function findCore(): Promise<CoreCheckout> {
  const explicit = process.env.URLCODE_CORE?.trim();
  if (explicit) {
    const root = isAbsolute(explicit) ? explicit : join(repoRoot, explicit);
    return (await isBuilt(root)) ? { root } : { reason: `URLCODE_CORE=${explicit} is not a built core checkout (no dist/index.js); ${coreHint}` };
  }
  const linked = join(repoRoot, 'node_modules', '@jimhoyd', 'urlcode');
  if (await isBuilt(linked)) return { root: linked };
  if (await isMonorepoCore(monorepoCore)) {
    return (await isBuilt(monorepoCore))
      ? { root: monorepoCore }
      : { reason: `core is this repository's root but has not been built (no dist/index.js); ${coreHint}` };
  }
  return { reason: `no built core checkout found; ${coreHint}` };
}

// A test that can only ever skip is indistinguishable from one that passes, so
// the checkout is demanded wherever it can be. In the consolidated repository
// core is a sibling that cannot be absent, so the test is always required and a
// missing build is a failure rather than a skip. The explicit opt-ins remain
// for anyone running this package standalone: naming URLCODE_CORE is itself a
// request to run against it, and URLCODE_REQUIRE_CORE=1 demands it outright.
export async function coreRequired(): Promise<boolean> {
  if (process.env.URLCODE_CORE?.trim()) return true;
  if (process.env.URLCODE_REQUIRE_CORE === '1') return true;
  return isMonorepoCore(monorepoCore);
}
