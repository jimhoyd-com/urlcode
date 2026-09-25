// The one definition of the abuse extension: `urlcode extensions add abuse` runs `scaffold` (the config and the
// private key), and the site's host.mjs (`composeHost`) runs `host`. The static fields are what
// `npm run build:addons` writes into urlcode.json.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { defineExtension } from '@jimhoyd/urlcode/extensions';
import type { ScaffoldResult } from '@jimhoyd/urlcode/extensions';
import { abuseAuthoring, abuseConfigSchema, createAbuse, DEFAULT_MAX_KEYS } from './abuse.ts';
import type { AbuseChallengeProvider } from './types.ts';

const KEY_FILE = 'data/abuse.key', DATABASE = 'data/abuse.sqlite';

/** What the operator may pass as `abuse({...})` in host.mjs. Everything is optional. */
export interface AbuseHostOptions {
  /** Default `<site>/data/abuse.sqlite`. */
  database?: string;
  /** Exactly 32 bytes; default the bytes of `keyFile`. */
  key?: Uint8Array;
  /** Default `data/abuse.key`, relative to the site. */
  keyFile?: string;
  /** The challenge verifier, for example `createTurnstileChallenge({secret: process.env.TURNSTILE_SECRET, ...})`. */
  challenge?: AbuseChallengeProvider;
  /** Tests only. */
  now?: () => number;
}

function scaffold(): ScaffoldResult {
  return {
    config: { maxKeys: DEFAULT_MAX_KEYS },
    routes: {},
    files: [{ path: KEY_FILE, content: randomBytes(32), mode: 0o600 }],
    env: { TURNSTILE_SECRET: 'Optional: pass abuse({challenge: createTurnstileChallenge({...})}) in host.mjs' },
    notes: [
      'abuse does nothing until an extension declares budgets (extensions.auth.config.abuse, a forms flow\'s abuse).',
      'The challenge verifier is host.mjs code, never YAML. Use policies.throttle for a plain per-route request budget.',
      'Keep data/abuse.key private; losing it only resets the counters.',
    ],
  };
}

export default defineExtension<AbuseHostOptions>({
  name: 'abuse',
  description: 'Persistent, pseudonymous rate limits, failure backoff and challenge escalation for extensions',
  requires: [],
  schema: abuseConfigSchema,
  authoring: abuseAuthoring,
  scaffold,
  async host(context, options) {
    let key: Uint8Array;
    if (options.key) key = options.key;
    else {
      const file = options.keyFile ?? KEY_FILE, path = isAbsolute(file) ? file : join(context.site, file);
      try { key = await readFile(path); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new Error(`abuse key ${file} is missing; urlcode extensions add abuse writes data/abuse.key`, { cause: error });
        throw error;
      }
      if (key.byteLength !== 32) { key.fill(0); throw new Error(`abuse key ${file} must hold exactly 32 bytes; urlcode extensions add abuse writes data/abuse.key`); }
    }
    const database = options.database ?? join(context.site, DATABASE);
    await mkdir(dirname(database), { recursive: true, mode: 0o700 });
    const abuse = await createAbuse({ projectSha256: context.projectSha256, database, key, ...(options.challenge ? { challenge: options.challenge } : {}), ...(options.now ? { now: options.now } : {}) });
    if (!options.key) key.fill(0);
    return { registration: abuse.registration, exports: abuse.exports, close: () => abuse.close() };
  },
});
