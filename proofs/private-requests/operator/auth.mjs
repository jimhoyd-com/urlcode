// Trusted operator choices for this site's Better Auth instance, outside app/ and never in urlcode.yaml. The
// secret file, database, sign-in allowlist, rate limits and client-address header are @jimhoyd/urlcode-auth's
// defaults; only what this proof decides differently is here.
import { join } from 'node:path';

/** The site's data directory. `PRIVATE_REQUESTS_DATA` keeps fixture runs apart from the data the site serves. */
export function dataDirectory(site) {
  return process.env.PRIVATE_REQUESTS_DATA ?? join(site, 'data');
}

/** Better Auth's database and secret: the package's own file names, inside the data directory. */
export function authFiles(site) {
  const data = dataDirectory(site);
  return { data, database: join(data, 'auth.sqlite'), secretFile: join(data, 'auth.secret') };
}

/**
 * Every other literal path Better Auth 1.7.6 routes with email and password on and no plugins. The mount already
 * answers 404 for anything outside the package's allowlist; this turns the same paths off inside Better Auth too.
 * It matches literal paths only, so parametric routes such as /callback/:id stay routed there. `npm run inventory`
 * shows both layers.
 */
export const disabledPaths = Object.freeze(['/sign-in/social', '/sign-up/email', '/reset-password', '/verify-password', '/verify-email', '/send-verification-email', '/change-email', '/update-session', '/update-user', '/delete-user', '/request-password-reset', '/link-social', '/list-accounts', '/delete-user/callback', '/unlink-account', '/refresh-token', '/get-access-token', '/account-info', '/error']);

/** Extra Better Auth options, passed as `auth({betterAuth})` in host.mjs. */
export const providerOptions = Object.freeze({ appName: 'Private requests', disabledPaths: [...disabledPaths] });
