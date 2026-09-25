// createAbuse: the counter store, the namespaced budget/backoff handles and the registration, built from explicit
// options. extension.ts builds these options from host.mjs and the site's data/abuse.key.
import type { ExtensionAuthoringContract, ExtensionInstance, HandlerResult, RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { AbuseError } from './types.ts';
import type { AbuseAdmission, AbuseAdmitEntry, AbuseBackoff, AbuseBackoffSpec, AbuseBudget, AbuseBudgetSpec, AbuseChallenge, AbuseExports, AbuseInstance, AbuseNamespace, AbuseOptions } from './types.ts';
import { normalizeBackoff, normalizeBudget, validValue } from './budget.ts';
import { counterKey, SCOPE } from './keys.ts';
import { openCounterStore } from './store.ts';
import { createChallenge } from './challenge.ts';
import { honeypot } from './honeypot.ts';

export const DEFAULT_MAX_KEYS = 100000;
export const abuseConfigSchema = {
  type: 'object', additionalProperties: false,
  properties: { maxKeys: { type: 'integer', minimum: 1000, maximum: 1000000 } },
} as const;
export const abuseAuthoring: ExtensionAuthoringContract = {
  description: 'Persistent, pseudonymous counters other extensions call: request budgets, failure backoff and challenge escalation. It has no routes and no route policy; use policies.throttle for a declarative per-route budget.',
  surfaces: [
    { kind: 'configuration', name: 'maxKeys', description: 'Hard bound on stored counters (1000..1000000, default 100000); a full table answers 503.', path: 'urlcode.yaml#extensions.abuse.config.maxKeys' },
  ],
  fastChecks: ['urlcode validate --project . --host-file <host.mjs> --origin <origin>'],
};

const notFound: HandlerResult = { status: 404, headers: [['content-type', 'text/plain; charset=utf-8']], body: 'Not found' };
const unavailable = (error: unknown): never => { throw error instanceof AbuseError && error.code !== 'invalid_abuse_spec' ? error : new AbuseError(503, 'abuse_unavailable'); };

export async function createAbuse(options: AbuseOptions): Promise<AbuseInstance> {
  if (typeof options.projectSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.projectSha256)) throw new Error('abuse extension requires an explicit operator revision pin');
  if (!(options.key instanceof Uint8Array) || options.key.byteLength !== 32) throw new Error('abuse needs a 32-byte key');
  if (options.maxKeys !== undefined && !(Number.isSafeInteger(options.maxKeys) && options.maxKeys >= 1)) throw new Error('abuse maxKeys must be a positive integer');
  const challenge: AbuseChallenge | undefined = options.challenge ? createChallenge(options.challenge) : undefined;
  const key = Uint8Array.from(options.key), now = options.now ?? Date.now;
  const store = await openCounterStore(options.database);
  let active = false, maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  /** `<namespace>\0<scope>` → kind: one scope is one kind of counter, or two kinds would share keys. */
  const scopes = new Map<string, 'budget' | 'backoff'>();
  const claim = (namespace: string, scope: string, kind: 'budget' | 'backoff') => {
    const id = namespace + '\0' + scope, held = scopes.get(id);
    if (held && held !== kind) throw new AbuseError(400, 'invalid_abuse_spec');
    scopes.set(id, kind);
  };
  const budgets = new WeakMap<AbuseBudget, string>();

  function namespace(name: string): AbuseNamespace {
    if (typeof name !== 'string' || !SCOPE.test(name)) throw new AbuseError(400, 'invalid_abuse_spec');
    if (!active) throw new AbuseError(503, 'abuse_inactive');
    const keyOf = (scope: string, value: string) => counterKey(key, name, scope, value);
    return Object.freeze({
      name,
      budget(spec: AbuseBudgetSpec): AbuseBudget {
        const normal = normalizeBudget(spec);
        claim(name, normal.scope, 'budget');
        const budget: AbuseBudget = Object.freeze({ namespace: name, ...normal });
        budgets.set(budget, name);
        return budget;
      },
      backoff(spec: AbuseBackoffSpec): AbuseBackoff {
        const normal = normalizeBackoff(spec);
        claim(name, normal.scope, 'backoff');
        const valueKey = (value: string) => { if (!validValue(value)) throw new AbuseError(400, 'invalid_abuse_spec'); return keyOf(normal.scope, value); };
        return Object.freeze({
          ...normal,
          async check(value: string) { const id = valueKey(value); try { return Object.freeze(store.check(id, now())); } catch (error) { return unavailable(error); } },
          async failure(value: string) { const id = valueKey(value); try { store.failure(id, normal, now(), maxKeys); } catch (error) { unavailable(error); } },
          async clear(value: string) { const id = valueKey(value); try { store.clear(id); } catch (error) { unavailable(error); } },
        });
      },
      async admit(entries: readonly AbuseAdmitEntry[]): Promise<AbuseAdmission> {
        if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) throw new AbuseError(400, 'invalid_abuse_spec');
        const items = entries.map(entry => {
          if (!entry || budgets.get(entry.budget) !== name || !validValue(entry.value)) throw new AbuseError(400, 'invalid_abuse_spec');
          const { scope, limit, windowMs, challengeAfter } = entry.budget;
          return { key: keyOf(scope, entry.value), limit, windowMs, challengeAfter };
        });
        if (new Set(items.map(item => item.key)).size !== items.length) throw new AbuseError(400, 'invalid_abuse_spec');
        try { return Object.freeze(store.admit(items, now(), maxKeys)); } catch (error) { return unavailable(error); }
      },
    });
  }

  const exports: AbuseExports = Object.freeze({
    version: 1 as const,
    get active() { return active; },
    namespace,
    challenge,
    honeypot,
  });
  const registration: RuntimeExtension = {
    name: 'abuse', version: '1', projectSha256: options.projectSha256, targets: ['node'],
    schema: abuseConfigSchema, authoring: abuseAuthoring,
    activate(raw, context): ExtensionInstance {
      if (context.mounts.length) throw new Error(`abuse serves no routes; remove extension: abuse from ${context.mounts.join(', ')}`);
      if (store.closed) throw new Error('abuse was closed before activation');
      const config = raw as { maxKeys?: number };
      maxKeys = config.maxKeys ?? DEFAULT_MAX_KEYS;
      active = true;
      return { handle: () => notFound };
    },
  };
  return {
    registration,
    exports,
    async close() { active = false; store.close(); key.fill(0); },
  };
}
