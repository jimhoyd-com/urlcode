# Security headers policy

`policies.security` adds response security headers on the host, outside the
sandbox, to every result a route produces: redirects, `respond` bodies,
function results, asset responses, cache hits and early denials from the
`agents` and `throttle` policies. Values are the OWASP Secure Headers
Project best-practice recommendations (OSHP 2024 best practices,
<https://owasp.org/www-project-secure-headers/>). The tables below are
generated from the frozen `profiles` constant in `src/policies/security.js`.

## YAML

```yaml
version: "1"
policies:
  security:
    headers: oshp            # oshp (default) | oshp-no-csp | off
    set:                     # add or overwrite one header, verbatim
      Content-Security-Policy-Report-Only: "default-src 'self'; report-to csp"
      Clear-Site-Data: '"cache"'
    unset:                   # drop a header the profile would emit
      - Cross-Origin-Embedder-Policy
routes:
  /embed:
    respond: { text: ok }
    policies:
      security: { headers: oshp-no-csp }   # route keys merge over project keys
```

`headers`, `set` and `unset` are the only keys. A route may also write
`security: false` to disable the policy for that route.

## Profile `oshp`

| Header | Value |
|---|---|
| `strict-transport-security` | `max-age=31536000; includeSubDomains` |
| `x-frame-options` | `deny` |
| `x-permitted-cross-domain-policies` | `none` |
| `referrer-policy` | `strict-origin-when-cross-origin` |
| `content-security-policy` | `default-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests; block-all-mixed-content` |
| `cross-origin-embedder-policy` | `require-corp` |
| `cross-origin-opener-policy` | `same-origin` |
| `cross-origin-resource-policy` | `same-origin` |
| `permissions-policy` | `accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(self), usb=(), web-share=(), xr-spatial-tracking=(), clipboard-read=(), clipboard-write=(), gamepad=(), hid=(), idle-detection=(), interest-cohort=(), serial=(), unload=()` |

## Profile `oshp-no-csp`

Identical to `oshp` without `Content-Security-Policy`.

| Header | Value |
|---|---|
| `strict-transport-security` | `max-age=31536000; includeSubDomains` |
| `x-frame-options` | `deny` |
| `x-permitted-cross-domain-policies` | `none` |
| `referrer-policy` | `strict-origin-when-cross-origin` |
| `cross-origin-embedder-policy` | `require-corp` |
| `cross-origin-opener-policy` | `same-origin` |
| `cross-origin-resource-policy` | `same-origin` |
| `permissions-policy` | `accelerometer=(), autoplay=(), camera=(), cross-origin-isolated=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), keyboard-map=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), sync-xhr=(self), usb=(), web-share=(), xr-spatial-tracking=(), clipboard-read=(), clipboard-write=(), gamepad=(), hid=(), idle-detection=(), interest-cohort=(), serial=(), unload=()` |

## Profile `off`

Emits nothing. `set` still applies, so `off` plus `set` is a hand-written
header list.

Not in any profile:

- `X-Content-Type-Options: nosniff`: the runtime sets it on every response,
  including errors, so the profile does not duplicate it.
- `Cache-Control`: owned by the `cache` policy and the asset handlers;
  `set` refuses it.
- `Clear-Site-Data`: destructive by design, so only on explicit `set`.

## Precedence

1. Headers already on the result keep their value. YAML `response.headers`
   are applied by the runtime before this policy runs, and a function or asset
   handler sets its headers earlier still, so any of them beats the profile
   header by header (`x-frame-options: sameorigin` on a route wins over the
   profile's `deny`).
2. `set` overwrites everything: the profile and an existing header of the
   same name. Writing a header under `set` is explicit operator intent.
3. `unset` removes a header from the profile by case-insensitive name. Naming
   a header the selected profile does not emit is a configuration error that
   names the route, so a typo cannot silently leave a header in place. The
   check runs against the profile in effect on each route: a route that
   switches to a profile without that header inherits the project `unset`
   and must write `unset: []` to clear it.

`set` names and values are validated at activation with the same rules the
wire enforces (RFC 7230 token names, no control characters) and may not name a
header the runtime or a handler owns (`content-length`, `content-type`,
`location`, `etag`, `content-encoding`, `cache-control`, `set-cookie`,
`x-request-id`, `x-content-type-options`, hop-by-hop headers), nor one
another policy emits (`vary`, `ratelimit`, `ratelimit-policy`, `retry-after`,
`age`). The static
headers of one route are capped at 8 KiB so the response keeps room under the
runtime's 16 KiB / 256-header limit; the error names the route.

## Error responses

Errors the runtime throws (404, 410, 413 and the rest) do not run the
response phase, but they do get this policy: the matched route's effective
profile when the error came after routing, otherwise the project-level one,
on every host and in the Cloudflare Worker. The fixed error headers
(`Content-Type`, `Cache-Control: no-store`, `Content-Length`, `X-Request-Id`,
`X-Content-Type-Options`) are never replaced.

## HSTS and the origin

`Strict-Transport-Security` is emitted only when the request origin is
`https:`. On the self-hosted server that is the `--origin` setting (or the
`origin` option of `startServer`); the Worker uses the request URL. A
browser ignores HSTS on a plain-text response, and a forwarded header such as
`X-Forwarded-Proto` is client-controlled, so the runtime never infers the
scheme from it. Behind a TLS-terminating proxy or tunnel, state
`--origin https://your.host` and the header appears. Once emitted, HSTS
commits the host to HTTPS for a year including subdomains: set the origin only
when that is true.

## CSP and pages with inline scripts

The `oshp` CSP (`default-src 'self'`, no `unsafe-inline`) blocks inline
`<script>` and `<style>` blocks and any third-party script. For a page that
needs them, either use `oshp-no-csp` on that route, or keep the profile and
trial a policy in report-only mode first:

```yaml
policies:
  security:
    headers: oshp-no-csp
    set:
      Content-Security-Policy-Report-Only: "default-src 'self'; script-src 'self' https://cdn.example; report-to csp"
```

Once the reports are clean, move the value to `Content-Security-Policy` under
`set`, which overrides the profile value.

## Targets

| Target | Support | Notes |
|---|---|---|
| node | native | `--origin` decides HSTS |
| vercel | native | origin from the adapter's public URL |
| aws | native | origin from the adapter's public URL |
| cloudflare | compiled | Validated at build; the Worker compiles the same module synchronously and emits identical headers. HSTS follows the request URL scheme. |

## Interaction with other policies

- `cache`: security headers are added after the cache store and on cache
  hits, so a stored body never carries a stale profile; `Cache-Control` is
  never touched.
- `compression`: runs after this policy, so `Vary`/`Content-Encoding` are
  unaffected and the size check above already includes the profile.
- `agents` and `throttle`: their denials pass through this policy, so a 403
  or 429 carries the same headers as a normal response.

`urlcode audit` and `testPlan().policies` report, per route, the profile
name, the header names it emits, and the `set` and `unset` names.
