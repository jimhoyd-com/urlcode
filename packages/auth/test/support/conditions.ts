import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// --conditions=development resolves @jimhoyd/* through their "development"
// export condition (./src/*.ts), which only exists when node_modules holds
// symlinked sibling source checkouts -- the normal verify.yml flow. A real
// npm install, including the release workflow's "install published peers at
// the lower bound of each range" step, never ships src/, so the flag would
// make every such spawn fail with ERR_MODULE_NOT_FOUND. Detect which case
// this run is actually in rather than hardcoding the flag, so the same test
// works whether node_modules holds development checkouts or published
// tarballs.
function hasDevSource(pkg: string): boolean {
  try {
    return existsSync(fileURLToPath(new URL(`../../node_modules/${pkg}/src`, import.meta.url)));
  } catch {
    return false;
  }
}

export const devConditionArgs: string[] = ['@jimhoyd/urlcode', '@jimhoyd/urlcode-ui'].every(hasDevSource)
  ? ['--conditions=development']
  : [];
