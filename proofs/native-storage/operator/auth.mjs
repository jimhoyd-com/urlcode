// Trusted operator choices for this site's Auth.js instance, outside app/ and never in urlcode.yaml: Auth.js's own
// configuration object, passed to the extension unchanged. basePath, secret and trustHost are set by the extension
// from the declared mount and --origin. The same choices as proofs/private-requests-authjs/operator/auth.mjs.
import { join } from 'node:path';
import Credentials from '@auth/core/providers/credentials';
import { verifyPassword } from './users.mjs';

/** The operator's private files. `NATIVE_STORAGE_DATA` keeps fixture runs apart from the files the site serves with. */
export function siteFiles(site) {
  const data = process.env.NATIVE_STORAGE_DATA ?? join(site, 'data');
  return { data, secretFile: join(data, 'authjs.secret'), usersFile: join(data, 'users.json') };
}

/** Credentials sign-in with JWT sessions (Auth.js refuses a database strategy for it), valid for one hour. */
export function authjsOptions(usersFile) {
  return {
    providers: [Credentials({
      credentials: { email: { type: 'email' }, password: { type: 'password' } },
      authorize: credentials => verifyPassword(usersFile, credentials.email, credentials.password),
    })],
    session: { strategy: 'jwt', maxAge: 60 * 60 },
  };
}
