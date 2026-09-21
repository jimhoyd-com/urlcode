# Site conventions

The optional top-level `site` block generates the small well-known files a
site is expected to serve. Every key is off unless declared, and each declared
key becomes one ordinary native route (`respond` or `page`) that is merged into
the route table before compilation. Everything downstream is unchanged: the
route appears in `urlcode routes` with `generated: "site.<key>"`, the audit
generates fixtures for it, host policies apply to it and every deployment
target compiles it like a route the project wrote by hand. `site` is accepted
only in the entry `urlcode.yaml`, not in included files.

```yaml
version: "1"
site:
  robots:
    disallow: [ai-crawlers, /admin]
    allow: [/admin/public]
    sitemap: true
  sitemap:
    exclude: [/drafts/*]
    changefreq: weekly
  favicon: public/favicon.svg
  securityTxt:
    contact: [mailto:security@example.com]
    expires: "2027-01-01T00:00:00Z"
    policy: [https://example.com/security-policy]
    preferredLanguages: [en, fr]
  llms: llms.txt
  notFound: public/404.html
routes:
  /: {page: {file: public/index.html}}
```

The [cookbook](../examples/cookbook/urlcode.yaml) declares `robots`, `favicon`,
`securityTxt` and `llms` with request fixtures; `sitemap` is exercised by the
unit tests because it needs a public origin (below).

## Precedence with declared routes

A route the project declares at a generated path always wins. The generated
route is dropped and the activation log records
`{"event":"site","key":"robots","path":"/robots.txt","status":"shadowed"}`.
This is how a project keeps a hand-written `robots.txt` while still using
`site.favicon`, or migrates one file at a time.

## The public origin

`robots.txt`'s `Sitemap:` line and every `<loc>` in `sitemap.xml` are absolute
URLs, so the runtime needs to know the origin the site is served from. It
never guesses from a request: a generated file is a fixed response compiled at
activation, and a `Host` header is client-controlled. The origin is the
operator's `--origin https://links.example` flag on `serve`, `dev`,
`validate`, `test`, `routes`, `audit`, `benchmark` and `build`, or the
`origin` option of `startServer`/`createRuntime`/`buildCloudflare`.

- `site.robots.sitemap: true` without an origin omits the `Sitemap:` line and
  logs `{"event":"site","key":"robots","severity":"info",...}` at activation.
- `site.sitemap` without an origin **refuses activation**: a sitemap of relative
  URLs is invalid under the protocol, so there is no useful degraded form.

## Keys

### `robots` → `/robots.txt` (RFC 9309)

| Field | Meaning |
| --- | --- |
| `disallow` | bundled agent list names (`ai-crawlers`, `crawlers`, `seo`, `monitoring`, the same lists as the [`agents` policy](policies/agents.md)) and/or paths starting with `/` |
| `allow` | the same shapes, emitted as `Allow:` |
| `sitemap` | `true` appends `Sitemap: <origin>/sitemap.xml` when the origin is known |
| `extra` | literal lines appended verbatim (comments, `Crawl-delay`, ...) |

List names become one group of `User-agent:` lines followed by `Disallow: /`
(or `Allow: /`). Paths go under `User-agent: *`; with no paths that group is
`Allow: /`. A list entry whose name is not usable as a product token (it has
spaces or pattern metacharacters) is skipped and counted in an info log line.
The result is served as `text/plain; charset=utf-8`.

```
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /

User-agent: *
Disallow: /admin
Allow: /admin/public

Sitemap: https://links.example/sitemap.xml
```

### `sitemap` → `/sitemap.xml` (sitemaps.org protocol 0.9)

`true`, or `{ exclude, changefreq, priority }`. The sitemap lists every active
literal GET route that serves HTML: a `page` whose file is `.html`/`.htm` or
whose `contentType` is `text/html`; a `respond` route whose `Content-Type`
response header is `text/html`; and the `.html` files under a `static` mount
(the mount's `index` file is listed as its directory URL). Excluded:
parameterized routes, redirects, functions, downloads and stored links,
disabled or expired routes, `/robots.txt` and `/sitemap.xml`, any route whose
`response.headers` set `X-Robots-Tag` containing `noindex`, and anything an
`exclude` pattern matches (an exact path, or a prefix ending in `/*`).
`lastmod` is the file's modification date for asset routes and omitted
otherwise. URLs are sorted and XML-escaped; the response is
`application/xml; charset=utf-8`.

More than 50,000 URLs, or a document over the 1 MiB declared-response limit,
refuses activation with a message saying to generate the file at build time
and serve it as a static asset instead; the runtime does not split or index
sitemaps.

### `favicon` → `/favicon.ico`

A project-relative `.ico`, `.svg` or `.png` file, served as a `page` route
with `image/x-icon`, `image/svg+xml` or `image/png` and
`cacheControl: public, max-age=3600` (the closest value in the
[allowed vocabulary](ASSETS.md)). The route has the usual asset semantics:
ETag, Last-Modified, conditional requests and ranges.

### `securityTxt` → `/.well-known/security.txt` (RFC 9116)

| Field | Rule |
| --- | --- |
| `contact` (required) | one or more `mailto:`, `tel:` or `https:` URIs |
| `expires` (required) | UTC ISO timestamp; must be in the future at activation; more than a year away logs a warning (the RFC recommends less than a year) |
| `policy`, `acknowledgments`, `canonical` | `https:` URIs |
| `encryption` | `https:`, `dns:` or `openpgp4fpr:` URIs |
| `preferredLanguages` | language tags, emitted as one comma-separated line |

Fields are emitted in the RFC's order (Acknowledgments, Canonical, Contact,
Encryption, Expires, Policy, Preferred-Languages), one value per line. The
file is unsigned; add a signed copy as a declared route if you need one. The
`.well-known` segment is an ordinary route segment (only `.` and `..` are
refused).

### `llms` → `/llms.txt`

A project-relative text file served as a `page` route with
`text/plain; charset=utf-8` and the default `no-cache`.

### `notFound` → `/404.html`

A project-relative `.html`/`.htm` file that answers a request matching no
route. It becomes a `page` route at `/404.html` (`text/html; charset=utf-8`,
`Cache-Control: no-store`); the runtime serves that page with status **404**
for an unmatched `GET` or `HEAD`, with the same project security headers and
`nosniff` as the built-in 404. Other methods keep the plain-text `Not found`.
A route that matches but is disabled, mismatched by `match:` or denied by a
policy keeps its own answer; only "no route matched" uses the page.

`/404.html` is also reachable directly and answers 200 (the same as on static
hosting, which is why the path is fixed). It is one generated route in the
`routes`/`audit` counts and `explain` reports it as `site.notFound`; the
sitemap leaves it out. A route you declare at `/404.html` wins and is served
as the not-found page instead. The page answers every unknown URL, so it cannot depend on the path requested.

`urlcode build --target static` writes it as the object `404.html` (see
[static hosting](STATIC.md)); point the host's error document at that key.
Cloudflare inlines it: the page is small, singular and static, so the build
reads it (64 KiB cap, must decode as UTF-8) and carries it in the artifact as a
`respond` route at `/404.html`, answering the same status, headers and method
rules as every other target. See [`docs/CLOUDFLARE.md`](CLOUDFLARE.md#site-notfound-is-inlined).
`favicon` and `llms` stay refused there like any other `page` route (no asset
binding).

## Per-target support

| Target | `robots`, `sitemap`, `securityTxt` (`respond`) | `favicon`, `llms` (`page`) | `notFound` |
| --- | --- | --- | --- |
| self-hosted, Vercel, AWS | served | served | served |
| Cloudflare | compiled into the artifact (`build --origin` for absolute URLs) | refused at build time like any `page` route: the target has no asset binding; serve them from the platform's static assets | inlined into the artifact (64 KiB cap, UTF-8) |

## Not in this release

No per-route `noindex` field (use `response.headers: {X-Robots-Tag: noindex}`,
which the sitemap honours), no sitemap index or split files, no `humans.txt`,
no signed `security.txt`, and no project `.json` agent lists in `robots`
(bundled names only).
