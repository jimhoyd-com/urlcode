// Trusted operator host: keep it outside app/ and review it like any other code you deploy.
// Better Auth and the store's database are configured here by the operator; the application declares only the
// mounts, its collections and the routes it protects.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeHost } from '@jimhoyd/urlcode/host';
import auth from '@jimhoyd/urlcode-auth/extension';
import store from '@jimhoyd/urlcode-store/extension';
import { authFiles, providerOptions } from './operator/auth.mjs';

const { data, database, secretFile } = authFiles(fileURLToPath(new URL('.', import.meta.url)));

export default await composeHost(import.meta.url, [
  auth({ database, secretFile, betterAuth: providerOptions }),
  store({ database: join(data, 'store.sqlite') }),
]);
