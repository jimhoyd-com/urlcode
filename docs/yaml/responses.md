# YAML guide: Declared responses, headers and cookies

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 8. Native responses, headers and cookies

```yaml
  /status:
    respond:
      json: {ok: true, service: my-links}
  /notice:
    respond:
      status: 503
      text: Temporarily unavailable
    response:
      headers:
        Retry-After: "60"
  /empty:
    respond: {status: 204}
  /cookie-demo:
    respond: {text: Non-secret preferences only}
    response:
      headers:
        Set-Cookie:
          - "theme=light; Path=/; Secure; SameSite=Lax"
          - "notice=seen; Path=/; HttpOnly; Secure; SameSite=Lax"
```

`respond` defaults to 200. Use text or JSON, never both. Omit both for an empty
body; 204/205 must have no body. 206/304 belong to native asset handling.
Header values are literal strings; quote numeric-looking values. Only Set-Cookie
accepts arrays. Do not put live session tokens in YAML. Secure cookies require
HTTPS at the browser. Functions can create dynamic cookies, but no cookie
parsing/signing/authentication framework is built in.

Do not set Content-Length, Location, Allow, ETag, Content-Range or other
runtime-owned headers in YAML. Use the corresponding handler. The full reserved
list and precedence rules are in [HTTP](../HTTP.md).

## 9. Explicit OPTIONS response (not automatic CORS)

```yaml
  /preflight:
    methods: [OPTIONS]
    respond: {status: 204}
    response:
      headers:
        Access-Control-Allow-Origin: https://app.example.com
        Access-Control-Allow-Methods: GET, HEAD
        Access-Control-Allow-Headers: Content-Type
```

This teaches declared headers only; it is not a working cross-origin GET API.
For a real API, OPTIONS and the actual methods must be handled on the same URL,
and actual responses also need the appropriate CORS headers. Because one path
has one handler, use a function with `[GET, HEAD, OPTIONS]` to branch on method.
Never reflect arbitrary Origin with credentials. Automatic CORS is unsupported.

## 9b. JSON errors for an API

```yaml
  /api/status:
    respond:
      json: {status: ok}
    errors: {format: json}
```

A JSON client of `/api/status` that sends POST gets 405 with
`Allow: GET, HEAD` and `{"error":{"code":"METHOD_NOT_ALLOWED","message":"Method not allowed"}}`
as `application/json`, instead of the text line `Method not allowed`. Keep
native `methods` and `respond`; there is no need for a function that re-implements
method dispatch. For a whole API prefix, including paths no route declares,
use the top-level `site.errors` scope instead of repeating the key:

```yaml
site:
  errors:
    format: json
    paths: [/api/*]
```

Only errors the runtime writes itself change (405, 404, 413, 415, 422 and the
rest); a handler's own status and body, a policy's or an extension's answer are
never rewritten. A route's own `errors` wins over the scope. Static hosting
refuses both. The code set and precedence are in
[error format](../HTTP.md#error-format).
