// The one definition of the auth extension: `urlcode extensions add auth` runs `scaffold` (the mount and a private
// secret), and the site's host.mjs (`composeHost`) runs `host`. The static fields are what `npm run build:addons`
// writes into urlcode.json.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import type { BetterAuthOptions } from 'better-auth';
import { authAuthoring, authConfigSchema, authOpenApiSecurity, authPolicySchema, createAuthExtension, isOwnerDatabase } from './auth.ts';
import type { OwnerDatabase } from './auth.ts';

export const SECRET_FILE = 'data/auth.secret', DATABASE = 'data/auth.sqlite';
/**
 * Written in the site's data directory while host.mjs gives Better Auth the owner's own database, and removed when it
 * goes back to the bundled file: `urlcode-auth` reads it to refuse commands that manage only the bundled file.
 */
export const OWNER_DATABASE_MARKER = 'data/auth.owner-database';

/** What the operator may pass as `auth({...})` in host.mjs. Everything is optional. */
export interface AuthHostOptions {
  /** Allow self-service sign-up over HTTP (`POST <mount>/sign-up/email`). Default false. */
  signUp?: boolean;
  /** More Better Auth paths to serve, for example a plugin's. */
  paths?: readonly string[];
  /** Extra Better Auth options, such as plugins or `emailAndPassword: {enabled: false}`. Trusted operator code. */
  betterAuth?: Partial<BetterAuthOptions>;
  /**
   * The bundled SQLite file's path (default `<site>/data/auth.sqlite`), or the owner's own Better Auth database: any
   * value Better Auth's `database` option accepts, such as an adapter or a pool. A hermetic run uses neither: a fresh
   * SQLite file, or `testDatabase` for an owner database (RIM-EXT-HERMETIC-001).
   */
  database?: string | OwnerDatabase;
  /**
   * With an owner database, what a hermetic run (test, audit, a local review) serves instead: called once per run with
   * the run's temporary data directory, it returns a fresh Better Auth database that already holds Better Auth's schema
   * and no live data. Without it, a hermetic run with an owner database is refused.
   */
  testDatabase?: (context: { data: string }) => OwnerDatabase | Promise<OwnerDatabase>;
  /** Default `data/auth.secret`, relative to the site. Ignored by a hermetic run, which signs with a secret of its own. */
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
      'Before serving, create Better Auth\'s tables, then an account (npm run validate, test and audit need neither: they run on throwaway data): npx urlcode-auth migrate && echo \'{"email":"you@example.com","password":"...","name":"You"}\' | npx urlcode-auth create-user',
      'Protect a route with `auth: true`; its function reads context.capabilities.auth.identity.userId. Sign in from the browser with better-auth/client (basePath /api/auth).',
      'Keep data/auth.secret and data/auth.sqlite private and backed up; the secret signs every session.',
    ],
  };
}

export default defineExtension<AuthHostOptions>({
  name: 'auth',
  targets: ['node'],
  providesPrincipal: true,
  openapiSecurity: authOpenApiSecurity,
  description: 'Accounts and sessions from Better Auth on one mount; protected routes receive the signed-in user id',
  contract: 2,
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
    if (options.testDatabase !== undefined && typeof options.testDatabase !== 'function') throw new Error('auth: testDatabase is a function returning a fresh Better Auth database for each hermetic run');
    const owner = options.database !== undefined && isOwnerDatabase(options.database) ? options.database : undefined;
    const common = { projectSha256: context.projectSha256, signUp: options.signUp, paths: options.paths, betterAuth: options.betterAuth };
    // A hermetic run (test, audit) never touches the site's accounts: a fresh database in the run's data
    // directory, or the owner's isolated one (the registration refuses without it and never serves `owner`), and a
    // signing secret that lives only as long as this host, whatever the operator's options name.
    if (context.hermetic) {
      if (owner === undefined) await mkdir(context.data, { recursive: true, mode: 0o700 });
      const testDatabase = owner !== undefined && options.testDatabase ? await options.testDatabase({ data: context.data }) : undefined;
      return { registration: createAuthExtension({ ...common, database: owner ?? join(context.data, 'auth.sqlite'), testDatabase, secret: randomBytes(32).toString('base64url'), hermetic: true }) };
    }
    if (owner === undefined && options.testDatabase !== undefined) throw new Error('auth: testDatabase is only for an owner database (auth({database: <a Better Auth database>})); a hermetic run already gives the bundled SQLite file a fresh one');
    const database = owner ?? (typeof options.database === 'string' ? options.database : join(context.data, 'auth.sqlite'));
    // The CLI cannot read host.mjs, so the choice is left where it looks: present only while an owner database serves.
    const marker = join(context.data, 'auth.owner-database');
    await mkdir(owner === undefined ? dirname(database as string) : context.data, { recursive: true, mode: 0o700 });
    if (owner === undefined) await rm(marker, { force: true });
    else await writeFile(marker, 'host.mjs gives Better Auth the owner\'s own database; urlcode-auth migrate, create-user and find-user manage only the bundled SQLite file\n', { mode: 0o600 });
    const secret = await readSecret(context.site, options.secretFile);
    return { registration: createAuthExtension({ ...common, database, secret, hermetic: false }) };
  },
});
