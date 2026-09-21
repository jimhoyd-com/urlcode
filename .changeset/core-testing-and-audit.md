---
"@jimhoyd/urlcode": patch
---

Testing and audit: `tests/requests.json` fixtures can be ordered `steps` with `capture` and `{{name}}` substitution and a `restart` step that restarts the runtime on the same data directory; `startServer` gains `dataDir` and `isolateData`. `urlcode test` is quiet by default (failing cases and a summary; `--verbose` prints every request). `urlcode audit` reports `notReadyReasons`, `waivedRouteMethods`, `ignoredWaivers` and `redundantWaivers`, and its `counts` separate `declared` from `generated` routes. `--expect-routes` still compares the total, including generated site routes such as `/robots.txt`.
