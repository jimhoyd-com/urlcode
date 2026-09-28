// Trusted operator host: keep it outside app/ and review it like any other code you deploy.
// Better Auth is built here from operator configuration; the application declares only the mount and the routes it protects.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeHost } from '@jimhoyd/urlcode/host';
import { createAuth, dataDirectory, enabledPaths } from './operator/auth.mjs';
import betterAuth from '@example/urlcode-better-auth/extension';

const site = fileURLToPath(new URL('.', import.meta.url));
// Must equal the --origin the CLI is given; the adapter refuses to activate otherwise.
const origin = process.env.SITE_ORIGIN ?? 'http://localhost:4180';
// The application database the routes' APP_DATABASE binding names; operator/policy.json must still grant it.
process.env.APP_DATABASE ??= join(dataDirectory(site), 'app.db');

export default await composeHost(import.meta.url, [
  betterAuth({ auth: createAuth({ site, origin }), paths: enabledPaths }),
]);
