# YAML guide: Enable, disable and expire

Snippets are entries under `routes:` unless stated otherwise; the [guide index](../YAML-GUIDE.md) lists every page.

## 11. Enable, disable and expire

```yaml
  /paused:
    enabled: false
    redirect: {url: 'https://example.com/'}
  /campaign:
    description: A scheduled end, no scheduled start
    expires: "2030-01-01T00:00:00Z"
    redirect: {url: 'https://example.com/'}
```

Quote timestamps so they remain strings. Disabled routes return 404; expired
routes return 410. Expiry is an absolute UTC timestamp, not a TTL. There is no
start-time scheduler. `description` is authoring metadata. Changing YAML activates
through dev reload or production restart/deployment; it is not an HTTP mutation.
