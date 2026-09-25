// A support (impersonation) session is visible on every page it can reach. Auth's middleware() wraps every route an
// auth session policy guards: when the request's session is a support session, it drops the request's validators and
// ranges, makes the response uncacheable, marks it `x-urlcode-support-session: active` and puts a banner at the top of
// an HTML body (at most 1 MiB, identity-encoded); an HTML answer it cannot rewrite safely becomes a 409 page instead.
// Auth's own pages show the same notice through the kit's flash. A route without an auth policy never resolves the
// session, so it cannot show a support session anything account-specific.
import { escapeHtml } from '@jimhoyd/urlcode-ui';
import type { ExtensionRequest, HandlerResult } from '@jimhoyd/urlcode/extensions';

export interface SupportBanner { message: string; endLabel: string; href: string }
const MAXIMUM_HTML_BYTES = 1048576;
const dropped = ['cache-control', 'cdn-cache-control', 'vercel-cdn-cache-control', 'surrogate-control', 'etag', 'last-modified', 'content-length', 'x-urlcode-support-session'];

export function bannerMarkup(banner: SupportBanner): string {
    return `<aside role="alert" aria-label="Support session" id="urlcode-support-banner"><strong>${escapeHtml(banner.message)}</strong> <a href="${escapeHtml(banner.href)}">${escapeHtml(banner.endLabel)}</a></aside>`;
}
/** Runs `next` for a support session's request and returns its response with the support-session rules applied. */
export async function supportSessionResponse(request: ExtensionRequest, next: () => Promise<HandlerResult>, banner: SupportBanner): Promise<HandlerResult> {
    for (const name of ['if-none-match', 'if-modified-since', 'range', 'if-range', 'accept-encoding'])
        request.headers.delete(name);
    const result = await next(), markup = bannerMarkup(banner);
    const output = result.headers.filter(([name]) => !dropped.includes(name.toLowerCase()));
    output.push(['cache-control', 'no-store'], ['cdn-cache-control', 'no-store'], ['x-urlcode-support-session', 'active']);
    const type = output.find(([name]) => name.toLowerCase() === 'content-type')?.[1].split(';')[0]?.trim().toLowerCase();
    if (result.status !== 304 && (request.method.toUpperCase() === 'HEAD' || type !== 'text/html' || result.status < 200 || result.status === 204 || result.status >= 300 && result.status < 400))
        return { ...result, headers: output };
    const encoded = typeof result.body === 'string' ? Buffer.from(result.body) : Buffer.from(result.body ?? new Uint8Array());
    let html: string;
    try {
        if (result.status === 304 || output.filter(([name]) => name.toLowerCase() === 'content-type').length !== 1 || encoded.byteLength > MAXIMUM_HTML_BYTES || output.some(([name, value]) => name.toLowerCase() === 'content-encoding' && value !== 'identity'))
            throw new Error('Unsupported response');
        html = new TextDecoder('utf-8', { fatal: true }).decode(encoded);
    }
    catch {
        return { status: 409, headers: [['content-type', 'text/html; charset=utf-8'], ['cache-control', 'no-store'], ['cdn-cache-control', 'no-store'], ['x-urlcode-support-session', 'active'], ['content-security-policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'"], ['referrer-policy', 'no-referrer'], ['x-content-type-options', 'nosniff']], body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Support session</title></head><body>${markup}<p>This page cannot be displayed safely during a support session.</p></body></html>` };
    }
    html = /<body(?:\s[^>]*)?>/i.test(html) ? html.replace(/<body(?:\s[^>]*)?>/i, match => match + markup) : markup + html;
    const { contentLength: _length, ...rest } = result;
    return { ...rest, headers: output, body: new TextEncoder().encode(html) };
}
