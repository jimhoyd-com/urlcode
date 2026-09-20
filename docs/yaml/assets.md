# YAML guide: Pages, static folders and downloads

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 10. Pages, static folders, downloads and MIME

```yaml
  /about:
    page:
      file: public/about.html
      cacheControl: no-cache
  /assets/*:
    static:
      directory: public/assets
      index: index.html
      cacheControl: public, max-age=3600
  /download:
    download:
      file: public/guide.txt
      filename: urlcode-guide.txt
      contentType: text/plain
      cacheControl: no-store
```

All files must exist. MIME is detected by extension, not content sniffing; unknown
extensions become application/octet-stream. `contentType` overrides detection
without MIME parameters. An override on a static mount affects all its files.
The download name defaults to the source basename. `index` is opt-in and only
applies to slash-terminated requests. No automatic slash redirect or SPA fallback.

`cacheControl` is a closed enum on `page`, `download` and `static`; any other
value fails validation. Reserve immutable caching for versioned URLs.

| Value | Use for |
|---|---|
| `no-cache` (default) | Revalidate every time; ETag makes it cheap |
| `no-store` | Never cache (private or sensitive files) |
| `public, max-age=3600` | Shared one-hour cache for content that changes occasionally |
| `public, max-age=31536000, immutable` | Fingerprinted or versioned URLs only |

For other strategies use `policies.cache` ([cache](../policies/cache.md)). GET/HEAD, ETag/date validation and single byte ranges are supported.
Files stay snapshotted until reload/restart. See [assets](../ASSETS.md) for complete
conditional/range semantics and publication safety. Files are limited to 16 MiB
each and 64 MiB total unique bytes per snapshot.
