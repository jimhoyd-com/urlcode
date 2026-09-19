import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Cross-repository tests need a built core checkout: a urlcode working copy whose
// dist/index.js exists, because they resolve @jimhoyd/urlcode through the package's
// published export map rather than its source. Resolve it the way verify.yml in the
// sibling repos does -- an explicit path, or a checkout symlinked into
// node_modules/@jimhoyd -- instead of hardcoding one machine's directory.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export const coreHint =
  'set URLCODE_CORE to a urlcode checkout that has been built (npm ci && npm run build there), ' +
  'or symlink one into node_modules/@jimhoyd/urlcode';

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
  return { reason: `no built core checkout found; ${coreHint}` };
}

// A test that can only ever skip is indistinguishable from one that passes, so CI
// demands the checkout: verify.yml sets URLCODE_REQUIRE_CORE after checking core out,
// and naming URLCODE_CORE is itself a request to run against it. Everywhere else --
// a plain local `npm run verify`, or the sibling repos' workflows, which build this
// package as a peer rather than exercising its own peer matrix -- the test skips with
// a message saying how to supply core.
export function coreRequired(): boolean {
  return Boolean(process.env.URLCODE_CORE?.trim()) || process.env.URLCODE_REQUIRE_CORE === '1';
}
