// Trusted operator host: keep it outside app/ and review it like any other code you deploy.
// Better Auth is configured here by the operator; the application declares only the mount and the routes it protects.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeHost } from '@jimhoyd/urlcode/host';
import auth from '@jimhoyd/urlcode-auth/extension';
import { authFiles, providerOptions } from './operator/auth.mjs';

const { data, database, secretFile } = authFiles(fileURLToPath(new URL('.', import.meta.url)));
// The application database the routes' APP_DATABASE binding names; operator/policy.json must still grant it.
process.env.APP_DATABASE ??= join(data, 'app.db');

export default await composeHost(import.meta.url, [
  auth({ database, secretFile, betterAuth: providerOptions }),
]);
