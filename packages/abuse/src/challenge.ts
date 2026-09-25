// The bounds abuse puts around an operator's challenge provider, whatever it is: a checked token shape, an IP client,
// at most 32 verifications in flight, a 5 s deadline with abort, no cached verdicts, and a widget whose every script
// and frame origin is a declared https origin.
import { isIP } from 'node:net';
import type { AbuseChallenge, AbuseChallengeProvider, AbuseChallengeWidget } from './types.ts';
import { SCOPE } from './keys.ts';

export interface ChallengeBounds { timeoutMs?: number; maxInFlight?: number }
const MAX_MARKUP = 2048, MAX_LIST = 8;

function httpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
}
function origins(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST || !value.every(httpsOrigin)) throw new Error(`Challenge widget csp.${name} must list at most ${MAX_LIST} https origins`);
  return Object.freeze([...value]);
}
/** Validates and deep-copies a provider's widget, so the page gets exactly what was checked. */
export function validateWidget(value: unknown): AbuseChallengeWidget {
  if (!value || typeof value !== 'object') throw new Error('Challenge widget must be an object');
  const { markup, csp, scripts } = value as Record<string, unknown>;
  if (typeof markup !== 'string' || Buffer.byteLength(markup) > MAX_MARKUP) throw new Error(`Challenge widget markup must be a string of at most ${MAX_MARKUP} bytes`);
  if (!csp || typeof csp !== 'object') throw new Error('Challenge widget csp must be an object');
  const policy = csp as Record<string, unknown>;
  const checked = Object.freeze({ script: origins(policy.script, 'script'), frame: origins(policy.frame, 'frame'), connect: origins(policy.connect, 'connect') });
  if (!Array.isArray(scripts) || scripts.length > MAX_LIST) throw new Error(`Challenge widget scripts must list at most ${MAX_LIST} scripts`);
  const copied = scripts.map(script => {
    const { src, async } = (script ?? {}) as Record<string, unknown>;
    let origin: string | undefined;
    try { const url = new URL(String(src)); if (url.protocol === 'https:' && url.href === src) origin = url.origin; } catch { /* refused below */ }
    if (typeof src !== 'string' || origin === undefined || !checked.script.includes(origin) || typeof async !== 'boolean') throw new Error('Challenge widget script must be an https URL whose origin is listed in csp.script');
    return Object.freeze({ src, async });
  });
  return Object.freeze({ markup, csp: checked, scripts: Object.freeze(copied) });
}

export function createChallenge(provider: AbuseChallengeProvider, bounds: ChallengeBounds = {}): AbuseChallenge {
  if (!provider || typeof provider.widget !== 'function' || typeof provider.verify !== 'function') throw new Error('abuse({challenge}) needs a provider with widget() and verify()');
  const timeoutMs = bounds.timeoutMs ?? 5000, maxInFlight = bounds.maxInFlight ?? 32;
  let active = 0;
  return Object.freeze({
    widget(action: string): AbuseChallengeWidget {
      if (typeof action !== 'string' || !SCOPE.test(action)) throw new Error('Invalid challenge action');
      return validateWidget(provider.widget(action));
    },
    async verify(input: { token: unknown; client: string | null; action: string }): Promise<boolean> {
      const { token, client, action } = input ?? {};
      if (typeof token !== 'string' || token.length < 1 || token.length > 2048 || /[\x00-\x1f\x7f]/.test(token)) return false;
      if (typeof client !== 'string' || !isIP(client) || typeof action !== 'string' || !SCOPE.test(action) || active >= maxInFlight) return false;
      active++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = Promise.resolve().then(() => provider.verify({ token, client, action, signal: controller.signal }));
      // A provider that ignores the abort keeps its slot until it settles, so work stays bounded.
      void pending.finally(() => { active--; }).catch(() => {});
      try { return (await Promise.race([pending, new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })])) === true; }
      catch { return false; }
      finally { if (timer) clearTimeout(timer); controller.abort(); }
    },
  });
}
