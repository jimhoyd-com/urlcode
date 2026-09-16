# Pages, static files and downloads

Native file handlers are implemented in 0.1.0-alpha.3. They work in the local
Node runtime and self-hosted process/container. Provider adapters remain planned.
They do not run user functions or expose filesystem APIs to sandboxed code.

```yaml
version: "1"
routes:
  /about:
    page:
      file: public/about.html
  /assets/*:
    static:
      directory: public/assets
      index: index.html
      cacheControl: public, max-age=3600
  /guide:
    download:
      file: public/guide.pdf
      filename: getting-started.pdf
      contentType: application/pdf
```

Create all files/directories before validation or startup. Paths are relative to
the project root. `page` sends one file inline; `download` sends one file as an
attachment; `static` publishes a dedicated directory tree. There is no remote
fetch/proxy, directory listing, automatic trailing-slash redirect, framework
server, SPA fallback or runtime template evaluation. Use prebuilt assets.

## Complete handler options

| Handler | Required | Optional |
|---|---|---|
| `page` | `file` | `contentType`, `cacheControl` |
| `download` | `file` | `filename`, `contentType`, `cacheControl` |
| `static` | `directory` | `index`, `contentType`, `cacheControl` |

`index` is opt-in, a plain `.html` basename such as `index.html`, served only
when the requested path ends in `/`. A mount `/assets/*` matches `/assets/` and
its descendants, not `/assets`. Missing files return 404. Exact routes precede
parameterized routes; mounts follow, longest prefix first. No fallback between
mounts. Asset routes accept only GET/HEAD (both default); normal enabled/expiry
and declared input validation still apply. Choose exactly one handler per route.

MIME detection uses the filename extension through `mime-types`; it does not
sniff file bytes. Unknown extensions use `application/octet-stream`. An explicit
`contentType` is a MIME essence such as `text/plain` (no parameters). Known text
charsets are added automatically. On a static mount an override applies to all
its files; normally leave it unset for mixed assets. Responses use `nosniff`.
Download names default to the source basename. Unicode names use a standards-based
Content-Disposition attachment header with UTF-8 encoding and fallback filename.
Path separators and control characters in names are rejected.

Allowed `cacheControl` values in this alpha:

- `no-cache` (default): clients may store but must revalidate.
- `no-store`: clients should not store the response.
- `public, max-age=3600`: one-hour public caching.
- `public, max-age=31536000, immutable`: only for content-versioned URLs you never overwrite.

Strong content/representation ETags and Last-Modified are emitted. If-Match and
If-Unmodified-Since enforce preconditions (412); If-None-Match and
If-Modified-Since permit 304. ETag conditions take precedence over date conditions.
HEAD returns metadata and the full Content-Length with no body. GET supports a
single byte range, including suffix/open-ended ranges (206); unsatisfiable ranges
return 416 with `Content-Range: bytes */size`. Multiple, malformed or unsupported
ranges are ignored and return the full 200 response. If-Range works with an exact
strong ETag; dates and mismatches return the full representation. Range is ignored
for HEAD and evaluated after preconditions.

## Publishing boundary and resource limits

Assets are an explicit publication surface. Review the files before running an
untrusted project; no filename filter can identify every secret. Keep a dedicated
public directory. Asset declarations reject absolute paths, traversal, dot/hidden
segments, symlinks (including internal ones), hardlinked files and nonregular
files. Static trees skip hidden entries, `node_modules`, `urlcode.yaml/yml`,
`package.json`, `package-lock.json` and `.pem/.key/.p12/.pfx/.env` files. Explicit
references to those names fail. Do not put credentials or private data under
innocent filenames in a public directory. HTML/JavaScript assets are active browser
content; only publish reviewed content on an origin that you control.

Startup validates and snapshots bytes in memory: **16 MiB per file, 64 MiB total
unique file contents, 10,000 traversed static entries and 20 directory levels**.
These are implementation resource budgets, not Cloud tier restrictions. This is
bounded buffered serving, not arbitrary-size streaming. For larger collections
use an external asset service and redirect, pending provider asset adapters.
Reload can temporarily hold both old and new snapshots; allow memory headroom.

Requests never open asset paths. Files changed after activation stay unchanged
until a valid reload/restart, preventing request-time path substitution. Keep the
deployment tree operator-owned and stable during compilation; protection against
another host process racing directory changes is not a filesystem sandbox.
`dev` watches declared asset metadata and applies additions, edits and deletions
through validated reloads. A missing required file or invalid tree keeps the last
good snapshot. `serve` is fixed until restart. Function grants remain pinned to
configuration/source, not asset bytes; an asset-only edit does not authorize new
code or new bindings. Asset changes do update the health version and ETags.

The runnable [dynamic starter](../starters/dynamic/urlcode.yaml) includes page,
static and download routes with local HTTP assertions. HTTP semantics follow
[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html); MIME mappings use
[mime-types](https://github.com/jshttp/mime-types).
