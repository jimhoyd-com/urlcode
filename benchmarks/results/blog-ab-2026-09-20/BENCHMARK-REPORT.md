# URLCode A/B Blog Benchmark — 2026-09-20

URLCode commit at start: `181dcda` (packages used by B: @jimhoyd/urlcode). Both agents: Sonnet, default effort (Medium thinking could NOT be set via the Agent tool — deviation). Single run each: n=1, no variance estimate.

## Raw results (see raw/, acceptance/)
- raw/agent-{a,b}-usage.json, raw/agent-{a,b}-transcript.jsonl, acceptance/run.mjs + result-{A,B}.json
- Telemetry recorded at run time: total tokens, tool uses, wall time only. The split, tokens-to-first-run, failed commands and doc reads were left blank rather than estimated, then **derived afterwards from `raw/*-transcript.jsonl`** with `benchmarks/ab/summarize.ts` (2026-09-20, no model launched, nothing re-measured; output in `derived/measurements.json`). Rows marked "derived" below come from that; the harness "Total tokens" row is the harness's own figure and is a different quantity (see the note under the table).
- Human interventions: 0 for both. Agent A's REPORT.md write was refused by the tool; its report text was returned in chat and is not saved as a file.
- Agent B used no Skill tool calls (transcript: 27 Bash + 1 Read).

## Side by side
| Metric | A — Control (Express + node:sqlite) | B — URLCode (version pinned in agent-b-urlcode/app/package.json) |
|---|---:|---:|
| Total tokens | 58,773 | 125,443 |
| Input / output (derived) | 16 / 12,435 | 52 / 22,648 |
| Cache-creation / cache-read (derived) | 57,775 / 355,666 | 94,530 / 2,254,374 |
| Cumulative tokens, all four (derived) | 425,892 | 2,371,604 |
| Tokens to first successful run (derived)¹ | 141,827 | 1,435,560 |
| Tool calls | 7 | 28 |
| Wall time | 226.6 s | 261.7 s |
| Failed commands (derived) | 0 | 2 (both are `urlcode audit` runs failing the route-coverage gate) |
| Documentation reads (derived)² | 0 | 14 tool calls |
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

¹ Cumulative four-way token sum through the API call that issued the first successful run command (first clean-exit server start, test run or curl), by a command-pattern heuristic; for B that is call 21, the first start of the app, so it includes all the doc reading and writing before it. ² Tool calls that read a path under `docs/`, `llms*.txt`, `schemas/` or `recipes/`, including reads made after `cd`-ing into one of those directories.

**The two token rows are not the same quantity.** The harness "Total tokens" figure (58,773 / 125,443) is roughly the size of each agent's final context, not what it spent. Cumulative tokens across every API call (cache reads included) are 425,892 vs 2,371,604, a 5.6x ratio rather than the 2.1x below. Cache reads dominate (85% of A, 95% of B) and are billed at a fraction of normal input, so cost is closer than the token ratio; this report does not compute cost. The formulas below still use the harness figures, as first published.

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
- Effort setting not controlled. Tokens-per-phase not measured. Failed commands, doc reads and the input/output/cache split were extracted afterwards from the transcripts (rows marked derived); tokens-per-phase are still not measured.
- Rerun: `benchmarks/ab/run --task benchmarks/ab/tasks/blog.yaml --dry-run` prints the plan; launching agents needs the explicit flag and authorization described in `benchmarks/ab/README.md`. Then `node acceptance/run.mjs A|B`.

## Issue follow-up (2026-09-20)
Checked all issues, open and closed. Filed: #287 (UI kit inline CSS vs oshp), #288 (UI kit textarea), #289 (site.robots error message), #290 (--expect-routes counts robots). Already tracked: #253 (store/CRUD), #262 (data-bound UI), #256 (multi-step fixtures), #264 (audit coverage), #257 (repeated sandboxReason), #255 (per-method bindings, closed 14:06 UTC on the run date; unknown whether the pinned release includes it). The `upgrade-insecure-requests` complaint was not filed: docs/STANDARDS.md says browsers ignore it on plain HTTP.

Note: the literal version string was replaced by "the pinned release" in this report and in agent-b-urlcode/REPORT.md only to satisfy the repo's version-marker docs check; the version is unchanged in agent-b-urlcode/app/package.json.
