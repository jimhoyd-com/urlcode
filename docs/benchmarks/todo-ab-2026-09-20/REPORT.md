# URLCode A/B Agent Benchmark — Baseline Run 1 (2026-09-20)

Layout: `agent-a-control/`, `agent-b-urlcode/app/` (framework clone in `agent-b-urlcode/src/`), `acceptance/run.mjs`, `raw/` (acceptance JSON, timestamps). Agent transcripts: task output files listed in the session (JSONL).

## Caveats (read first)
- Model: both `sonnet` (Sonnet 5) via the Agent tool. **Thinking level "Medium" could not be set or confirmed** — unavailable.
- Single run, n=1 per arm. Differences of this size are within run-to-run noise; treat as a baseline, not a verdict.
- The app is tiny (~300 LOC). Framework overhead dominates; results may not generalize.
- Token telemetry: two sources disagree in definition. (1) Harness completion figure `subagent_tokens`: A 57,671, B 82,182 (exact composition undocumented; no input/output split). (2) Transcript `usage` sums: A in 10 / out 12,630 / cache-read 140,963 / cache-create 112,547 (5 assistant msgs); B in 40 / out 13,714 / cache-read 1,242,142 / cache-create 75,140 (20 msgs). Cache-read totals reflect re-reading context each turn and are not "work". Per-phase tokens, tokens-before-first-run, doc-reading tokens: **unavailable**.
- Neither builder opened the UI in a browser; my acceptance suite is HTTP-level. UI behaviours (rendering, mobile layout, remaining count, empty state) were checked **statically only** => reported PARTIAL/NOT TESTED, not PASS.
- Isolation: agents were told to stay in their directories; not sandboxed. B's transcript shows only its dir + GitHub/npm; A's shows only its dir. No human interventions in either arm (0).
- Agent A completed in only 2 shell calls (whole app written in one heredoc call + one patch): it needed no discovery at all. Agent B spent 7 of its 12 calls on discovery before writing.

## Side-by-side
| Metric | A — Control | B — URLCode |
|---|---:|---:|
| Total tokens (harness figure) | 57,671 | 82,182 |
| Input tokens (uncached, transcript) | 10 | 40 |
| Output tokens (transcript) | 12,630 | 13,714 |
| Cache read / create (transcript) | 140,963 / 112,547 | 1,242,142 / 75,140 |
| Agent turns (assistant msgs) | 5 | 20 |
| Tool calls | 2 | 12 |
| Commands | 2 | 12 |
| Failed commands | 0 observed | 0 observed (audit `ready:false` left unresolved) |
| Debug cycles | 1 patch | 2 patches (sandboxReason, mutate fix) |
| Time to first run | unavailable | unavailable |
| Time to completion (harness duration) | 108 s | 149 s |
| Requirement completeness (HTTP acceptance, 38 checks) | 38/38 pass | 38/38 pass |
| UI behaviours verified in browser | not tested | not tested |
| Agent tests (pass/total) | 19/19 | 4/4 + 16/16 fixtures |
| Total LOC (all files excl. lockfile) | 543 | 506 (ex. lock) |
| Application LOC (src+UI+html/css, no tests/docs) | 371 | 265 |
| Test LOC | 126 | 94 (+102 fixture JSON) |
| Configuration LOC | 9 (package.json) | 81 (yaml 65 + package.json 16) |
| Custom JS/TS LOC (backend) | 215 | 116 |
| UI JS LOC | 93 | 52 |
| Files (excl. lockfile/node_modules/data) | 9 | 10 |
| Dependencies (runtime/dev) | 0 / 0 | 1 / 0 (+lockfile 232 lines) |
| Routes/endpoints | 6 operations on 3 API patterns + static | 5 routes (4 API operations sets + page + assets) |
| Human interventions | 0 | 0 |

URLCode-specific (B): YAML 65 LOC; declaratively implemented: page, static assets, 405 method gating, body size/content-type/JSON-syntax limits, `status` enum query validation, Cache-Control (6 features, all transport-level); custom escape hatches: 1 function file (`functions/todos.mjs`, 116 LOC, 3 exports) + plain-JS UI; extensions used: 0; policies used: 0; handlers used: page 1, function 3, static 1. `urlcode validate` pass (5 routes), `urlcode test` 16/16, `urlcode audit` 22/22 checks but `ready:false` (7 route/method combos "uncovered" by success fixtures).

## Derived metrics (definitions)
- Token reduction = (A−B)/A using harness figure: (57,671−82,182)/57,671 = **−42.5%** (URLCode used more). Transcript output-token comparison: −8.6%.
- Code reduction (application LOC, excluding tests/docs/lockfile): (371−265)/371 = **+28.6%**. Counting config as code: A 380 vs B 346 => +9.0%.
- File reduction: (9−10)/9 = **−11%**.
- Dependency reduction: undefined (A has 0); B added 1 dependency.
- Token efficiency (tokens / fully passing requirement; 38 HTTP checks): A 1,518; B 2,163.
- Implementation density (passing checks / application LOC): A 0.102; B 0.143.
- Custom-code escape rate = imperative app LOC / total app implementation LOC: B 168/265 = **63%** (116 function + 52 UI JS); backend-only 116/181 = 64%. A = 100% imperative by construction.

## Acceptance results (raw: `raw/acceptance-{A,B}.json`)
Both PASS: starts; UI loads (static HTML check); create (201); fields; retrieve; edit (+updatedAt changes); complete/reopen (PATCH + toggle); filters all/active/completed; persistence after restart; 6 invalid-input cases (4xx); malformed JSON 400; array body 4xx; invalid update; invalid filter 400; missing todo 404 on GET/PUT/DELETE/toggle; 405; wrong content-type 4xx; XSS payload stored as data; delete; path traversal blocked.
PARTIAL / NOT TESTED for both: remaining count, empty state, mobile usability (static grep + viewport meta only; no rendering); edit/delete/filter UI flows.
Note the suite is API-shaped and tolerant of field names (`createdAt`/`created_at`, wrapped/unwrapped bodies), so it cannot detect response-shape differences.

## Independent code-quality review (summary; full text in evaluator output)
Scores A vs B: readability 4/4, separation 4/3, duplication 4/3, unnecessary abstraction 4/4, boilerplate 3/4, dependency footprint 5/2, error handling 4/3, validation 4/4, security basics 4/3, testability 4/3, understanding 4/3, changeability 4/3.
Key evidence: A hand-rolls router/body reader/static server (`src/app.js:30-51,80-116`) but is self-contained and tests in-process (`test/api.test.js:10`). B outsources transport to YAML (`urlcode.yaml:13-33`) but `functions/todos.mjs` still mixes validation, store and handlers; e2e tests spawn `npx urlcode` (`tests/api.test.mjs:9-22`, may orphan the process); no security headers configured or asserted in project files (framework behaviour unverified by reviewer). Shared risks: no fsync, single-process locking. UI bugs: A loses typed edit text on re-render; B leaves checkbox flipped after a failed PATCH (`public/assets/app.js:45`).
Reviewer did not run code or read framework; treat "unverified" items as open questions.

## Agent B trajectory & gaps
Trajectory: clone repo (1) → AI-AUTHORING/recipes/`static-plus-api`/FUNCTION-SECURITY/YAML-GUIDE/yaml/functions.md (2–6) → npm install + CLI (7) → write yaml+function (8) → patch (9) → grep for `sandboxReason` (10–11) → README (12). It found `docs/AI-AUTHORING.md` and `recipes/` quickly; no framework-internals inspection.

| # | Observation / Evidence | Classification | Proposed improvement |
|---|---|---|---|
| 1 | No storage/CRUD capability: agent hand-wrote JSON-file store + write queue inside a trusted function (`todos.mjs`, ~40 of 116 LOC). Docs say no guest storage broker. **Missing capability**, not discoverability. | Framework capability gap; Declarative model gap; Excessive custom code | Add a declarative collection/`store` handler (JSON file/SQLite-backed CRUD: list/get/create/patch/delete with id, timestamps) or an extension with a documented recipe. |
| 2 | No field-level body validation: only JSON syntax/type/size; title/completed validation hand-written. | Declarative model gap; Schema gap | Allow JSON-schema for request bodies (`request.body.schema`) with 400/422 problem responses. |
| 3 | One handler per route; method dispatch by `request.method` inside function; short `function:` form auto-binds only path params, long form needs manual `parameters`/`args`. | Declarative model gap; Awkward syntax; Excessive configuration | Per-method handlers (`GET:`, `POST:` blocks) and auto-bind all declared params/body. |
| 4 | Path `id` parameter schema has no `pattern`; UUID check in code. | Schema gap | Support `pattern`/`format: uuid` on parameters. |
| 5 | Audit advisory "declare sandbox or sandboxReason": agent found `sandboxReason` only via docs grep + `schema route`, not in the starting recipe. Trusted-by-default function needs filesystem, so sandbox impossible for any persistent app. | Discoverability problem; Recipe gap; Error-message gap | Put `sandboxReason` in the `static-plus-api` recipe; make advisory text include the exact YAML line to add. |
| 6 | Fixtures cannot chain requests or assert state; stateful lifecycle/restart tests needed a separate `node:test` harness spawning `npx urlcode serve` (slow, orphan risk). | Framework capability gap; CLI/validation gap; Developer experience | Multi-step fixtures with captured variables and a restart step, plus an in-process test helper (`createTestServer`). |
| 7 | `urlcode audit` ends `ready:false` (7 uncovered route/methods) with no explanation of what would satisfy it; agent guessed. | Error-message gap; CLI/validation gap | Say precisely what "covered" means and how to cover mutating routes against a temp data dir. |
| 8 | Version/doc inconsistency: `llms.txt` says 0.4.0-alpha.2, YAML guide 0.3.0, npm latest 0.4.1. | Documentation gap; `llms.txt` gap | Generate version strings from package.json in docs/llms.txt; CI check. |
| 9 | Env access via `process.env` in function instead of a declared `env` binding; no documented way to config a data directory. | Documentation gap; Recipe gap | Recipe showing named bindings for data path. |
| 10 | `urlcode test` prints noisy JSON request logs. | Developer experience | Quiet by default, `--verbose` for logs. |
| 11 | UI (HTML/JS) hand-written; `ui` package covers templates/themes, not a data-bound list view. | Framework capability gap; Excessive custom code | Declarative data-bound list/form component or starter template for CRUD UIs. |
| 12 | Security headers (CSP, nosniff) not configured by project and not asserted; unverifiable from project files. | Security concern (unverified) | Document/verify default headers; `urlcode audit` should print effective headers. |
No confirmed AI-discoverability failure of an existing capability was observed; the docs entry (`AI-AUTHORING.md`, recipes) worked. The one near-miss is #5 (`sandboxReason`). This may reflect the small task; a run with richer requirements might expose more.

## Improvement backlog (prioritized; consolidated by root cause)
1. **Declarative persistence/CRUD (Framework + Declarative)** — root cause of gaps 1, 2, 4, 11: removes most custom JS (est. 116 → ~20 LOC) and the 64% escape rate. Difficulty: high. Issue: "Add declarative collection/store handler with CRUD, ids and timestamps".
2. **Body schema validation (Declarative + Schema)** — Difficulty: medium. Issue: "Support JSON-schema request-body validation on routes".
3. **Per-method handlers and full arg auto-binding (Declarative)** — cuts config and function branching. Difficulty: medium. Issue: "Allow per-method function bindings and auto-bind declared params".
4. **Stateful fixture testing (Tooling)** — Difficulty: medium. Issue: "Multi-step fixtures with variable capture and server restart; in-process test helper".
5. **Audit clarity + `sandboxReason` recipe (Errors/Docs)** — Difficulty: low. Issue: "Explain `ready:false` coverage rule; add sandboxReason to static-plus-api recipe".
6. **Version-consistent docs/llms.txt (Docs/AI discoverability)** — Difficulty: low. Issue: "Generate version strings in docs/llms.txt from package.json".
7. **Parameter `pattern`/`format` in schemas** — Difficulty: low.
8. **Quiet test output** — Difficulty: low.
9. **Token efficiency**: B reread ~1.2M cache tokens over 20 turns vs A's 141k over 5; the discovery reading (7 commands) is the cost. A single "CRUD app in one page" recipe and a compact `llms.txt` capability index with "no persistence: do X" would cut discovery turns. Difficulty: low.

## Bottom line
On this task URLCode did **not** win on effort: +42% harness tokens, 4x turns, 6x tool calls and slightly more time vs a zero-dependency control that needed no discovery, while both reached identical HTTP acceptance. URLCode did cut application LOC (−29%) and outsourced routing/method/body-limit plumbing to 65 lines of YAML, but the core business logic (storage, validation) remained custom (64% escape rate) because the framework has no persistence or body-validation primitive. Maintainability/security scores favored the control for this size. The largest lever is a declarative CRUD/store handler plus body schemas.

## Re-running
`node acceptance/run.mjs A agent-a-control "npm start" DATA_FILE filter` and `... B agent-b-urlcode/app "npm start -- --port \$PORT" TODO_DATA_FILE status`. Keep the two prompts (in the session) verbatim; log start/end in `raw/`. To make future runs comparable, run n≥3 per arm and capture true per-phase tokens from transcripts.

---
# Addendum: run 2 folded in ("Todo application with URLCode" session, 2026-09-20)
Source: exported transcript of session local_79bba437 (branch `claude/urlcode-todo-app-b949b6`, app in that worktree's `todo-app/`, its own `FRAMEWORK-FEEDBACK.md`). **Not a controlled arm**: different prompt (asks for UI-kit use, feedback log, "production-quality"), authoring skill loaded, a browser smoke test, and no Agent A counterpart. Compare only qualitatively.

| Metric | Run 1 (benchmark Agent B) | Run 2 |
|---|---:|---:|
| Transcript output tokens | 13,714 | 41,276 |
| Cache read / create | 1,242,142 / 75,140 | 4,187,486 / 175,058 |
| Assistant msgs / Bash calls | 20 / 12 | 51 / 23 (+skill, ToolSearch, 2 browser calls) |
| Wall clock | ~2.5 min | ~4 min (11:38-11:42Z) |
| YAML LOC | 65 | 52 |
| Custom server JS | 116 | 112 (86 + 26) |
| Browser JS | 52 | 64 |
| Tests | 4 e2e + 16 fixtures | 4 e2e + 14 fixtures |
| `urlcode audit` | 22/22, ready:false | 20 passed, ready:false |
| UI verified in a browser | no | yes (create, toggle, filter, empty state, escaping, CSP) |
Run 2 token counts include the orchestrating session's own tooling calls (e.g. usage queries), so they overstate build cost.

## What the second run adds
- **Replication:** persistence, per-method handlers, long-form path params, body validation, stateless fixtures, `audit` `ready:false`, hand-written UI and env literals were hit in both runs. That raises confidence these are framework gaps, not agent noise.
- **New in run 2:** YAML anchors rejected; `static.cacheControl` four-value enum found only via a validation error; env values cannot be overridden at run time; UI extension needs operator host wiring.
- **New in run 1 only:** `sandboxReason` discoverability, docs version drift, noisy `urlcode test`, no parameter `pattern`.
- **Discoverability failure confirmed:** run 2 used the built-in security-header policy; run 1 never found it and shipped no security headers. The policy is documented only in `docs/POLICIES.md`/`HTTP.md`, not in `llms.txt` or `AI-AUTHORING.md` (verified on origin/main 9092b4b). Whether run 2 found it through the skill or `urlcode context` is not verified.
- **Conclusion unchanged:** even with the authoring skill and a tightened prompt, custom code was ~112 server lines, because there is still no storage or body-validation primitive.

## Issues filed (jimhoyd-com/urlcode)
| # | Title | Runs |
|---|---|---|
| #253 | Declarative persistence: store/collection handler + CRUD recipe | 1, 2 |
| #254 | Declarative body validation + path parameter patterns | 1, 2 |
| #255 | Per-method bindings + auto-declared path params in long form | 1, 2 |
| #256 | Multi-step fixtures, restart step, quiet test output | 1, 2 |
| #257 | Reusable request/response blocks (anchors rejected) | 1, 2 |
| #258 | Runtime override for declared env values | 1, 2 |
| #259 | static-plus-api recipe / audit advisory don't lead to sandboxReason | 1 |
| #260 | Docs vs llms.txt version drift (0.4.0-alpha.2 / 0.3.0 / 0.4.1) | 1 |
| #261 | Security headers, cacheControl values not discoverable from llms.txt/AI-AUTHORING | 1, 2 |
| #262 | Plain projects can't use the UI kit declaratively; no CRUD screen pattern | 1, 2 |
Existing issues updated with a comment instead of duplicating: #249 (audit `ready:false`, second occurrence) and #173 (baseline numbers). Not filed as separate issues: backlog items 7/8 (param `pattern`, quiet output) were folded into #254 and #256.

## Placement guidance: extension vs core/tooling
Basis: `docs/PROJECT-DIRECTION.md` ("operators own credentials, storage and capability grants; application data stays in the operator's systems") and `docs/EXTENSIONS.md` (extensions are operator-installed trusted modules mounted on routes; a project cannot declare or choose one). Guidance is posted as comments on #253 and #262.

| Issue | Placement | Reason |
|---|---|---|
| #253 Persistence / CRUD | **Extension** (`extension: store` mounted on `/api/todos/*`) | Application data is operator-owned. Own declared field schema, so it does not wait on #254. Precedent: stored links moved out of core into an extension, since retired and unpublished (reason not verified; read it first). |
| #262 Data-bound CRUD screens | **Extension** (extend `@jimhoyd/urlcode-ui`, on top of #253) | UI-package work; reads the store's collection declaration so a Todo app declares fields once and gets API + screen. Not verified: whether ui can already render a bound list from a non-operator project. |
| #254 Body/parameter validation | Core | Changes the YAML contract; an extension can only validate its own policy schema. |
| #255 Per-method bindings, long-form params | Core | Handler contract. |
| #257 Reusable blocks | Core | Format feature. |
| #258 Env override | Core | Format/runtime feature. |
| #256 Fixtures, quiet output; #249 audit reasons | Core CLI tooling | Not runtime behavior. |
| #259, #260, #261 | Repo docs/recipes/`llms.txt` | Docs and recipes. |

Adoption cost of extensions: an operator must install them, so an AI agent facing a plain project will still hand-write storage and UI (as both benchmark agents did) unless a scaffold ships with them. Ship `urlcode init --with store` (extending the existing `--with auth,admin,ui` contract) and the CRUD recipe in the same release as #253; solve operator wiring once for both #253 and #262.

Suggested order: #253 store extension first (largest measured reduction in custom code, ~112-116 server LOC in both runs), with #254-#258 proceeding in parallel in core; then #262 on top of the store; docs issues (#259-#261) any time, cheaply.
