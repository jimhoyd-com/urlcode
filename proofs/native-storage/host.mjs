// Trusted operator host: keep it outside app/ and review it like any other code you deploy. It composes one
// extension, the independent Auth.js provider, for `auth: true`. There is no store and no audit extension: the
// application keeps its own data with node:sqlite in app/functions/notes.mjs, in the directory the operator grants
// as URLCODE_DATA_DIR.
import { fileURLToPath } from 'node:url';
import { composeHost } from '@jimhoyd/urlcode/host';
import authjs from '@example/urlcode-authjs/extension';
import { authjsOptions, siteFiles } from './operator/auth.mjs';

const { secretFile, usersFile } = siteFiles(fileURLToPath(new URL('.', import.meta.url)));

export default await composeHost(import.meta.url, [authjs({ secretFile, authjs: authjsOptions(usersFile) })]);
