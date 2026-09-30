// Response headers the runtime or a handler owns, so route `response.headers` (http-policy.ts), `shared` blocks
// (config.ts) and a security profile's `set` (policies/security.ts) may not claim them. No imports and no Node globals:
// policies/security.ts ships to the Cloudflare Worker.
export const reservedResponseHeaders = new Set(['connection','keep-alive','transfer-encoding','content-length','upgrade','trailer','proxy-authenticate','proxy-authorization','te','location','allow','content-range','accept-ranges','etag','last-modified','content-encoding','x-request-id','x-content-type-options']);
