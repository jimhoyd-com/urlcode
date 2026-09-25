// Pseudonymous counter keys. HMAC with the site's data/abuse.key, not a plain hash: emails and IPv4 addresses are
// low-entropy, so a copied abuse.sqlite must not be reversible by dictionary. A raw value is never stored, returned
// or logged.
import { createHmac } from 'node:crypto';

/** Namespace and scope names: they double as challenge actions, so at most 32 characters. */
export const SCOPE = /^[a-z][a-z0-9-]{0,31}$/;
export function counterKey(key: Uint8Array, namespace: string, scope: string, value: string): string {
  return createHmac('sha256', key).update('urlcode-abuse:v1\0' + namespace + '\0' + scope + '\0' + value).digest('hex');
}
