# YAML guide: Live short-link records

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 15. Live short-link records

Set `dynamicLinks: true` in the entry `urlcode.yaml` before adding this route.
It defaults to false and cannot be enabled by an included file.

```yaml
  /r/{code}:
    parameters:
      - name: code
        in: path
        required: true
        schema: {type: string, minLength: 1, maxLength: 128}
    link:
      collection: links
      code: {from: path, name: code}
```

The seventh handler resolves stored records without rebuilding YAML. It requires
an external operator store binding; the [live-link example](../../examples/live-links/README.md)
has separate setup and fixtures. See [dynamic links](../DYNAMIC-LINKS.md) for CLI/API
creation, optimistic updates, disabled/expired records, persistence and backups.
This is not a general database capability for sandboxed functions.

Live-link recipes require `dynamicLinks: true` in the entry `urlcode.yaml`. It is
false by default and cannot be set in included route files. Parameterized routes
and functions alone do not need it. See [dynamic-link opt-in](../DYNAMIC-LINKS.md#explicit-project-opt-in).
