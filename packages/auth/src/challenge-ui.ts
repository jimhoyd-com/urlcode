export interface TurnstileWidget { siteKey: string; action: 'auth'; }
export const turnstileOrigin = 'https://challenges.cloudflare.com';
export const turnstileScript = turnstileOrigin + '/turnstile/v0/api.js';
/** Only typed operator configuration can add this fixed third-party widget to trusted package forms. */
export function addTurnstileWidgets(markup: string, widget?: TurnstileWidget): { markup: string; enabled: boolean } {
    if (!widget) return { markup, enabled: false };
    if (typeof widget.siteKey !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(widget.siteKey) || widget.action !== 'auth' || Object.keys(widget).some(key => !['siteKey','action'].includes(key))) throw new Error('Invalid challenge widget');
    let count = 0;
    const result = markup.replace(/<form\b([^>]*)>/gi, (tag, attributes: string) => {
        if (!/(?:^|\s)method=(?:"post"|'post')(?=\s|$)/i.test(attributes)) return tag;
        if (++count > 16) throw new Error('Too many challenge forms');
        return tag + `<div class="cf-turnstile" data-sitekey="${widget.siteKey}" data-action="auth" data-response-field-name="challengeToken"></div>`;
    });
    return { markup: result, enabled: count > 0 };
}
