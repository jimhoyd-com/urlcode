# Standards conformance audit

What URLCode implements of each RFC and specification it touches or names,
verified against the code and the test suite at the commit this file was
written for (`817f0ab`, 2026-09-17, Node v22.22.2). Every row cites the
lines that implement the behavior and the test that proves it; "untested"
means no test in `test/` asserts that specific behavior. Where the code was
not conclusive, the behavior was observed by running a server with the test
helpers and sending raw requests over `node:net` / `node:http`; those rows
say "probed".

Status vocabulary:

- **conforms**: the implemented subset follows the standard's requirements.
- **partial**: some of the standard is implemented and the rest is out of
  scope or approximated; the deviation is stated with its rationale.
- **deviates**: the runtime does something the standard forbids or requires
  differently; listed again in the gap list at the end.
- **not applicable**: the standard is only named, or is delegated to a
  platform, and no code claims to implement it.

## Summary

| Standard | Status | Section |
|---|---|---|
| RFC 9110 HTTP Semantics | partial (one deviation: HEAD `Content-Length` on non-asset routes) | [1](#1-rfc-9110-http-semantics) |
| RFC 9111 HTTP Caching | partial | [2](#2-rfc-9111-http-caching) |
| RFC 5861 stale-while-revalidate / stale-if-error | partial | [3](#3-rfc-5861-stale-while-revalidate-and-stale-if-error) |
| RFC 8246 immutable | conforms | [4](#4-rfc-8246-immutable) |
| RFC 9213 targeted cache control | conforms | [5](#5-rfc-9213-targeted-cache-control) |
| RFC 6585 additional status codes (429, 431) | partial (431 answered as 400) | [6](#6-rfc-6585-additional-http-status-codes) |
| RFC 9112 HTTP/1.1 message syntax | partial (absolute-form/asterisk-form 400; 414 answered as 400) | [7](#7-rfc-9112-http11-message-syntax) |
| RFC 3986 URI | partial (dot segments rejected, not normalized) | [8](#8-rfc-3986-uri-and-percent-encoding) |
| RFC 7239 Forwarded / X-Forwarded-For | not applicable (RFC 7239); X-Forwarded-For implemented | [9](#9-rfc-7239-forwarded-and-x-forwarded-for) |
| RFC 9309 robots.txt | not applicable (documented recipe only; recipe YAML is invalid) | [10](#10-rfc-9309-robotstxt) |
| RFC 6797 HSTS | conforms | [11](#11-rfc-6797-hsts) |
| RFC 1950/1951/1952, 7932, 8878 content codings | conforms | [12](#12-rfc-19501952-rfc-7932-rfc-8878-content-codings) |
| RFC 6265 Set-Cookie | partial (transport only) | [13](#13-rfc-6265-set-cookie) |
| RFC 6266 / RFC 8187 Content-Disposition | conforms | [14](#14-rfc-6266--rfc-8187-content-disposition) |
| draft-ietf-httpapi-ratelimit-headers | conforms to the draft syntax (Internet-Draft, not an RFC) | [15](#15-ietf-httpapi-ratelimit-header-fields-internet-draft) |
| web-bot-auth drafts | not applicable | [16](#16-web-bot-auth-drafts) |
| OWASP Secure Headers Project | conforms to the pinned table | [17](#17-owasp-secure-headers-project) |
| CSP Level 3 | partial (emits one obsolete directive from OSHP) | [18](#18-content-security-policy-level-3) |
| JSON Schema 2020-12 | conforms (Ajv 8.20.0) | [19](#19-json-schema-2020-12) |
| YAML 1.2 | conforms (JSON-compatible profile) | [20](#20-yaml-12) |
| CIDR notation | partial (IPv4-embedded IPv6 other than `::ffff:` mis-parsed) | [21](#21-cidr-notation-for---trusted-proxies) |

## 1. RFC 9110 HTTP Semantics

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| §9 methods; default GET/HEAD | conforms | `src/router.js:10` `methodsDefault = ['GET','HEAD']`; explicit lists replace it (`:56`); schema enum at `schemas/urlcode.schema.json:107-118` | `test/http.test.js` "literal precedence, methods, HEAD, query isolation, disabled/expired and health" |
| §15.5.6 405 with `Allow` | conforms | `src/runtime.js:117-121` answers `405` with `allow: <route.methods>`; health probes at `src/server.js:122`; Worker at `src/cloudflare.js:96` | same test (`allow === 'GET, HEAD'`); `test/policies.test.js` "interoperability: ... 405 carries policy headers"; `test/aws.test.js` "a Lambda response carries exactly ..." (405 on POST) |
| §9.1 unrecognized method → 501 | partial | Node's parser refuses unknown tokens before the runtime sees them; `src/server.js:155-157` `clientError` writes `400`. Probed: `BREW /r` → 400. Rationale: llhttp rejects at parse time; the runtime never sees the method | untested |
| §9.3.2 HEAD suppresses body | conforms | `src/http-response.js:23-24` drops the body for HEAD and 204/205/304 | `test/http.test.js` (HEAD `/go` body `''`); `test/http-policy.test.js` lines 16, 23; `test/vercel.test.js:49` |
| §8.6 `Content-Length` on HEAD MUST equal what GET would send | **deviates** | `src/http-response.js:28` writes `result.contentLength ?? body?.length ?? 0`; for HEAD `body` is already `undefined` (`:24`), so a `respond` or function result without `contentLength` sends `content-length: 0`. Probed: `GET /r` → `content-length: 13`, `HEAD /r` → `content-length: 0`; same for a function route (25 vs 0). Assets set `contentLength` (`src/assets.js:108,113`) and cache hits do (`src/policies/cache.js:116`), so those are correct (probed: `HEAD /a` → 3000). Compression skips dynamic bodies on HEAD (`src/policies/compression.js:158`) so the identity length would be the right value | untested (tests assert only that the HEAD body is empty) |
| §15.4 redirects: 301/302/303/307/308, absolute `Location` | conforms | schema enum `schemas/urlcode.schema.json:258-262`; `src/match.js:77-90` builds `Location` from `new URL(...).href`; default 302 at `src/runtime.js:127`; link handler `:144` | `test/http.test.js` (location assertions); `test/http-policy.test.js` "YAML response headers apply to functions and redirects" |
| §10.2.2 `Location` reserved from YAML | conforms | `src/http-policy.js:7` reserved set includes `location`, `allow`, `content-range`, `accept-ranges`, `etag`, `last-modified`, `content-encoding` | `test/http-policy.test.js` "invalid response policy and contradictory declarations fail activation" |
| §7.6.1 hop-by-hop headers never set by a handler | conforms | `src/http-response.js:5` `forbiddenHeaders` (connection, keep-alive, transfer-encoding, content-length, upgrade, trailer, proxy-authenticate, proxy-authorization, te) stripped at `:16`, refused in YAML at `src/http-policy.js:7,14`, and on error answers `:50` | `test/http-policy.test.js` "invalid response policy ..." |
| §5.6.2 field names are tokens; §5.5 no CTLs in values | conforms | `src/header-validation.js:6-7` (`token` regex, `invalidValue = /[^\t -~-ÿ]/`), applied at `src/http-response.js:17`, `src/http-policy.js:18-19`, `src/policies/security.js:73` | `test/header-validation.test.js` all three tests (compared against `node:http` over 0x00–0x11F) |
| §8.8.3 ETag, strong vs weak | conforms | Assets: strong `"sha256(type+disposition+body)"` at `src/assets.js:51`. Precompressed variants: strong tag with coding suffix inside the quotes, `src/policies/compression.js:18,130`. Dynamically compressed bodies: handler tag weakened to `W/...` (`:130`). `revalidate` strategy: strong SHA-256 over the body when the handler sent none, `src/policies/cache.js:183` | `test/assets.test.js` "asset conditions, byte ranges ..."; `test/policy-compression.test.js` "page assets are precompressed once, served by reference with a suffixed strong ETag, and revalidate" and "function JSON compresses with a weak ETag ..."; `test/policy-cache.test.js` "revalidate answers 304 ..." |
| §8.8.2 `Last-Modified` | conforms | second-resolution IMF-fixdate from mtime, `src/assets.js:43` | `test/assets.test.js` (304 on `if-modified-since`) |
| §13.1.1 `If-Match` strong comparison | conforms | `src/assets.js:90,92`: `weak=false` compares the full tag, so `W/"x"` never matches; `*` matches | `test/assets.test.js` (`if-match: W/<etag>` → 412) |
| §13.1.2 `If-None-Match` weak comparison | conforms | `src/assets.js:90,94` strips `W/`; `*` matches; `src/policies/cache.js:166-169` and `src/policies/compression.js:133-135` do the same for their own tags | `test/assets.test.js` (`W/<etag>` → 304); `test/policy-cache.test.js` "revalidate answers 304 ..." |
| §13.1.3 / §13.1.4 date conditions ignored when the ETag condition is present; invalid dates ignored | conforms | `src/assets.js:93` (`!match && ...`), `:94` (`none ? ... : ...`); `Date.parse` → `NaN` makes both comparisons false, i.e. the header is ignored | `test/assets.test.js` (`if-none-match: "other"` + matching `if-modified-since` → 200) |
| §13.2.2 evaluation order If-Match → If-Unmodified-Since → If-None-Match → If-Modified-Since → If-Range | conforms | `src/assets.js:92-97` in that order; Range evaluated after preconditions and only for GET | `test/assets.test.js` (`range` + `if-none-match` → 304; HEAD + `range` → 200 with full length) |
| §14 Range, single byte range; §14.4 206 `Content-Range`; §15.5.17 416 with `bytes */size` | conforms | `src/assets.js:95-110`; suffix and open-ended ranges, `BigInt` arithmetic (`:100-102`), 416 at `:105`; multiple/malformed/non-`bytes` units ignored (§14.2 "MAY ignore") | `test/assets.test.js` "asset conditions, byte ranges, empty files and HEAD obey HTTP ordering" |
| §13.1.5 `If-Range` | partial | `src/assets.js:97`: only an exact strong ETag match enables the range; a date `If-Range` is treated as non-matching and the full 200 is sent. Rationale (`src/assets.js:96` comment, `docs/ASSETS.md`): a date validator is only usable when it is known to be strong; sending the full representation is the prescribed fallback for a non-matching validator | `test/assets.test.js` (`if-range: "old"` → 200; `if-range: <etag>` → 206) |
| §15.4.5 304 header set | conforms | Assets keep `Content-Type`, `ETag`, `Last-Modified`, `Cache-Control`, `Accept-Ranges` (`src/assets.js:87-89`); `Content-Length` omitted for 304 (`src/http-response.js:23,28`). `revalidate` keeps `etag, cache-control, cdn-cache-control, vary, last-modified, content-location, expires, date, content-type` (`src/policies/cache.js:190`) | `test/policy-cache.test.js` "revalidate answers 304 ..." (checks `etag`, `cache-control`, `content-type` on the 304) |
| §12.5.3 `Accept-Encoding` negotiation | conforms | `src/policies/compression.js:92-113`: q-weights, `*` for unnamed codings, highest weight wins, project order breaks ties; identity is sent when nothing is acceptable, including `identity;q=0` / `*;q=0` (§12.5.3 permits either identity or 415; the code chooses identity, comment at `:88-91`) | `test/policy-compression.test.js` "negotiation follows RFC 9110 q-values with the project order as tie-break" |
| §8.4 `Content-Encoding` | conforms | set only by the compression policy (`src/policies/compression.js:163`); reserved from YAML (`src/http-policy.js:7`); request bodies with a non-identity `Content-Encoding` are refused with 415 (`src/http-policy.js:42`) | `test/policy-compression.test.js`; `test/http-policy.test.js` "request body policies reject size, media, encoding and malformed JSON" |
| §12.5.5 `Vary` | conforms | `Vary: Accept-Encoding` added or merged, `*` respected (`src/policies/compression.js:119-126`), also on 304/206 (`:143-144`); cache strategies merge declared `vary` names (`src/policies/cache.js:156-165`) | `test/policy-compression.test.js` "declared text responses compress ... Vary is set once"; `test/policy-cache.test.js` "vary headers separate keys and are emitted ..." |
| §15 status codes used | conforms | 400 (`src/match.js:17-24`, `src/http-policy.js:40,47,50`), 404 (`src/runtime.js:95,102`, `src/assets.js:84`), 405 (`:117`), 410 (`:103`), 412/304/206/416 (assets), 413 (`src/server.js:39,47`, `src/http-policy.js:39`), 415 (`:42,44,49`), 429/503 (throttle), 502/504 (function failures, see `docs/SPECIFICATION.md` "Functions"), 503 (`src/server.js:110,116,125`). Rationale for 502/504 on sandbox failures: the function pool is treated as an upstream | `test/http.test.js`, `test/http-policy.test.js`, `test/policy-throttle.test.js` |
| §15.5.9 408 on idle timeout (SHOULD) | partial | `src/server.js:152` `server.setTimeout(15000, socket => socket.destroy())` closes without a status; probed: an incomplete request head is dropped after ~15 s with no response bytes. Rationale: the socket is destroyed to free the slot; the requirement is a SHOULD | untested |
| §10.1.5 `User-Agent` | conforms | read-only matching in `src/policies/agents.js:202-213`; the header value is never logged | `test/policy-agents.test.js` "a bundled deny list refuses matching agents and logs the list name, never the header" |
| §10.2.3 `Retry-After` (delay-seconds) | conforms | `src/policies/throttle.js:100` integer seconds | `test/policy-throttle.test.js` "quota reached answers 429 with Retry-After and RateLimit headers" |
| §6.4.1 `Content-Length` on every non-bodyless response | conforms | `src/http-response.js:28`, error answers `:57` | `test/aws.test.js` (header comparison includes `content-length`); `test/policy-compression.test.js` (`content-length` equals encoded length) |

## 2. RFC 9111 HTTP Caching

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| §5.2.2 response directives `no-store`, `no-cache`, `public`, `private`, `max-age` | conforms | strategy table `src/policies/cache.js:63-82`: `no-store`→`no-store`, `revalidate`→`no-cache`, `public`→`public, max-age=N`, `private`→`private, max-age=N`; runtime default `cache-control: no-store` when a handler sets none (`src/http-response.js:30`), errors always `no-store` (`:48`); throttle and agents denials `no-store` (`src/policies/throttle.js:100`, `src/policies/agents.js:212`) | `test/policy-cache.test.js` "each strategy emits its catalogue headers; explicit fields override what the strategy implies" |
| §5.1 `Age` on a stored response | conforms | `src/policies/cache.js:112-117` replaces any `Age` with `floor((now-storedAt)/1000)` | `test/policy-cache.test.js` "swr serves fresh from the origin cache ..." |
| §3 storing: never store `Set-Cookie`, `private`, `no-store`, secret-bearing or oversized results | conforms | `src/policies/cache.js:208,224-225`; only statuses in `statuses` (default `200,301,302,404,410`, `:16`) | `test/policy-cache.test.js` "Set-Cookie, secret-bearing routes, handler no-store and oversized bodies are never stored" |
| §4.1 `Vary` in the cache key | conforms | key = route, path, query, declared `vary` header values (`src/policies/cache.js:102-105`); `Vary` emitted on storable statuses (`:217`) | `test/policy-cache.test.js` "vary headers separate keys and are emitted ..." |
| §4.3 validation requests never served from the origin cache | conforms | `src/policies/cache.js:119-124` bypasses for `If-None-Match`, `If-Modified-Since`, `If-Match`, `If-Unmodified-Since`, `Range` | `test/policies.test.js` "interoperability: conditional requests bypass origin hits ..." |
| §4.4 invalidation on unsafe methods | partial | only GET results are stored and only GET/HEAD looked up (`:121,145`); a POST to the same route does not invalidate an entry. Rationale: the store belongs to one runtime and is dropped on reload (`:263-269`); handlers are side-effect free by design | untested |
| §5.2.1 request directives (`no-cache`, `max-age=0`, `no-store`) honored by a cache | **partial** | the origin memory cache ignores request `Cache-Control` and `Pragma`. Probed: `GET /pub` with `Cache-Control: no-cache` and with `max-age=0` both served from memory with `age: 0`. Rationale (`src/policies/cache.js:4-11` comment, `docs/policies/cache.md` "Origin memory cache"): this is the origin's own micro-cache in the NGINX `proxy_cache` sense, part of the origin server rather than a shared cache in the RFC 9111 sense; a client cannot bypass it, as it cannot bypass an origin's internal memoization | untested |
| §4.2.4 serving stale | partial | stale served only within `stale-while-revalidate` and only once per entry (`:133`), never beyond; see §3 below | `test/policy-cache.test.js` "swr serves fresh ... serves stale once and refreshes on the next request" |
| `micro` strategy: `no-store` to clients, 1–5 s origin memory | conforms (origin-side) | `src/policies/cache.js:77-80`; the client-facing header is honest (`no-store`) while the origin memoizes | `test/policy-cache.test.js` "micro caches at the origin for one second while telling clients no-store" |
| Explicit YAML / handler `Cache-Control` beats the strategy | conforms | `src/policies/cache.js:93-94,208-214` | `test/policy-cache.test.js` "vary headers ... explicit YAML cache-control wins over the strategy" and "assets keep their handler cacheControl under an inherited policy ..." |

## 3. RFC 5861 stale-while-revalidate and stale-if-error

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| §3 `stale-while-revalidate=N` emitted | conforms | `src/policies/cache.js:73,75` | `test/policy-cache.test.js` "each strategy emits its catalogue headers" |
| §3 background revalidation at the origin cache | partial | a policy has no handle to the handler, so a stale hit is served once and flagged (`:133`); the next request refreshes synchronously; a failed refresh clears the flag (`:247-249`). Documented in `docs/policies/cache.md` "swr at the origin" | "swr serves fresh from the origin cache, serves stale once and refreshes on the next request"; "a failed fill releases waiters to the handler and never stores" |
| §4 `stale-if-error=N` emitted | conforms | `src/policies/cache.js:75` | "each strategy emits its catalogue headers" |
| §4 serving stale on error at the origin | partial | header-only: `onError` (`:241-250`) only releases waiters and clears the flag; it never returns a fallback result although the runtime would accept one (`src/runtime.js:163-167`). Documented in `docs/policies/cache.md` "sie limitation" | untested (no test asserts a 5xx is *not* replaced) |

## 4. RFC 8246 immutable

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| `immutable` extension emitted with a long `max-age` | conforms | `src/policies/cache.js:68-72`: `public, max-age=<maxAge ?? 31536000>, immutable`; refused unless the pattern has an 8+ hex-char segment or a digest-named parameter, or `force: true` (`:23-24,69-70`) | `test/policy-cache.test.js` "immutable is refused on unhashed paths and accepted with a hashed segment, a hash parameter or force" |
| Asset `cacheControl: public, max-age=31536000, immutable` | conforms | allowed literal in the schema; passed through at `src/assets.js:53,87` | `test/assets.test.js` "native page, download and static handlers ..." (cacheControl variants) |

## 5. RFC 9213 targeted cache control

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| `CDN-Cache-Control` as a Structured-Field dictionary | conforms | `cdn-only` emits `Cache-Control: no-store` plus `CDN-Cache-Control: max-age=N` (`src/policies/cache.js:81,213`); reserved from YAML/`set` only indirectly (not in `src/http-policy.js:7`; a YAML `CDN-Cache-Control` would be replaced by the strategy at `:212` unless YAML also sets `cache-control`) | `test/policy-cache.test.js` "each strategy emits its catalogue headers" |

## 6. RFC 6585 additional HTTP status codes

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| §4 429 Too Many Requests with an explanatory body | conforms | `src/policies/throttle.js:13,100-101`: `429`, `Too many requests\n`, `Retry-After`, `RateLimit*`; any 4xx/5xx `status` allowed with a matching short body | `test/policy-throttle.test.js` "quota reached answers 429 ..." and "status other than 429 gets a matching short body" |
| §5 431 Request Header Fields Too Large | **deviates** | `src/server.js:79` sets `maxHeaderSize: 16384`, but the custom `clientError` handler at `:155-157` writes `400 Bad Request` for every parse error. Node's default handler would send 431 for `HPE_HEADER_OVERFLOW` (and 408 for `ERR_HTTP_REQUEST_TIMEOUT`). Probed: a 20 000-byte header value → `400`. Rationale in code: one fixed minimal answer for any malformed head; no comment justifies losing 431 specifically | untested |

## 7. RFC 9112 HTTP/1.1 message syntax

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| §3.2.1 origin-form request target | conforms | `src/match.js:16-26` requires a leading `/`, rejects `//`, `#`, controls, `\`, length > 8192 | `test/http.test.js` "malformed and ambiguous URL encodings fail before routing" (`//evil.example`, `/%00` ...) |
| §3.2.2 absolute-form MUST be accepted by servers | **deviates** | `src/match.js:17` rejects anything not starting with `/`. Probed: `GET http://127.0.0.1:<port>/r HTTP/1.1` → `400 Invalid request target`. Rationale (`docs/CLOUDFLARE.md` "The request target"): the self-hosted server inspects the request line verbatim and shares `parseTarget` with runtimes that never see absolute-form; the Worker/Lambda paths reconstruct an origin-form target | untested |
| §3.2.4 asterisk-form for `OPTIONS *` | deviates (minor) | same check; probed `OPTIONS * HTTP/1.1` → 400. No route can be `*`, so no handler could answer it anyway | untested |
| §3 414 for over-long request targets | deviates | `src/match.js:17` throws `HttpError(400)` for targets over 8192 bytes; probed → `400 Invalid request target`. RFC 9112 §3: "MUST respond with a 414". Node's own limit (`maxHeaderSize`) would 431/400 earlier for the whole head | untested (test covers the 400 for other malformed targets only) |
| §3.2 missing `Host` → 400 | conforms | enforced by Node's parser; probed `GET /r HTTP/1.1` with no `Host` → 400 | untested |
| §6.1 `Content-Length` + `Transfer-Encoding` both present → reject | conforms | Node parser; probed → 400 | untested |
| §7 chunked request bodies | conforms | Node decodes; `src/server.js:38-53` counts decoded bytes against the limit and answers 413 | `test/http.test.js` "chunked oversized body returns 413 and server remains usable" |
| header field limits | conforms | `maxHeaderSize: 16384`, `headersTimeout: 10000`, `requestTimeout: 15000`, `keepAliveTimeout: 5000` (`src/server.js:79`), `maxRequestsPerSocket 1000`, `maxConnections 1024` (`:153-154`); response headers ≤ 16 KiB / 256 pairs (`src/http-policy.js:24,58`) | `test/http.test.js` "limits reject oversized requests and responses" |
| §9.3 `Connection: close` on error answers | conforms | `src/http-response.js:64`; `clientError` reply at `src/server.js:156` | untested |
| duplicate header fields | conforms | raw headers walked (`src/server.js:132-135`), counts passed to policy; duplicated scalar header parameters → 400 (`src/match.js:59`), duplicated `Content-Type` → 400 (`src/http-policy.js:41`), duplicate `X-Forwarded-For` ignored (`src/server.js:138`), duplicate `X-Request-Id` not trusted (`:87`) | `test/http.test.js` "header inputs are case insensitive and duplicate scalars fail" |
| HTTP/1.0 requests | conforms | Node answers with `Connection: close`; probed | untested |

## 8. RFC 3986 URI and percent-encoding

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| §2.1 `%HH` must be two hex digits, case-insensitive | conforms | `src/match.js:19` `/%(?![0-9a-f]{2})/i` → 400; probed `/r%41` → decoded to `/rA` (404, i.e. accepted and decoded) | `test/http.test.js` "malformed and ambiguous URL encodings fail before routing" (`/%ZZ`, `/ok?q=%`) |
| §2.2 encoded delimiters keep their encoding (`%2F` is not `/`) | conforms (stricter) | `%2F` and `%5C` in the path are refused with 400 rather than kept encoded (`src/match.js:19`), so an encoded slash can never span a segment. Rationale: `docs/ROUTING.md` "Encoded slashes ... are rejected" | same test (`/%2f`, `/%5c`) |
| decode exactly once | conforms | `decodeURIComponent` once on path and once on query at `src/match.js:21`; `%252F` stays `%2F` after one decode and is re-encoded into the redirect (`:78`) | same test (`/a%252Fb` → `.../a%252Fb`) |
| non-UTF-8 percent sequences | stricter than RFC 3986 | `/%ff` → 400 because `decodeURIComponent` requires UTF-8 (RFC 3987/WHATWG behavior); RFC 3986 itself permits arbitrary octets | same test (`/%ff`, `/ok?q=%ff`) |
| §5.2.4 dot segments | deviates (deliberate) | `.` and `..` segments are refused with 400 (`src/match.js:24`) rather than removed by `remove_dot_segments`; `%2e` decodes to `.` and is refused the same way. Rationale: `docs/SPECIFICATION.md` "Routes" — no normalization so a route key means exactly one path | same test (`/..`, `/%2e`); `test/assets.test.js` (`/assets/../urlcode.yaml`, `/assets/%2e%2e/urlcode.yaml` → 400) |
| §3.3 empty path segments | conforms | `//` at the start refused (`:17`, network-path ambiguity); internal empty segments only match a literal route containing them; `{param}` requires a non-empty segment (`:34`) | `test/http.test.js` (`//evil.example`) |
| §3.4 query | conforms | split on the first `?` (`:18`); parsed by `URLSearchParams`, which applies `application/x-www-form-urlencoded` rules (`+` = space), a WHATWG rule RFC 3986 does not define; the validity check at `:21` mirrors it | "typed inputs, defaults, arrays, mapping and passthrough" |
| §3.5 fragment never in a request target | conforms | `#` refused (`:17`) | untested directly |
| non-ASCII octets in the target | conforms | refused by Node's parser (probed raw `GET /caf\xe9` → 400) | untested |
| route keys | conforms | `src/router.js:24` forbids `?#%\` and whitespace/controls in route patterns; ≤ 2048 chars, ≤ 32 segments (`:26`) | `test/config.test.js` "semantic validation rejects ambiguous routes and unsafe redirects" |
| redirect URL validation | conforms | absolute `http(s)`, no userinfo, placeholders only in path segments, single-component `encodeURIComponent` (`src/router.js:91-109`, `src/match.js:78`); 16 KiB `Location` cap (`:88`) | `test/http.test.js` (`/p/hello%20world` → `.../hello%20world`); `test/config.test.js` |

## 9. RFC 7239 Forwarded and X-Forwarded-For

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| RFC 7239 `Forwarded` field | **not applicable** (not implemented) | no code reads `Forwarded`; only `x-forwarded-for` is read (`src/server.js:138`, `src/vercel.js:46`). `docs/SPIKE-EXTENSIONS.md:212` claims "RFC 7239 `Forwarded` is accepted from the same trusted set", which is false (see factual errors) | none |
| `X-Forwarded-For` (de-facto, no RFC) trusted only from configured proxies | conforms to common practice | `src/client-address.js:59-66`: peer must be in `--trusted-proxies`; walk from the right skipping trusted hops; all-trusted chain → leftmost; header ignored when absent or duplicated (`src/server.js:138` requires exactly one field) | `test/policies.test.js` "client identity trusts forwarded headers only from configured proxies" |
| malformed entries | partial, and mis-documented | entries that are not a bare IP are **filtered out and the walk continues** (`src/client-address.js:62`); the test proves `'garbage, 198.51.100.1'` → `198.51.100.1`. The comment at `src/client-address.js:58` and `docs/POLICIES.md:240` say "a malformed entry stops the walk at the peer", which is not what the code does. Consequence: RFC 7239-style `node:port` (`203.0.113.5:1234`) or `"[2001:db8::1]:443"` entries are dropped; probed `203.0.113.5:1234, 10.0.0.2` behind a trusted peer → client resolved as `10.0.0.2` (the proxy itself) | test proves the skip; the documented "stop at the peer" is untested because it is not implemented |
| bracketed IPv6 and IPv4-mapped peers | conforms | `normalizeAddress` strips `[...]` and `::ffff:` (`:68-75`) | same test (`::ffff:10.1.2.3` peer) |
| HSTS / origin never derived from `X-Forwarded-Proto`/`Host` | conforms | `src/policies/security.js:100` uses the operator origin; `src/server.js:151` | `test/policy-security.test.js` "HSTS follows the request origin scheme" (`x-forwarded-proto: https` does not enable it) |

## 10. RFC 9309 robots.txt

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| Serving or honoring `robots.txt` | **not applicable** | the runtime neither serves nor reads `robots.txt`; `docs/policies/agents.md:153-178` gives a `respond` recipe. That recipe is **invalid**: it puts `headers:` under `respond`, which the schema refuses (`schemas/urlcode.schema.json:605-617` has only `status`, `text`, `json`; probed: `Invalid configuration at /routes/~1robots.txt/respond (additionalProperties)`). `respond.text` already defaults to `text/plain; charset=utf-8` (`src/http-policy.js:33`), so the header is unnecessary | none |

## 11. RFC 6797 HSTS

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| §6.1 directive syntax `max-age=...; includeSubDomains` | conforms | `src/policies/security.js:20` `max-age=31536000; includeSubDomains` | `test/policy-security.test.js` "HSTS follows the request origin scheme" |
| §7.2 MUST NOT send STS over non-secure transport | conforms | emitted only when the configured origin is `https:` (`src/policies/security.js:100,111`); never inferred from forwarded headers | same test (plain origin → absent; `x-forwarded-proto` ignored; `origin: https://...` → present) |
| Worker | conforms | scheme from the request URL (`docs/policies/security.md` "Targets") | `test/policy-security.test.js` "the Worker emits the same security headers as the self-hosted server" |

## 12. RFC 1950/1952, RFC 7932, RFC 8878 content codings

| Coding | Status | Behavior | Test |
|---|---|---|---|
| `gzip` (RFC 1952) | conforms | `zlib.gzipSync` (`src/policies/compression.js:27`); dynamic level 6, stored 9 | `test/policy-compression.test.js` "declared text responses compress per Accept-Encoding ..." (round-trips with `gunzipSync`) |
| `deflate` = zlib container (RFC 1950 over RFC 1951), as RFC 9110 §8.4.1.1 defines the coding | conforms | `zlib.deflateSync` (`:28`) produces the zlib format, not raw deflate | untested end to end (only `decode.deflate` is defined in the test) |
| `br` (RFC 7932) | conforms | `zlib.brotliCompressSync` with `BROTLI_PARAM_QUALITY` and `SIZE_HINT` (`:25-26`); dynamic quality 4, stored 9 | same test (`brotliDecompressSync` round-trip) |
| `zstd` (RFC 8878) | conforms when available | `zlib.zstdCompressSync` (`:29-30`); refused at activation when Node lacks it (`:57`); available on the audited Node (probed) | "zstd is honoured only when node:zlib provides it; serverless targets delegate the policy" |
| request-body decompression | not implemented (documented) | `src/http-policy.js:42` → 415 for any non-identity `Content-Encoding`; `docs/HTTP.md` "no automatic decompression" | `test/http-policy.test.js` "request body policies reject size, media, encoding ..." |
| BREACH mitigation (not an RFC; CVE-2013-3587) | conforms to the documented rule | skip when the route holds secrets or the response sets a cookie unless `allowWithSecrets` (`src/policies/compression.js:146`) | "function JSON compresses with a weak ETag; Set-Cookie and secrets skip unless allowWithSecrets" |

## 13. RFC 6265 Set-Cookie

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| §3 one `Set-Cookie` header per cookie, never folded | conforms | cookies collected separately (`src/http-response.js:18`) and written as an array (`:36`); YAML `Set-Cookie` is the only list-valued header (`src/http-policy.js:15`); AWS format 2.0 `cookies` array (`src/aws.js`) | `test/http.test.js` "function Request/Response ABI, scoped bindings, cookies ..."; `test/aws.test.js` "cookies arrive through the format 2.0 array and leave through it" |
| §4.1.1 cookie syntax validation | partial | only the generic header rules apply (token name, no CTLs); no attribute parsing, signing or `Cookie` request parsing (`docs/HTTP.md` "Still outside this contract") | n/a |
| cookies vs caching/compression | conforms | responses with `Set-Cookie` are never stored (`src/policies/cache.js:225`) and not compressed by default (`src/policies/compression.js:146`) | `test/policy-cache.test.js` "Set-Cookie, secret-bearing routes ..."; `test/policy-compression.test.js` |

## 14. RFC 6266 / RFC 8187 Content-Disposition

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| `attachment; filename=...; filename*=UTF-8''...` | conforms | `content-disposition@3.0.0` `create()` at `src/assets.js:50`; filenames with separators or controls refused (`:49`) | `test/assets.test.js` "native page, download and static handlers ..." (`filename*=UTF-8''r%C3%A9sum%C3%A9.bin`) and "assets reject unsafe paths ... " (`bad\r\nname`) |

## 15. IETF httpapi RateLimit header fields (Internet-Draft)

The vocabulary is **draft-ietf-httpapi-ratelimit-headers**, an IETF
Internet-Draft of the HTTPAPI working group. It is not an RFC; its field
names and syntax have changed between revisions and may change again.

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| `RateLimit-Policy` as a Structured-Field list of items with `q` and `w` parameters | conforms to the current draft syntax | `src/policies/throttle.js:76` `"default";q=<quota>;w=<window>` | `test/policy-throttle.test.js` "quota reached answers 429 with Retry-After and RateLimit headers" (`'"default";q=2;w=60'`) |
| `RateLimit` item with `r` (remaining) and `t` (seconds to reset) | conforms | `:76` `"default";r=<remaining>;t=<reset>`; `t` from the sliding-window end (`:72`) | same test (`/^"default";r=1;t=\d+$/`) |
| present on allowed and refused responses | conforms | request phase attaches the budget (`:97`), response phase writes it (`:104-107`); refusals carry it directly (`:100-101`) | same test; `test/policies.test.js` "... 405 carries policy headers" |
| `pk` (partition key) parameter | not emitted | keys are internal (`:44-50`) | n/a |
| refused requests not counted | conforms to the draft's guidance | `:89-91` | "window slides: the previous window fades out instead of resetting at once" |

## 16. web-bot-auth drafts

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| HTTP Message Signatures for bots (IETF `web-bot-auth` drafts) | **not applicable** | named in `docs/policies/agents.md:66-69` as future plugin territory; no code | none |

## 17. OWASP Secure Headers Project

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| OSHP "best practices" values | conforms to the pinned table | `src/policies/security.js:19-29`, pinned as `oshpRevision = 'OSHP 2024 best practices'` (`:13`); docs table generated from the same constant; `X-Content-Type-Options: nosniff` supplied by the runtime on every response (`src/http-response.js:29,48`) rather than the profile. The upstream JSON could not be fetched from the audit environment (proxy 403), so the table is verified against the code and docs, not re-verified against owasp.org | `test/policy-security.test.js` "profile tables are frozen, ordered and consistent with each other", "profile headers land on redirects, declared responses and function results; existing headers win" |
| fill-gaps semantics; `set`/`unset` | conforms | `src/policies/security.js:98-116` | "set overrides the profile and existing headers; unset drops a profile header" |
| applied to errors and early denials | conforms | `src/runtime.js:80-83,142`; `src/http-response.js:46-58` | `test/policies.test.js` "error responses carry the security headers of the matched route or the project"; `test/policy-security.test.js` "early results that skip the handler still carry the profile" |
| `X-Frame-Options` (RFC 7034, informational) `deny` | conforms | `:21` | as above |

## 18. Content Security Policy Level 3

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| CSP3 serialized policy syntax | conforms | `default-src 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests; block-all-mixed-content` (`src/policies/security.js:24`) | `test/policy-security.test.js` (value equality with the frozen table) |
| `block-all-mixed-content` | partial | this directive is obsolete in CSP3 / the current Mixed Content specification and is ignored by current browsers; it is emitted because OSHP recommends it. Harmless, but not a Level 3 directive | n/a |
| `upgrade-insecure-requests` | conforms | defined by the W3C Upgrade Insecure Requests specification, delivered through CSP; emitted regardless of scheme (browsers ignore it on plain HTTP) | n/a |
| Report-only and `report-to` | conforms (operator-supplied) | any `Content-Security-Policy-Report-Only` value is passed verbatim through `set` (`docs/policies/security.md`); the runtime does not host a reporting endpoint | "set overrides the profile ..." |

## 19. JSON Schema 2020-12

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| project schema dialect | conforms | `schemas/urlcode.schema.json:2` `$schema: https://json-schema.org/draft/2020-12/schema`; compiled by `ajv/dist/2020.js` (Ajv 8.20.0, `package.json:60`) at `src/config.js:6,10` with `strict: true`, `allowUnionTypes: true`, `allErrors: false` | `test/config.test.js` "strict schema rejects unknown features and multiple handlers"; `test/policies.test.js` "policies validate in YAML and unknown keys fail" |
| input parameter schemas (subset: `type`, `enum`, `default`, `minLength`/`maxLength`, `minimum`/`maximum`, `items`, `maxItems`) | conforms | `src/router.js:14-22` compiles each distinct schema with Ajv 2020 (`strict: false`, `:44`); `default` is stripped before compiling because 2020-12 treats it as an annotation (`:15`); semantic cross-checks at `:63-71`; unsupported keywords (`pattern`, `format`, nested objects) are refused by the project schema, not silently ignored | `test/http.test.js` "typed inputs, defaults, arrays, mapping and passthrough" |
| standalone validators for the Worker | conforms | precompiled by the build into ES modules (`docs/CLOUDFLARE.md` "validators.js") | `test/cloudflare.test.js` "the generated Worker entry and validators carry no imports the platform cannot resolve" |
| bounded compilation | conforms | ≤ 1024 distinct schemas per snapshot (`src/router.js:18`) | untested |

## 20. YAML 1.2

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| YAML 1.2 core schema, JSON-compatible profile | conforms | `yaml@2.9.1` (`package.json:65`) `parseDocument(text, { version: '1.2', uniqueKeys: false, strict: true })` at `src/config.js:14`; parser errors and warnings fail (`:15`) | `test/config.test.js` "YAML rejects ambiguity and nonportable constructs" |
| no aliases, anchors, tags, merge keys, multiple documents | conforms (deliberate subset) | `:17` (aliases/anchors/tags), `:37` (`<<` and prototype keys), multi-document rejected by the parser in strict mode, `maxAliasCount: 0` (`:30`) | same test (`&x`/`*x`, `!custom`, `!!str`, `---`, `<<`) |
| string keys only, unique keys | conforms | `:22-25` (linear duplicate check, documented at `:20-21`) | same test (`x: 1\nx: 2`) |
| scalars: string, finite number, boolean, null | conforms | `:28`, `:33` (`.inf`/`.nan` refused) | same test (`.inf`, `.NaN`) |
| YAML 1.2 boolean semantics (`yes`/`no` are strings) | conforms | follows from `version: '1.2'` | untested |
| resource bounds | conforms | 32 MiB per file, 64 MiB aggregate, 40 nesting levels, worker with heap and wall-clock limits (`src/config.js:11,31,52,84-105`) | "configuration worker deadline terminates loading and releases admission"; "configuration worker enforces aggregate source budget across includes" |

## 21. CIDR notation for `--trusted-proxies`

| Requirement | Status | Behavior | Test |
|---|---|---|---|
| `address[/prefix]` for IPv4 and IPv6 (RFC 4632 / RFC 4291 §2.3 notation) | conforms | `src/client-address.js:25-32`; prefix defaults to the full length; prefix range checked; ≤ 256 ranges (`:36`); comma-separated string or array (`:35`) | `test/policies.test.js` "client identity trusts forwarded headers only from configured proxies" (`10.0.0.0/8, ::1, 192.168.1.5`; `/33` refused) |
| host bits set beyond the prefix | lenient | `10.1.2.3/8` accepted and masked at match time (`:40-50`); probed | untested |
| IPv4-mapped IPv6 (`::ffff:a.b.c.d`) | conforms | `:15-16`, `:72-73` | same test (`::ffff:10.1.2.3`) |
| other IPv4-embedded IPv6 forms (`64:ff9b::1.2.3.4`, RFC 4291 §2.2 form 3) | **deviates** | `toBytes` splits on `:` and `parseInt`s each group as hex, so `1.2.3.4` becomes group value `1`; probed: `64:ff9b::1.2.3.4/96` → last group `0x0001` instead of `0x0102 0x0304`. Only `::ffff:` is special-cased | untested |
| zone identifiers (`fe80::1%eth0`) | accidental | `net.isIP` accepts them (probed → 6); `parseInt('1%eth0', 16)` yields `1`, so the zone is silently ignored | untested |

## Gaps, ranked

1. **HEAD `Content-Length: 0` on `respond`, function and middleware results** (RFC 9110 §8.6 MUST NOT; §1). Fix: in `src/http-response.js:28` compute the length from `result.body` before it is dropped for HEAD — e.g. `const declared = result.contentLength ?? (result.body?.length ?? 0);` then `if (!bodyless) headers.push(['content-length', String(declared)])`. `docs/policies/compression.md:131-132` already describes the intended behavior ("reports the identity length"). Test: extend `test/http-policy.test.js` "declarative text, JSON and empty responses use correct bodies and statuses" to assert HEAD `content-length` equals GET's for `/fn` and `/json`; the Cloudflare and AWS parity tests then cover the adapters.
2. **431 and 408 collapsed into 400** (RFC 6585 §5; RFC 9110 §15.5.9; §6, §7). Fix: in `src/server.js:155-157` branch on `error.code`: `HPE_HEADER_OVERFLOW` → `431`, `ERR_HTTP_REQUEST_TIMEOUT` → `408`, else `400`; keep `Connection: close` and `Content-Length: 0`. Test: add to `test/http.test.js` "limits reject oversized requests and responses" a raw-socket request with a 20 KiB header expecting `431`.
3. **`X-Forwarded-For` malformed-entry semantics are mis-documented and `node:port` entries are dropped** (§9). Fix (documentation, minimal): change `docs/POLICIES.md:240` and the comment at `src/client-address.js:58` to "a malformed entry is skipped". Fix (behavior, optional): in `normalizeAddress` strip a trailing `:port` from IPv4 and `[v6]:port` forms before `isIP`. Test: extend `test/policies.test.js` "client identity trusts forwarded headers only from configured proxies" with `'203.0.113.5:1234, 10.0.0.2'`.
4. **absolute-form and asterisk-form request targets answered 400** (RFC 9112 §3.2.2 MUST accept; §7). Fix: in `src/server.js:137` (and `requestLimit` at `src/runtime.js:85`) rewrite `req.url` when it matches `/^https?:\/\/[^/?#]*(\/.*)?$/i` to its path-and-query part (or `/` when empty) before `parseTarget`; leave `*` as 400 or answer `OPTIONS *` with 405 + `Allow`. Test: raw-socket request in `test/http.test.js` expecting the same answer as origin-form.
5. **414 for over-long targets answered 400** (RFC 9112 §3; §7). Fix: `src/match.js:17` split the length check into its own `throw new HttpError(414, 'URI too long')`. Test: `test/http.test.js` "malformed and ambiguous URL encodings fail before routing" add a 9000-byte path expecting 414.
6. **origin memory cache ignores request `Cache-Control: no-cache` / `max-age=0`** (RFC 9111 §5.2.1; §2). Either document it explicitly in `docs/policies/cache.md` "Origin memory cache" ("request cache directives are not honored: the store is part of the origin"), or add `'cache-control'` to the bypass at `src/policies/cache.js:119-124` when it contains `no-cache` or `no-store`. Test: add a request with `cache-control: no-cache` to `test/policy-cache.test.js` "swr serves fresh from the origin cache ..." asserting the chosen behavior.
7. **IPv4-embedded IPv6 CIDRs other than `::ffff:`** (§21). Fix: in `toBytes` (`src/client-address.js:17-22`), if the last group contains `.` convert it to two 16-bit groups. Test: `parseCidr('64:ff9b::1.2.3.4/96')` bytes in `test/policies.test.js`.
8. **`stale-if-error` is header-only** (RFC 5861 §4; §3): documented; `onError` could return `served(entry, age)` when an entry exists within `staleIfError` — the runtime already accepts a fallback (`src/runtime.js:163-167`). Test: a function that throws after a first successful fill.
9. **Untested conformance points** that hold today but have no guard: 304 omits `Content-Length` (assets and `revalidate`); `deflate` end-to-end round-trip; missing `Host` → 400; CL+TE → 400; `Connection: close` on error answers; YAML 1.2 `yes`/`no` as strings; ≤ 1024 input schemas. Each is one assertion in the test named in its row.
10. **`block-all-mixed-content`** in the OSHP CSP (§18): obsolete but harmless; keep while the pinned OSHP revision recommends it, and note it in `docs/policies/security.md` next to the CSP paragraph.

## Factual errors in existing documentation

- `docs/policies/agents.md:163-175`: the `robots.txt` recipe puts `headers:` under `respond:`; the schema refuses it. Remove the `headers:` line (the default content type is already `text/plain; charset=utf-8`), or move it to `response: { headers: { ... } }` beside `respond`.
- `docs/policies/compression.md:131-132`: "A dynamic body is not compressed for `HEAD` ... and reports the identity length" — it currently reports `content-length: 0` (gap 1). Until fixed, the sentence should read "reports no usable length (`Content-Length: 0`)"; after the fix the sentence is correct.
- `docs/POLICIES.md:240` and the comment at `src/client-address.js:58`: "a malformed entry stops the walk at the peer" — the code skips the entry and continues (proven by the test). Should read "a malformed entry is skipped".
- `docs/SPIKE-EXTENSIONS.md:212`: "RFC 7239 `Forwarded` is accepted from the same trusted set" — nothing reads `Forwarded`. Should read "only `X-Forwarded-For` is read; RFC 7239 `Forwarded` is not parsed".

## How to keep this current

- Any change to `src/http-response.js` (what a response *is*) must extend `test/http-policy.test.js` "declarative text, JSON and empty responses ..." and rerun the parity tests (`test/aws.test.js` "a Lambda response carries exactly ...", `test/cloudflare.test.js` "the Worker runtime answers exactly ..."), then update §1 here.
- Any change to `src/match.js` `parseTarget` or `src/router.js` `segments` must extend `test/http.test.js` "malformed and ambiguous URL encodings fail before routing" and update §7–§8.
- Any change to `src/assets.js` conditional or range logic must extend `test/assets.test.js` "asset conditions, byte ranges, empty files and HEAD obey HTTP ordering" and update §1 (validators, ranges).
- A new cache strategy or directive touches `src/policies/cache.js:63-82` and `test/policy-cache.test.js` "each strategy emits its catalogue headers"; update §2–§5.
- A new content coding touches the `codecs` table in `src/policies/compression.js:24-31` and `test/policy-compression.test.js` (round-trip decode table at the top of the file); update §12.
- A change to the OSHP table bumps `oshpRevision` in `src/policies/security.js:13`, regenerates the docs table, and must keep `test/policy-security.test.js` "profile tables are frozen, ordered and consistent" passing; update §17–§18.
- A change to the RateLimit field syntax (when the draft moves) touches `src/policies/throttle.js:75-77` and the header regexes in `test/policy-throttle.test.js`; update §15 with the draft revision.
- A change to `--trusted-proxies` parsing touches `src/client-address.js` and `test/policies.test.js` "client identity trusts forwarded headers only from configured proxies"; update §9 and §21.
- A change to the YAML profile or schema dialect touches `src/config.js:10-42`, `test/config.test.js` "YAML rejects ambiguity ..." and "strict schema rejects unknown features ..."; update §19–§20.
- When a gap above is closed, delete its row from the ranked list and flip the row status in the table; when a new standard is touched, add a section with the same four columns (requirement, status, behavior with `file:line`, test name).
