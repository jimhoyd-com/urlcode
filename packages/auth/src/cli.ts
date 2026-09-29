#!/usr/bin/env node
// Operator commands for the site's Better Auth instance, run from the site root. They use the same database and
// secret as host.mjs and Better Auth's own server API; nothing here is an account model of its own.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { betterAuth } from 'better-auth';
import { betterAuthOptions, defaultBasePath, migrate, refuseRemoteAuthDatabase } from './auth.ts';
import { DATABASE, readSecret } from './extension.ts';

const usage = 'Usage: urlcode-auth migrate [--site DIR]\n       urlcode-auth create-user [--site DIR]   (reads {"email","password","name"} as JSON on stdin)\n       urlcode-auth find-user --email <email> [--site DIR]   (prints the user id, e.g. for urlcode-store members add --principal)\n';
/** The value after `flag`, or undefined when the flag is absent or has no value. */
const option = (args: readonly string[], flag: string): string | undefined => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const site = resolve(option(rest, '--site') ?? '.');
  if (command !== 'migrate' && command !== 'create-user' && command !== 'find-user') { process.stderr.write(usage); return 2; }
  if (command === 'find-user') return findUser(site, option(rest, '--email'));
  await refuseRemoteAuthDatabase(join(site, DATABASE));
  // The origin only matters to browsers; the server API used here never builds a URL from it.
  const options = betterAuthOptions({ database: join(site, DATABASE), secret: await readSecret(site) }, 'http://localhost', defaultBasePath, command === 'create-user');
  await migrate(options);
  if (command === 'migrate') { process.stdout.write(JSON.stringify({ event: 'migrated', database: join(site, DATABASE) }) + '\n'); return 0; }
  const input = JSON.parse(readFileSync(0, 'utf8')) as { email?: unknown; password?: unknown; name?: unknown };
  if (typeof input.email !== 'string' || typeof input.password !== 'string') { process.stderr.write('create-user reads {"email", "password", "name"} as JSON on stdin\n'); return 2; }
  const auth = betterAuth(options);
  const created = await auth.api.signUpEmail({ body: { email: input.email, password: input.password, name: typeof input.name === 'string' ? input.name : input.email } });
  process.stdout.write(JSON.stringify({ event: 'user-created', id: created.user.id, email: created.user.email }) + '\n');
  return 0;
}

/**
 * `find-user --email`: the Better Auth user with that email, through Better Auth's own internal adapter (the lookup its
 * sign-in uses, case-insensitive), never raw SQL. Read-only: it neither migrates nor creates the database.
 */
async function findUser(site: string, email: string | undefined): Promise<number> {
  if (email === undefined || email.startsWith('--') || !email.includes('@')) { process.stderr.write('find-user needs --email <email>\n'); return 2; }
  const database = join(site, DATABASE);
  if (!existsSync(database)) { process.stderr.write(`No auth database at ${database}; run urlcode-auth migrate in the site first\n`); return 1; }
  await refuseRemoteAuthDatabase(database);
  const options = betterAuthOptions({ database, secret: await readSecret(site) }, 'http://localhost', defaultBasePath, false);
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
