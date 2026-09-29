// Trusted operator host: keep it outside app/ and review it like any other code you deploy.
// Auth.js and the store's database are configured here by the operator; the application declares only the mounts,
// its collections and the routes it protects. The provider is an independent package, @example/urlcode-authjs.
import { fileURLToPath } from 'node:url';
import { composeHost } from '@jimhoyd/urlcode/host';
import authjs from '@example/urlcode-authjs/extension';
import store from '@jimhoyd/urlcode-store/extension';
import { authjsOptions, siteFiles } from './operator/auth.mjs';

const { secretFile, usersFile, storeDatabase } = siteFiles(fileURLToPath(new URL('.', import.meta.url)));

export default await composeHost(import.meta.url, [
  authjs({ secretFile, authjs: authjsOptions(usersFile) }),
  store({ database: storeDatabase }),
]);
