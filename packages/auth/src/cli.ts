#!/usr/bin/env node
// Operator commands for the site's Better Auth instance, run from the site root. They use the same database and
// secret as host.mjs and Better Auth's own server API; nothing here is an account model of its own.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { betterAuth } from 'better-auth';
import { betterAuthOptions, defaultBasePath, migrate } from './auth.ts';
import { DATABASE, readSecret } from './extension.ts';

const usage = 'Usage: urlcode-auth migrate [--site DIR]\n       urlcode-auth create-user [--site DIR]   (reads {"email","password","name"} as JSON on stdin)\n';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const siteIndex = rest.indexOf('--site');
  const site = resolve(siteIndex >= 0 ? rest[siteIndex + 1] ?? '.' : '.');
  if (command !== 'migrate' && command !== 'create-user') { process.stderr.write(usage); return 2; }
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

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, (error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
