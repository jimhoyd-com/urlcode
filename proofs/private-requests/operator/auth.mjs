// Trusted operator configuration for the embedded Better Auth instance. Credentials, the database location and
// every served endpoint are chosen here, outside app/, never in urlcode.yaml.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { clientAddressHeader } from './better-auth-extension.mjs';

export const basePath = '/api/auth';
/**
 * The only Better Auth paths the mount forwards; everything else under it answers 404 before reaching Better
 * Auth. `disabledPaths` below turns the rest off inside Better Auth too, but it matches literal paths only, so
 * parametric routes such as /callback/:id stay routed there. `npm run inventory` shows both layers.
 */
export const enabledPaths = Object.freeze(['/sign-in/email', '/sign-out', '/get-session', '/list-sessions', '/revoke-session', '/revoke-sessions', '/revoke-other-sessions', '/ok']);
/** Every other literal path Better Auth 1.7.6 routes with email and password on and no plugins. */
export const disabledPaths = Object.freeze(['/sign-in/social', '/sign-up/email', '/reset-password', '/verify-password', '/verify-email', '/send-verification-email', '/change-email', '/change-password', '/update-session', '/update-user', '/delete-user', '/request-password-reset', '/link-social', '/list-accounts', '/delete-user/callback', '/unlink-account', '/refresh-token', '/get-access-token', '/account-info', '/error']);

/** The site's data directory: synthetic local SQLite files and the generated secret. */
export function dataDirectory(site) {
  return process.env.PRIVATE_REQUESTS_DATA ?? join(site, 'data');
}

function secret(data) {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  try { return readFileSync(join(data, 'auth-secret'), 'utf8').trim(); }
  catch { throw new Error('No Better Auth secret: run npm run setup, or set BETTER_AUTH_SECRET'); }
}

/**
 * The Better Auth options for this site. `origin` must be the origin URLCode serves (--origin).
 * `bootstrap` is for scripts/setup.mjs alone: it lets the server API create the synthetic accounts.
 */
export function authOptions({ site, origin, bootstrap = false }) {
  const data = dataDirectory(site);
  mkdirSync(data, { recursive: true });
  return {
    appName: 'Private requests',
    baseURL: origin,
    basePath,
    secret: secret(data),
    database: new DatabaseSync(join(data, 'auth.db')),
    emailAndPassword: { enabled: true, disableSignUp: !bootstrap },
    disabledPaths: [...disabledPaths],
    telemetry: { enabled: false },
    // In-memory, per process: this site runs one process. At most 10 sign-in attempts per client address a minute.
    rateLimit: { enabled: true, window: 60, max: 100, customRules: { '/sign-in/email': { window: 60, max: 10 } } },
    advanced: { ipAddress: { ipAddressHeaders: [clientAddressHeader] } },
  };
}

export function createAuth(options) {
  return betterAuth(authOptions(options));
}
