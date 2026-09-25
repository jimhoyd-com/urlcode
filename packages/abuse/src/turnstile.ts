// Cloudflare Turnstile as an AbuseChallengeProvider, for host.mjs: abuse({challenge: createTurnstileChallenge({...})}).
// A fixed upstream only. Siteverify tokens are single-use; a verdict is never cached. The action is the caller's
// namespace (auth, forms), checked against the verdict.
import { isIP } from 'node:net';
import type { AbuseChallengeProvider, AbuseChallengeWidget } from './types.ts';
import { SCOPE } from './keys.ts';

export interface TurnstileChallengeOptions { secret: string; siteKey: string; hostname: string; fetch?: typeof fetch; timeoutMs?: number }
export const turnstileOrigin = 'https://challenges.cloudflare.com';
export const turnstileScript = turnstileOrigin + '/turnstile/v0/api.js';
const siteverify = turnstileOrigin + '/turnstile/v0/siteverify';

export function createTurnstileChallenge(options: TurnstileChallengeOptions): AbuseChallengeProvider {
  const key = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{10,256}$/.test(value);
  let hostname: string;
  try { hostname = new URL('https://' + options.hostname).hostname; } catch { throw new Error('Invalid Turnstile hostname'); }
  const timeout = options.timeoutMs ?? 5000;
  if (!key(options.secret) || !key(options.siteKey) || hostname !== options.hostname || !hostname || /[/:@?#]/.test(hostname) || !Number.isInteger(timeout) || timeout < 10 || timeout > 5000) throw new Error('Invalid Turnstile configuration');
  const csp = Object.freeze({ script: Object.freeze([turnstileOrigin]), frame: Object.freeze([turnstileOrigin]), connect: Object.freeze([turnstileOrigin]) });
  const scripts = Object.freeze([Object.freeze({ src: turnstileScript, async: true })]);
  let active = 0;
  return Object.freeze({
    widget(action: string): AbuseChallengeWidget {
      if (typeof action !== 'string' || !SCOPE.test(action)) throw new Error('Invalid challenge action');
      return Object.freeze({ markup: `<div class="cf-turnstile" data-sitekey="${options.siteKey}" data-action="${action}" data-response-field-name="challengeToken"></div>`, csp, scripts });
    },
    async verify(input: { token: string; client: string; action: string; signal: AbortSignal }): Promise<boolean> {
      if (input.signal.aborted || !isIP(input.client) || typeof input.action !== 'string' || !SCOPE.test(input.action) || typeof input.token !== 'string' || input.token.length < 1 || input.token.length > 2048 || /[\x00-\x20\x7f]/.test(input.token) || active >= 32) return false;
      active++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending = (async () => {
        const response = await (options.fetch ?? fetch)(siteverify, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ secret: options.secret, response: input.token, remoteip: input.client }), signal: AbortSignal.any([input.signal, controller.signal]) });
        if (response.status !== 200 || Number(response.headers.get('content-length') || 0) > 8192) { await response.body?.cancel(); return false; }
        const reader = response.body?.getReader();
        if (!reader) return false;
        const chunks: Uint8Array[] = [];
        let size = 0;
        try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 8192) return false; chunks.push(item.value); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as Record<string, unknown>;
        const timestamp = typeof value.challenge_ts === 'string' ? Date.parse(value.challenge_ts) : NaN;
        return value.success === true && value.hostname === hostname && value.action === input.action && Number.isFinite(timestamp) && timestamp <= Date.now() + 60000 && timestamp >= Date.now() - 300000;
      })();
      // A verifier that ignores cancellation retains its slot instead of allowing unbounded work.
      void pending.finally(() => { active--; }).catch(() => {});
      try { return await Promise.race([pending, new Promise<boolean>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, timeout); })]); }
      catch { return false; }
      finally { if (timer) clearTimeout(timer); }
    },
  });
}
