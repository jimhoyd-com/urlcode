# YAML guide: Site conventions

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 17. Site conventions

Generate the well-known files from a top-level `site` block instead of writing
them by hand. Each declared key becomes one native route counted by
`routes`/`audit`; a declared route at the same path wins.

```yaml
site:
  robots:
    disallow: [ai-crawlers, /admin]
    sitemap: true                 # Sitemap line needs --origin
  favicon: public/favicon.svg     # served at /favicon.ico
  securityTxt:
    contact: [mailto:security@example.com]
    expires: "2099-01-01T00:00:00Z"
  llms: public/llms.txt           # served at /llms.txt
  notFound: public/404.html       # status-404 page for unmatched GET/HEAD; built as 404.html
  # sitemap: true                 # /sitemap.xml; refuses to start without --origin
```

See [site conventions](../SITE.md) for every field, exclusions and target support.
