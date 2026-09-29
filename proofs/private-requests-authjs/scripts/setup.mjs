// Operator setup: the Auth.js secret, three synthetic accounts in the operator's account file, and the reviewer's
// membership in the store's `reviewers` collection (the store's own operator call, as in the Better Auth proof).
// Safe to re-run: existing accounts keep their ids and an existing member is left as it is.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadDocument } from '@jimhoyd/urlcode';
import { addMember } from '@jimhoyd/urlcode-store';
import { siteFiles } from '../operator/auth.mjs';
import { ensureUsers } from '../operator/users.mjs';

const site = fileURLToPath(new URL('..', import.meta.url));
const { data, secretFile, usersFile, storeDatabase } = siteFiles(site);
mkdirSync(data, { recursive: true, mode: 0o700 });
if (!process.env.AUTH_SECRET && !existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });

// Synthetic local accounts only; the same ones the Better Auth proof uses.
export const accounts = [
  { name: 'Ann Owner', email: 'ann@example.test', password: 'ann-local-demo-password' },
  { name: 'Bob Owner', email: 'bob@example.test', password: 'bob-local-demo-password' },
  { name: 'Rita Reviewer', email: 'rita@example.test', password: 'rita-local-demo-password', reviewer: true },
];
const users = await ensureUsers(usersFile, accounts);
const { collections } = (await loadDocument(join(site, 'app'))).document.extensions.store.config;
for (const account of accounts.filter(entry => entry.reviewer)) {
  // The review permission is application data, keyed by the opaque user id Auth.js puts in the session.
  await addMember(storeDatabase, { collections, collection: 'reviewers', principal: users[account.email] });
}
console.log(JSON.stringify({ event: 'setup', data, users }));
