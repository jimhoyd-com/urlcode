// Trusted operator choices for this site's Auth.js instance, outside app/ and never in urlcode.yaml. This is Auth.js's
// own configuration object, passed to the extension unchanged: the Credentials provider, the session strategy and
// its lifetime. basePath, secret and trustHost are set by the extension from the declared mount and --origin.
import { join } from 'node:path';
import Credentials from '@auth/core/providers/credentials';
import { verifyPassword } from './users.mjs';

/** The site's data directory. `PRIVATE_REQUESTS_DATA` keeps fixture runs apart from the data the site serves. */
export function dataDirectory(site) {
  return process.env.PRIVATE_REQUESTS_DATA ?? join(site, 'data');
}

/** The operator's private files: the Auth.js secret, the account file and the store's database. */
export function siteFiles(site) {
  const data = dataDirectory(site);
  return { data, secretFile: join(data, 'authjs.secret'), usersFile: join(data, 'users.json'), storeDatabase: join(data, 'store.sqlite') };
}

/**
 * Auth.js options for this site. Credentials sign-in works only with JWT sessions in Auth.js (a database strategy
 * refuses it), so a session is an encrypted cookie Auth.js cannot revoke server-side: signing out clears the
 * browser's copy only. The one-hour lifetime bounds how long a copied cookie stays valid.
 */
export function authjsOptions(usersFile) {
  return {
    providers: [Credentials({
      credentials: { email: { type: 'email' }, password: { type: 'password' } },
      authorize: credentials => verifyPassword(usersFile, credentials.email, credentials.password),
    })],
    session: { strategy: 'jwt', maxAge: 60 * 60 },
  };
}
