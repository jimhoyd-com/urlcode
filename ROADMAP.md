# Public roadmap

Everything below is planned, not implemented. Release scope is driven by a
complete usable OSS experience rather than a hosted-service dependency.

1. Record ownership and publish Apache-2.0; define the versioned YAML schema, HTTP input
   conventions, portable function API and supported runtime/platform matrix.
2. Build the local CLI/runtime: initialize, create aliases, validate, serve,
   watch/reload atomically, execute functions and resolve scoped env/secrets.
3. Extend the common route model with page/static/download handlers, then bounded
   proxies and protected-download templates as semantics/conformance are defined.
   Prebuilt content only; no frontend framework or general hosting platform.
4. Add CSV/YAML/JSON import/export, list/filter, safe bulk update, duplicate and
   redirect-loop checks, file composition and reusable pinned templates.
5. Test real HTTP behavior and asynchronous signals with local fake receivers;
   add optional ngrok lifecycle integration without requiring it for tests.
6. Ship generic self-hosting and provider adapters incrementally, documenting
   native rule exports, capabilities, quotas and unsupported behavior. Target
   Cloudflare, AWS and Vercel; add Netlify redirect interchange and more later.
7. Provide Homebrew and tested macOS/Linux/Windows distribution, clean-install
   checks, upgrades, reproducible benchmarks, logs/health/metrics and monitoring.

## Quality gates

- Same fixtures pass on the reference runtime and every claimed provider target.
- A pure redirect does not invoke Lambda or arbitrary per-route user code.
- CSV conversions preserve supported meaning; complex exports report losses.
- 1k/10k/100k-route datasets measure compile/reload, memory, latency and throughput.
- Unit and end-to-end tests run offline against local HTTP servers by default.
- Load tests do not follow redirects to third-party sites and use bounded traffic.
- Invalid reload retains the last valid configuration; secrets never enter Git,
  logs, URLs, exports or build artifacts.
- Install and smoke tests verify every advertised OS/architecture package.

No invented performance promises or blanket provider-compatibility claims.
Publish measurements, limitations and remaining gaps alongside alpha releases.
