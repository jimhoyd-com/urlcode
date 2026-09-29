// The one definition of the auth extension: `urlcode extensions add auth` runs `scaffold` (the mount and a private
// secret), and the site's host.mjs (`composeHost`) runs `host`. The static fields are what `npm run build:addons`
// writes into urlcode.json.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import type { BetterAuthOptions } from 'better-auth';
import { authAuthoring, authConfigSchema, authPolicySchema, createAuthExtension } from './auth.ts';

export const SECRET_FILE = 'data/auth.secret', DATABASE = 'data/auth.sqlite';

/** What the operator may pass as `auth({...})` in host.mjs. Everything is optional. */
export interface AuthHostOptions {
  /** Allow self-service sign-up over HTTP (`POST <mount>/sign-up/email`). Default false. */
  signUp?: boolean;
  /** More Better Auth paths to serve, for example a plugin's. */
  paths?: readonly string[];
  /** Extra Better Auth options, such as plugins. Trusted operator code. */
  betterAuth?: Partial<BetterAuthOptions>;
  /** Default `<site>/data/auth.sqlite`. */
  database?: string;
  /** Default `data/auth.secret`, relative to the site. */
  secretFile?: string;
}

/** Reads the site's Better Auth secret: `BETTER_AUTH_SECRET`, else the secret file. */
export async function readSecret(site: string, file = SECRET_FILE): Promise<string> {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  const path = isAbsolute(file) ? file : join(site, file);
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error(`auth secret ${file} is missing; urlcode extensions add auth writes data/auth.secret, or set BETTER_AUTH_SECRET`, { cause: error });
    throw error;
  }
}

function scaffold(): ScaffoldResult {
  return {
    config: {},
    routes: { '/api/auth/*': { extension: 'auth', methods: ['GET', 'POST'], description: 'Better Auth: sign-in, sign-out and sessions.' } },
    files: [{ path: SECRET_FILE, content: `${randomBytes(32).toString('base64url')}\n`, mode: 0o600 }],
    notes: [
      'Create Better Auth\'s tables, then an account: npx urlcode-auth migrate && echo \'{"email":"you@example.com","password":"...","name":"You"}\' | npx urlcode-auth create-user',
      'Protect a route with `auth: true`; its function reads context.capabilities.auth.identity.userId. Sign in from the browser with better-auth/client (basePath /api/auth).',
      'Keep data/auth.secret and data/auth.sqlite private and backed up; the secret signs every session.',
    ],
  };
}

export default defineExtension<AuthHostOptions>({
  name: 'auth',
  targets: ['node'],
  providesPrincipal: true,
  description: 'Accounts and sessions from Better Auth on one mount; protected routes receive the signed-in user id',
  contract: 1,
  requires: [],
  schema: authConfigSchema,
  policySchema: authPolicySchema,
  authoring: authAuthoring,
  agent: {
    description: 'Local, revision-pinned references for agents protecting routes with the auth extension.',
    references: [
      { name: 'auth extension guide', description: 'Mounting Better Auth, protecting routes with auth: true, reading the user id, the operator CLI and what is not included.', path: 'README.md' },
      { name: 'auth security model', description: 'What Better Auth owns, what the mount and route gate enforce, and the operator responsibilities.', path: 'SECURITY.md' },
    ],
  },
  scaffold,
  async host(context, options) {
    const database = options.database ?? join(context.site, DATABASE);
    await mkdir(dirname(database), { recursive: true, mode: 0o700 });
    const secret = await readSecret(context.site, options.secretFile);
    return { registration: createAuthExtension({ projectSha256: context.projectSha256, database, secret, signUp: options.signUp, paths: options.paths, betterAuth: options.betterAuth }) };
  },
});
