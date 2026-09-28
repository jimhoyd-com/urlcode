// Operator setup: forward-initializes Better Auth's schema and the application's tables in local SQLite, and
// bootstraps three synthetic accounts through Better Auth's own server API. Safe to re-run.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMigrations } from 'better-auth/db/migration';
import { betterAuth } from 'better-auth';
import { authOptions, dataDirectory } from '../operator/auth.mjs';
import { database } from '../app/lib/requests.mjs';

const site = fileURLToPath(new URL('..', import.meta.url));
const data = dataDirectory(site);
mkdirSync(data, { recursive: true });
const secretFile = join(data, 'auth-secret');
if (!process.env.BETTER_AUTH_SECRET && !existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('base64url') + '\n', { mode: 0o600 });

// Synthetic local accounts only. Sign-up is disabled over HTTP; bootstrapping uses the server API with it enabled.
export const accounts = [
  { name: 'Ann Owner', email: 'ann@example.test', password: 'ann-local-demo-password' },
  { name: 'Bob Owner', email: 'bob@example.test', password: 'bob-local-demo-password' },
  { name: 'Rita Reviewer', email: 'rita@example.test', password: 'rita-local-demo-password', reviewer: true },
];
const options = authOptions({ site, origin: process.env.SITE_ORIGIN ?? 'http://localhost:4180', bootstrap: true });
await (await getMigrations(options)).runMigrations();
const auth = betterAuth(options);
const context = await auth.$context;
const app = database(process.env.APP_DATABASE ?? join(data, 'app.db'));
const users = {};
for (const account of accounts) {
  const existing = await context.internalAdapter.findUserByEmail(account.email);
  const id = existing?.user.id ?? (await auth.api.signUpEmail({ body: { name: account.name, email: account.email, password: account.password } })).user.id;
  users[account.email] = id;
  // The review permission is application data, keyed by Better Auth's opaque user id.
  if (account.reviewer) app.prepare('INSERT OR IGNORE INTO reviewers (user_id) VALUES (?)').run(id);
}
console.log(JSON.stringify({ event: 'setup', data, users }));
