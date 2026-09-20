# URLCode A/B Blog Benchmark — 2026-09-20

URLCode commit at start: `181dcda` (packages used by B: @jimhoyd/urlcode). Both agents: Sonnet, default effort (Medium thinking could NOT be set via the Agent tool — deviation). Single run each: n=1, no variance estimate.

## Raw results (see raw/, acceptance/)
- raw/agent-{a,b}-usage.json, raw/agent-{a,b}-transcript.jsonl, acceptance/run.mjs + result-{A,B}.json
- Telemetry available: total tokens, tool uses, wall time only. NOT available: input/output/cached split, tokens-to-first-run, tokens on docs vs debugging. Left blank rather than estimated.
- Human interventions: 0 for both. Agent A's REPORT.md write was refused by the tool; its report text was returned in chat and is not saved as a file.
- Agent B used no Skill tool calls (transcript: 27 Bash + 1 Read).

## Side by side
| Metric | A — Control (Express + node:sqlite) | B — URLCode (version pinned in agent-b-urlcode/app/package.json) |
|---|---:|---:|
| Total tokens | 58,773 | 125,443 |
| Input / output / cached | n/a | n/a |
| Tokens to first run / completion | n/a | n/a |
| Tool calls | 7 | 28 |
| Wall time | 226.6 s | 261.7 s |
| Failed commands, debug cycles | not measured | not measured |
| Documentation reads | 0 | not measured (transcript has 1 Read; rest via shell) |
| Own tests (agent-reported, re-run by me) | 12 / 12 pass | 8 / 8 pass + 18 URLCode fixtures pass |
| Independent acceptance (25 checks) | 25 PASS | 25 PASS |
| Total LOC (excl. lockfile) | 447 | 439 (incl. 110-line fixtures JSON) |
| Application LOC | 254 | 208 (74 YAML + 134 JS) |
| Test LOC | 175 | 97 (+110 fixtures JSON) |
| Config LOC | 18 | 24 |
| JS LOC | 429 | 231 |
| YAML LOC | 0 | 74 |
| Files | 8 | 7 |
| Prod / dev deps | 1 / 0 | 2 / 0 |
| Routes | 10 | 10 (+ generated /robots.txt) |
| `urlcode audit` | n/a | FAILS route-coverage gate (`uncovered-route-methods`) |

Formulas (informational, n=1):
- Token reduction: (58,773 − 125,443)/58,773 = **−113%** (URLCode used ~2.1× the tokens).
- Application code reduction: (254 − 208)/254 = **18%**.
- Token efficiency (25 passing checks): A 2,351; B 5,018 tokens per check.
- Implementation density: A 0.098; B 0.120 checks per app LOC.
- Escape rate: 134 custom JS / 208 app LOC = **64%**.
- Caveat: "requirements" here are my 25 black-box checks, not a formal list, so the two efficiency numbers are only comparable to each other.

## Independent evaluation
Ran acceptance/run.mjs (real HTTP, spawn, restart) against both: 25/25 each — start, empty index, create, invalid title/slug rejected, publish/unpublish, public visibility, newest-first, post page, 404s, edit + invalid edit, restart persistence, delete, XSS escaping, viewport meta. (My first run had a script bug — it treated `/admin/posts/new` as a post id — fixed and re-run; both then passed.) Not tested by me: mobile rendering visually, concurrent writes, CSRF (neither implements it).

Qualitative:
- A: conventional, tiny, readable; SQLite gives atomic writes; validation and escaping in dedicated modules; unique-slug enforced. No CSRF, no CSP headers.
- B: declarative routing, method restriction (405), body limits/content-type checks, security-header policy and robots come from YAML. Persistence, validation and all HTML are still hand-written JS, so the framework removed routing/headers plumbing but not the application. JSON-file store is simpler than SQLite but not concurrency-safe. Every route carries a `sandboxReason` line (6+ near-identical lines). No CSRF.

## Headline
In this run URLCode did NOT reduce tokens (≈2.1× more) and reduced application LOC only ~18%; 64% of its application code was still imperative JS. What it did remove: routing, method/body validation, security headers, robots, and it added built-in fixtures. Persistence/CRUD and dynamic HTML remain fully custom.

## Trajectory analysis (from Agent B's own report; transcript-level token attribution unavailable)
| # | Finding | Class | Evidence | Suggested improvement |
|---|---|---|---|---|
| 1 | No CRUD/persistence handler or recipe; store + validation hand-written | Framework capability gap / Recipe gap | REPORT: "core has no storage or CRUD handler" | Recipe for file-backed collection first; longer term a `collection`/`store` handler with declared fields, required, slug format, timestamps |
| 2 | No data-driven templating; all HTML in JS | Declarative model gap | blog.mjs 65 lines of string templates | `page`/`template` handler bound to a store query (list, item, 404) |
| 3 | Stateful multi-step / restart tests inexpressible in fixtures | Declarative model gap (known #256) | hand-written 97-line test file | Multi-step fixtures + restart step |
| 4 | `urlcode audit` fails gate for any stateful function app; agent left it failing | CLI/validation gap | `uncovered-route-methods` | Allow declaring fixtures needing setup, or exempt with reason |
| 5 | Stock `oshp` CSP blocks UI-kit inline styles; upgrade-insecure-requests breaks http localhost | Bug / DX problem | had to use `oshp-no-csp` + custom CSP | Make UI kit CSP-compatible or ship a matching preset; local-dev variant |
| 6 | `site.robots` error was only "additionalProperties" | Error-message gap | had to run `urlcode schema site.robots` | Path-specific errors with example |
| 7 | Long function form has no per-method map → hand-written `editOrUpdate` dispatcher | Framework gap / Excessive custom code | yaml `/admin/posts/{id}` | Per-method handler map per route |
| 8 | Repeated `sandboxReason` on trusted functions | Excessive configuration | 6+ identical lines | Project-level default trust reason |
| 9 | UI kit `field` lacks textarea | Framework capability gap | hand-written textarea | Add textarea/select field |
| 10 | `--expect-routes` counts generated robots route; `urlcode test` noisy JSON lines on pass | Naming/DX | REPORT | Document/adjust counts; quiet flag (may already exist in 0.4.x — repo history mentions quiet default; verify) |

Discoverability failures (capability existed but wasn't found): none evidenced. Agent B did not report missing something that existed; #10's quiet flag should be checked against the release.

## Prioritized backlog (proposed; nothing filed)
1. **Persistent collection handler + recipe** (findings 1,2,7). Problem: CRUD blogs need ~134 JS lines. Root cause: no storage/template primitives. Solution: declarative `collection` with fields/validation/slug/timestamps, plus list/item page templates. Benefit: could cut custom JS well below 50% and the largest share of B's tokens (est. only; unmeasured). Difficulty: high. Issue: "Add declarative collection store handler with validation and timestamps". Interim (low): "Add file-backed CRUD recipe to docs".
2. **Multi-step and restart fixtures** (3,4). Difficulty: medium. Issue: "Support stateful multi-step fixtures and restart steps; let audit accept them" (relates to #256).
3. **CSP/UI-kit compatibility** (5). Difficulty: low. Issue: "Ship CSP preset that permits UI-kit styles; localhost-safe variant".
4. **Per-method function map** (7). Difficulty: medium. Issue: "Allow per-method handlers on one route".
5. **Error messages** (6): "Path-specific validation errors for site.* keys". Low.
6. **Config verbosity** (8): "Project-level default sandboxReason". Low.
7. **UI kit textarea** (9). Low.
8. **Reporting tooling**: "Expose per-run token telemetry / doc-read counts in agent harness" — belongs to the benchmark, not URLCode.

## Limitations / repeatability
- n=1 per arm; token counts vary run to run. Repeat ≥3 times before drawing conclusions.
- Effort setting not controlled. Tokens-per-phase not measured. Failed-command counts not extracted from transcripts (raw/*.jsonl available for later parsing).
- Rerun: launch two agents with SPEC.md as in this session, then `node acceptance/run.mjs A|B`.

## Issue follow-up (2026-09-20)
Checked all issues, open and closed. Filed: #287 (UI kit inline CSS vs oshp), #288 (UI kit textarea), #289 (site.robots error message), #290 (--expect-routes counts robots). Already tracked: #253 (store/CRUD), #262 (data-bound UI), #256 (multi-step fixtures), #264 (audit coverage), #257 (repeated sandboxReason), #255 (per-method bindings, closed 14:06 UTC on the run date; unknown whether the pinned release includes it). The `upgrade-insecure-requests` complaint was not filed: docs/STANDARDS.md says browsers ignore it on plain HTTP.
