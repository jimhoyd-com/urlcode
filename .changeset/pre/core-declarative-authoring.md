---
"@jimhoyd/urlcode": patch
---

Declarative authoring: `request.body.schema` validates JSON request bodies with a bounded JSON-Schema subset and answers a failing request with 422 (a structured JSON error listing the failing pointer and keyword, never the value, when the client explicitly accepts `application/json`; plain text otherwise). Parameter schemas accept `format: uuid` and a restricted `pattern` (length caps, unsafe patterns refused at activation). A top-level `shared` map holds named `request` and `response.headers` blocks that routes select with `use: <name>`, resolved at load time; YAML anchors stay rejected. `coveredElsewhere` lets a route waive a method that other tests cover, with a required reason. `site.notFound` serves a configured page with status 404 for unmatched GET and HEAD requests (the Cloudflare target refuses it explicitly).
