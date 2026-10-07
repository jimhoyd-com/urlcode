#!/usr/bin/env node
// Operator commands for the site's Better Auth instance, run from the site root. They use the same database and
// secret as host.mjs and Better Auth's own server API; nothing here is an account model of its own.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { holdsIllFormedString } from '@jimhoyd/urlcode/body-schema';
import { inspectOperatorHost } from '@jimhoyd/urlcode/host';
import { betterAuthOptions, defaultBasePath, isOwnerDatabase, migrate, refuseRemoteAuthDatabase } from './auth.ts';
import { DATABASE, OPERATOR_SETTINGS, OWNER_DATABASE_MARKER, readSecret } from './extension.ts';
import type { OperatorSettings } from './extension.ts';

const usage = 'Usage: urlcode-auth migrate [--site DIR] [--host-file FILE [--project DIR]]\n       urlcode-auth create-user [--site DIR] [--host-file FILE [--project DIR]]   (reads {"email","password","name"} as JSON on stdin)\n       urlcode-auth find-user --email <email> [--site DIR] [--host-file FILE [--project DIR]]   (prints the user id, e.g. for urlcode-store members add --principal)\n--host-file reads host.mjs\'s auth({...}) options, so migrate also creates the tables its betterAuth.plugins add; --project is the route project it must stay outside (default <site>/app)\n';
/** The value after `flag`, or undefined when the flag is absent or has no value. */
const option = (args: readonly string[], flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };

/** Which database, secret and Better Auth options a command uses: the bundled file's defaults, or host.mjs's. */
interface Target { database: string; secret(): Promise<string>; betterAuth?: Partial<BetterAuthOptions> | undefined }

/** The refusal when the site serves the owner's own database: `which` says how the command knows. */
const ownerRefusal = (command: string, which: string): string => `urlcode-auth ${command} manages only the bundled SQLite file, and ${which}. Migrate it and create accounts with that database's own tooling, such as Better Auth's CLI or its server API.\n`;

/**
 * The settings host.mjs gives the auth extension (#1140), read through core's inspection load: the registration is
 * composed, never activated, and the host is closed before the command touches the database. A plugin is code, so
 * this is the only way the command can see one.
 */
async function hostTarget(hostFile: string, project: string): Promise<OperatorSettings> {
  const host = await inspectOperatorHost(hostFile, project);
  try {
    const registration = host.extensions?.find(extension => extension.name === 'auth');
    if (registration === undefined) throw new Error(`${hostFile} composes no auth extension; add auth() to its composeHost list`);
    const settings = (registration as unknown as Record<symbol, OperatorSettings | undefined>)[OPERATOR_SETTINGS];
    if (settings === undefined) throw new Error(`${hostFile} composes an auth extension that does not share its settings with urlcode-auth; install the same @jimhoyd/urlcode-auth version the site serves`);
    return settings;
  } finally { await host.close?.(); }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const site = resolve(option(rest, '--site') ?? '.');
  if (command !== 'migrate' && command !== 'create-user' && command !== 'find-user') { process.stderr.write(usage); return 2; }
  const hostFile = option(rest, '--host-file');
  if (rest.includes('--host-file') && (hostFile === undefined || hostFile.startsWith('--'))) { process.stderr.write(usage); return 2; }
  if (hostFile === undefined && rest.includes('--project')) { process.stderr.write('--project only names the route project --host-file must stay outside\n'); return 2; }
  let target: Target;
  if (hostFile !== undefined) {
    const settings = await hostTarget(hostFile, resolve(option(rest, '--project') ?? join(site, 'app')));
    // These commands manage only the bundled SQLite file; the owner's database is the owner's tooling's.
    if (isOwnerDatabase(settings.database)) { process.stderr.write(ownerRefusal(command, `${hostFile} gives Better Auth the owner's own database`)); return 2; }
    target = { database: settings.database, secret: async () => settings.secret, betterAuth: settings.betterAuth };
  } else {
    // Without the host file, host.mjs leaves the marker while it gives Better Auth the owner's own database.
    if (existsSync(join(site, OWNER_DATABASE_MARKER))) { process.stderr.write(ownerRefusal(command, `this site's host.mjs gives Better Auth the owner's own database (${OWNER_DATABASE_MARKER})`)); return 2; }
    target = { database: join(site, DATABASE), secret: () => readSecret(site) };
  }
  if (command === 'find-user') return findUser(target, option(rest, '--email'));
  await refuseRemoteAuthDatabase(target.database);
  // The origin only matters to browsers; the server API used here never builds a URL from it. As an operator
  // connection it waits longer for a serving process's commits and polls for the write lock between them.
  const options = betterAuthOptions({ ...target, secret: await target.secret() }, 'http://localhost', defaultBasePath, command === 'create-user', true);
  await migrate(options);
  if (command === 'migrate') { process.stdout.write(JSON.stringify({ event: 'migrated', database: target.database }) + '\n'); return 0; }
  const input = JSON.parse(readFileSync(0, 'utf8')) as { email?: unknown; password?: unknown; name?: unknown };
  if (typeof input.email !== 'string' || typeof input.password !== 'string') { process.stderr.write('create-user reads {"email", "password", "name"} as JSON on stdin\n'); return 2; }
  // Refused as the HTTP sign-up refuses it (#1016): SQLite would store the unpaired surrogate as U+FFFD.
  if (holdsIllFormedString(input)) { process.stderr.write('create-user input holds an unpaired surrogate escape (\\uD800-\\uDFFF)\n'); return 2; }
  const auth = betterAuth(options);
  const created = await auth.api.signUpEmail({ body: { email: input.email, password: input.password, name: typeof input.name === 'string' ? input.name : input.email } });
  process.stdout.write(JSON.stringify({ event: 'user-created', id: created.user.id, email: created.user.email }) + '\n');
  return 0;
}

/**
 * `find-user --email`: the Better Auth user with that email, through Better Auth's own internal adapter (the lookup its
 * sign-in uses, case-insensitive), never raw SQL. Read-only: it neither migrates nor creates the database.
 */
async function findUser(target: Target, email: string | undefined): Promise<number> {
  if (email === undefined || email.startsWith('--') || !email.includes('@')) { process.stderr.write('find-user needs --email <email>\n'); return 2; }
  const { database } = target;
  if (!existsSync(database)) { process.stderr.write(`No auth database at ${database}; run urlcode-auth migrate in the site first\n`); return 1; }
  await refuseRemoteAuthDatabase(database);
  const options = betterAuthOptions({ ...target, secret: await target.secret() }, 'http://localhost', defaultBasePath, false, true);
  const context = await betterAuth(options).$context;
  const found = await context.internalAdapter.findUserByEmail(email);
  if (!found) { process.stdout.write(JSON.stringify({ event: 'user-not-found', email }) + '\n'); return 1; }
  const { user } = found;
  process.stdout.write(JSON.stringify({ event: 'user-found', id: user.id, email: user.email, name: user.name, createdAt: new Date(user.createdAt).toISOString() }) + '\n');
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
