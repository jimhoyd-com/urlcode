# The `agents` policy

Denies or reports requests by their `User-Agent`, before anything else runs.
It is the cheapest refusal in the request chain (`agents`, then `throttle`,
then the cache lookup), so a denied crawler never counts against a quota,
never reaches the sandbox and never fills the origin cache.

```yaml
version: "1"
policies:                        # project defaults, or per route under routes.<pattern>.policies
  agents:
    deny: [ai-crawlers]          # bundled list names, or project-relative .json files
    allow: [monitoring]          # allow always wins over deny
    denyPatterns: ["^curl/"]     # linear-time regex subset, matched case-insensitively
    allowPatterns: ["^Mozilla/5\\.0 \\(compatible; Googlebot"]
    denyEmpty: false             # deny a missing or blank User-Agent
    status: 403                  # 400-599
    mode: enforce                # enforce | report
```

The `hardened` profile sets `deny: [ai-crawlers]` with status 403. A route can
override any key, or set `agents: false` to switch the policy off for itself.

## Semantics

- Matching is against the `User-Agent` request header only and is
  case-insensitive. Nothing else about the request (address, path, other
  headers) takes part.
- Evaluation order: if any `allow` list or `allowPatterns` entry matches, the
  request passes and nothing is logged. Otherwise the first `deny` list (in
  the order written) or `denyPatterns` entry that matches denies it.
- `denyEmpty: true` denies a request with no `User-Agent`, or one that is only
  whitespace. Allow rules cannot match an empty header, so this always wins
  for empty headers.
- A denial answers `status` (default 403) with `content-type:
  text/plain; charset=utf-8`, `cache-control: no-store` and the body
  `Forbidden\n`. Response policies that also run at request time (cache,
  compression) are skipped on the early response; `security` headers are
  still applied.
- Every denial is logged as `{ event: 'agents', route, list, outcome }`, where
  `list` is the list name, the file path as written in YAML, `pattern` for
  `denyPatterns`, or `empty` for `denyEmpty`. The raw header value is never
  logged: a `User-Agent` is attacker-controlled text.
- `mode: report` logs the same event with `outcome: 'reported'` and never
  denies. Run a new deny list in report mode for a release, read the log, then
  switch to `enforce`.

## Allow before deny

Broad deny lists without an explicit allow are the most common self-inflicted
outage in this space. `crawlers` contains every search engine; `ai-crawlers`
contains agents some operators want (for example `ChatGPT-User` or
`Applebot-Extended` when a site chooses to appear in AI search). Keep an
explicit `allow` or `allowPatterns` entry for the agents you depend on, and
anchor it: `^Mozilla/5\.0 \(compatible; Googlebot` cannot be satisfied by a
`Googlebot` token dropped in the middle of an unrelated string.

Matching is string matching. A client can claim any `User-Agent`, and the
genuine search crawlers publish the way to check a claim (reverse DNS for
Googlebot, bingbot and Applebot; the IETF `web-bot-auth` HTTP Message
Signature drafts for newer agents). That verification needs network calls and
vendor data, so it belongs in a [host plugin](../SPIKE-EXTENSIONS.md) that
runs after this policy, not in the runtime.

## Bundled lists

| Name | Contents | Upstream | Licence | Refresh |
| --- | --- | --- | --- | --- |
| `ai-crawlers` | every agent in `robots.json` (AI training, AI search and assistant crawlers) | [ai-robots-txt/ai.robots.txt](https://github.com/ai-robots-txt/ai.robots.txt) | MIT | pinned tag in `scripts/sync-agent-lists.js` |
| `crawlers` | every crawler, bot and automated client in `crawler-user-agents.json` | [monperrus/crawler-user-agents](https://github.com/monperrus/crawler-user-agents) | MIT (revisions after 2016-11-07 only) | same |
| `seo` | `crawlers` entries tagged `seo` (backlink and rank trackers such as AhrefsBot, SemrushBot, MJ12bot) | derived from crawler-user-agents | MIT | same |
| `monitoring` | `crawlers` entries tagged `monitoring` (UptimeRobot, Pingdom, StatusCake, ...) | derived from crawler-user-agents | MIT | same |

Each list lives in `data/agents/<name>.json` as
`{ name, description, source: { repository, url, license, tag, commit, file, fetchedAt }, entries }`
with one entry per pattern: `{ name, pattern, source, sourceRevision, addedAt }`.
The generated `data/agents/index.js` mirrors the `[name, pattern]` pairs so the
policy module (which also runs inside the Cloudflare Worker) needs no
filesystem. The upstream licences are reproduced verbatim under
`data/agents/LICENSES/` and named in `NOTICE`, as Apache-2.0 section 4(d)
requires. `urlcode audit` and the runtime's policy inventory report the list
names, pattern counts and the pinned revision each list was built from, so a
deploy carries a known list version and a rollback rolls the list back too.

### Refreshing

```sh
node scripts/sync-agent-lists.js            # fetch pinned upstreams, validate, write data/agents/
node scripts/sync-agent-lists.js --check    # exit 1 when the committed files are stale
```

The script fetches each upstream at the tag and commit pinned in its `sources`
table, normalises entries to the schema above (an ai.robots.txt agent name
becomes an escaped literal pattern; a crawler-user-agents pattern is kept and
named by its literal prefix), validates every pattern against the subset below
(rewriting `{n,}` to `{n,64}`, and dropping and printing anything else),
preserves `addedAt` from the previous file or the upstream `addition_date`, and
writes the JSON lists, the index and the licence copies. To move to a newer
upstream release, change the `tag` and `commit` pins and rerun; the revision
appears in every entry and in the audit output. Refresh through an ordinary
pull request so the list diff is reviewed like code. Behind an HTTPS proxy,
set `NODE_USE_ENV_PROXY=1` so `fetch` honours `HTTPS_PROXY` and
`NODE_EXTRA_CA_CERTS`.

## Project lists

`deny` and `allow` also accept a project-relative path ending in `.json`:

```yaml
policies:
  agents:
    deny: [agents/deny.json]
```

The file is either an array of entries or `{ "entries": [...] }`, each entry
`{ "name": "curl", "pattern": "^curl/" }` (`name` optional; the other fields
of the bundled schema are ignored). It must stay inside the project, hold at
most 4096 entries and pass the same pattern validation as YAML patterns. The
log names the path as written. The file is read once at activation; the
Cloudflare build embeds its entries in the artifact so the Worker never reads a
file.

## The pattern subset

Patterns in `denyPatterns`, `allowPatterns` and every list file are validated
at activation. A pattern outside the subset fails activation with a
`ConfigError` naming the route, the key and the reason, so a project cannot
turn the matcher into a denial-of-service vector by editing YAML. Allowed:

- anchors `^` and `$`; literals; `.`
- escapes: `\d \w \s \D \W \S \b \B \t \n \r \f \v \0`, `\xHH`, `\uHHHH`, and
  a backslash before any punctuation (`\.`, `\/`, `\(`, `\-`, ...)
- character classes `[...]` and `[^...]` with ranges and the escapes above
- groups `(...)` and `(?:...)`, and alternation `|`
- quantifiers `*`, `+`, `?`, `{n}` and `{n,m}` with `m <= 64`, on a single
  atom (a literal, escape, class or `.`); `?` may also follow a group that
  contains no quantifier, for optional words such as `(?:bot)?`
- at most 256 bytes

Rejected: backreferences (`\1`, `\k<name>`), lookahead and lookbehind, named
groups, unicode property escapes, `\c` control escapes, nested character
classes, `{n,}` and bounds above 64, lazy or stacked quantifiers (`+?`, `**`),
quantifiers on anchors, and `*`, `+` or `{n,m}` on a group (so `(a+)+` and
`(ab)*` fail). Each list is compiled into one alternated `RegExp` with the `i`
flag, so a request costs one pass per list rather than one per pattern.

## robots.txt

Denying an agent is not the same as asking it to stay away. Well-behaved
crawlers read `/robots.txt` (RFC 9309) before fetching anything, and the AI
crawlers in `ai-crawlers` are the ones that upstream tracks as respecting or
ignoring it. Serve one as an ordinary `respond` route; the agent names in
`data/agents/ai-crawlers.json` are the tokens to list:

```yaml
routes:
  /robots.txt:
    respond:
      status: 200
      headers: { content-type: text/plain; charset=utf-8 }
      text: |
        User-agent: GPTBot
        User-agent: ClaudeBot
        User-agent: CCBot
        Disallow: /

        User-agent: *
        Allow: /
```

The `agents` policy then enforces the same decision for clients that ignore
the file.

## Targets

| Target | Support |
| --- | --- |
| self-hosted (`urlcode serve`) | native |
| Vercel, AWS | native |
| Cloudflare | compiled: the build validates the policy, embeds the effective configuration (and any project list entries) in the artifact, and the Worker compiles it at startup without filesystem access |
