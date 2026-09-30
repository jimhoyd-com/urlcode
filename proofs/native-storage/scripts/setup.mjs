// Operator setup: the Auth.js secret and two synthetic accounts in the operator's account file. The application's
// own database needs no setup step: app/functions/notes.mjs creates its table on first use, in the granted data
// directory. Safe to re-run: existing accounts keep their ids.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { siteFiles } from '../operator/auth.mjs';
import { ensureUsers } from '../operator/users.mjs';

const { data, secretFile, usersFile } = siteFiles(fileURLToPath(new URL('..', import.meta.url)));
mkdirSync(data, { recursive: true, mode: 0o700 });
if (!process.env.AUTH_SECRET && !existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });

// Synthetic local accounts only, with fixed ids.
const users = await ensureUsers(usersFile, [
  { id: 'ann', name: 'Ann Owner', email: 'ann@example.test', password: 'ann-local-demo-password' },
  { id: 'bob', name: 'Bob Owner', email: 'bob@example.test', password: 'bob-local-demo-password' },
]);
console.log(JSON.stringify({ event: 'setup', data, users }));
