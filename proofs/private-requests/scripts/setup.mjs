// Operator setup: forward-initializes Better Auth's schema in local SQLite, bootstraps three synthetic accounts
// through Better Auth's own server API, and adds the reviewer to the store's `reviewers` membership collection with
// the store's operator call. Safe to re-run: an existing account is looked up, not created again, and an existing
// member is left as it is. It uses @jimhoyd/urlcode-auth's options and migration, as `urlcode-auth migrate` and
// `create-user` do, because it also needs each account's id for the membership and honours PRIVATE_REQUESTS_DATA.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { betterAuth } from 'better-auth';
import { loadDocument } from '@jimhoyd/urlcode';
import { addMember } from '@jimhoyd/urlcode-store';
import { betterAuthOptions, defaultBasePath, migrate } from '@jimhoyd/urlcode-auth';
import { readSecret } from '@jimhoyd/urlcode-auth/extension';
import { authFiles, providerOptions } from '../operator/auth.mjs';

const site = fileURLToPath(new URL('..', import.meta.url));
const { data, database, secretFile } = authFiles(site);
mkdirSync(data, { recursive: true, mode: 0o700 });
// `urlcode extensions add auth` writes this file for a new site; this creates it when it is missing.
if (!process.env.BETTER_AUTH_SECRET && !existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });

// Synthetic local accounts only. Sign-up is disabled over HTTP; bootstrapping uses the server API with it enabled.
export const accounts = [
  { name: 'Ann Owner', email: 'ann@example.test', password: 'ann-local-demo-password' },
  { name: 'Bob Owner', email: 'bob@example.test', password: 'bob-local-demo-password' },
  { name: 'Rita Reviewer', email: 'rita@example.test', password: 'rita-local-demo-password', reviewer: true },
];
const options = betterAuthOptions({ database, secret: await readSecret(site, secretFile), betterAuth: providerOptions }, process.env.SITE_ORIGIN ?? 'http://localhost:4180', defaultBasePath, true);
await migrate(options);
const auth = betterAuth(options);
const context = await auth.$context;
// The reviewed project's own declaration: addMember validates the member against it.
const { collections } = (await loadDocument(join(site, 'app'))).document.extensions.store.config;
const users = {};
for (const account of accounts) {
  const existing = await context.internalAdapter.findUserByEmail(account.email);
  const id = existing?.user.id ?? (await auth.api.signUpEmail({ body: { name: account.name, email: account.email, password: account.password } })).user.id;
  users[account.email] = id;
  // The review permission is application data, keyed by Better Auth's opaque user id.
  if (account.reviewer) await addMember(join(data, 'store.sqlite'), { collections, collection: 'reviewers', principal: id });
}
console.log(JSON.stringify({ event: 'setup', data, users }));
