#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
// Fails fast before tests when the host SQLite lacks the fixes auth's store requires (same rule as auth's store gate).
export const requirement = 'SQLite 3.51.3 or newer (or 3.50.7+ within the 3.50 line, or 3.44.6+ within the 3.44 line)';
export function patched(version) { const [a = 0, b = 0, c = 0] = String(version).split('.').map(Number); return a > 3 || a === 3 && (b > 51 || b === 51 && c >= 3 || b === 50 && c >= 7 || b === 44 && c >= 6); }
export function check(version) {
  if (patched(version)) return null;
  return `URLCode admin tests need a Node release bundling ${requirement}, because @jimhoyd/urlcode-auth refuses to open its store on an unpatched SQLite and every admin test that opens a service would fail with patched_sqlite_required. This Node ${process.versions.node} bundles SQLite ${version || '(unknown)'}. Install a current Node 22/24/26 release and rerun.`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const message = check(process.versions.sqlite || '');
  if (message) { process.stderr.write(message + '\n'); process.exit(1); }
}
