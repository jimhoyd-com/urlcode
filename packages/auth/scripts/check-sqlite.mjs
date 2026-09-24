#!/usr/bin/env node
// Pre-test check: fail fast, with the requirement named, when the bundled SQLite lacks the fixes the auth store requires.
import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
// Keep in sync with patched() in src/auth-store.ts, whose own boundary matrix is tested in
// test/auth-store.test.ts. Nothing currently cross-checks this copy against that source of truth
// (see packages/admin/scripts/check-sqlite.mjs for a third, likewise unchecked copy).
export const REQUIREMENT='SQLite 3.51.3 or newer (or a patched 3.50.7+ / 3.44.6+ release)';
export function patchedSqlite(/** @type {string} */ version){const [a=0,b=0,c=0]=String(version).split('.').map(Number);return a>3||a===3&&(b>51||b===51&&c>=3||b===50&&c>=7||b===44&&c>=6);}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const current=process.versions.sqlite||'';
 if(!patchedSqlite(current)){
  console.error(`The @jimhoyd/urlcode-auth store requires ${REQUIREMENT}, but this Node ${process.version} bundles SQLite ${current||'(unknown)'}. openAuthStore refuses to start on older SQLite (503 patched_sqlite_required), so the test suite cannot run here. Use a Node release that ships a patched SQLite, for example Node 26, and re-run.`);
  process.exit(1);
 }
}
