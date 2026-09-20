# URLCode A/B Benchmark — Hello World (2026-09-20)

Single run (n=1), `claude-sonnet-5`, URLCode at commit `c1a641f` (the release version is in this directory's name and `measurements.json`). **Thinking=medium could not be enforced** (the Agent tool has no such setting), so treat it as "default". Agents were isolated in separate directories and told not to read anywhere else. Raw transcripts, apps, measurements and verification output are in this folder.

## Result in one paragraph
Both apps work and pass independent verification. On this task URLCode produced **less code** (28 vs 47 lines; 0 lines of JavaScript vs 27) but cost the agent **~5x the cumulative tokens, 4x the tool calls and 3.4x the wall time**, almost all of it spent discovering how URLCode works, and it added a dependency (1 direct, 19 packages, 42.5 MB) and a Node ≥22.18 requirement. Zero failed commands, zero retries in either run. For a one-route static page, plain Node `http` is cheaper for an agent; this is not a task where URLCode's advantages (policy, redirects, functions) show up.

## Side by side
| Metric | A — Control | B — URLCode | Diff (B vs A) |
|---|---:|---:|---:|
| Input tokens (uncached) | 4 | 18 | +14 |
| Output tokens | 1,039 | 2,194 | +111% |
| Cache-creation tokens | 16,128 | 24,640 | +53% |
| Cache-read tokens | 71,050 | 423,292 | +496% |
| Total tokens (cumulative, all four) | 88,221 | 450,144 | +410% (5.1x) |
| Non-cache-read tokens | 17,171 | 26,852 | +56% |
| Tokens to first successful run¹ | 43,088 | 396,348 | 9.2x |
| Agent turns (API calls) | 2 | 9 | +7 |
| Tool calls / shell commands | 1 / 1 | 8 / 8 | +7 |
| Documentation reads | 0 | 6 | +6 |
| Failed commands / retries / debug cycles | 0 / 0 / 0 | 0 / 0 / 0 | — |
| Time to first successful run | ~13 s | ~38 s | +25 s |
| Total completion time | 13.2 s | 45.3 s | +32 s (3.4x) |
| Files created | 3 | 4 (+1 lockfile) | +1 |
| Total LOC | 47 | 28 (257 with lockfile) | −19 |
| Application LOC | 27 (JS) | 11 (6 YAML + 5 HTML) | −16 |
| Configuration LOC | 6 | 12 | +6 |
| JS/TS LOC | 27 | 0 | −27 |
| YAML LOC | 0 | 6 | +6 |
| Dependencies (dev) | 0 (0) | 1 (0); 19 transitive, 42.5 MB | +1 |
| Human interventions | 0 | 0 | — |
| Functional result | 200, valid HTML, "Hello World" | same, plus `urlcode validate` passes | equal |

¹ Sum of usage through the call that issued the successful command. Cache reads dominate B because each of its 9 calls re-reads a growing ~50k-token context; they are billed at a fraction of normal input, so **cost** difference is far smaller than the 5x token count. The harness's own "subagent tokens" figure (A 45,343; B 54,309) is roughly the final context size, not cumulative spend. Both agents started from the same ~42k-token harness prefix, which inflates both totals equally.

Derived: unnecessary implementation steps — A: 0. B: 2 (a second schema read to confirm `respond` has no HTML option; cloning the whole repo when a package install sufficed) out of 8 calls. B's discovery: calls 1–6 of 8 (75%), ~21 of 45 s (46%). Boilerplate: A has ~10 lines of server scaffolding (createServer, routing, 404, listen); B has none beyond a 6-line YAML route, but 6 lines of package.json + a lockfile are needed to pull in the runtime.

## Independent verification
Fresh copies, following each README (Node v26.8.2): A `npm start` → HTTP/1.1 200, `text/html; charset=utf-8`, doctype present, tags balanced, contains "Hello World". B `npm install` (19 packages), `urlcode validate --local` → valid/1 route, `npm start` → 200, `text/html; charset=utf-8`, same HTML checks pass. Both servers stopped cleanly. Only the default-port run was checked; A's `PORT` override and B's Node ≥22.18 claim were not tested (v26 only). Files in `verify/`.

## Agent B trajectory
1. Cloned repo, `ls`, `head llms.txt` (found stale header, see F1).
2. grep AI-AUTHORING for hello/quick start; listed starters/examples/recipes; read package.json version and bin.
3. Looked at `recipes/health-page` (closest match: `respond.text`) and grepped ASSETS.md for `page:`.
4. Read ASSETS.md (found `page: file:`) and README serve section.
5–6. Grepped and read `respond` in the JSON schema to confirm there is no `html` field → chose `page`.
7. Wrote all four files, installed, validated (one command).
8. Started, curled 200, stopped.
It never used `urlcode init` or the starter, chose the right high-level feature first time, and wrote no JS. The trajectory is close to ideal; the cost is entirely in finding that `page` (not `respond`) is the HTML answer.

## Findings
**F1 — Documentation problem (stale llms.txt header).** llms.txt says "this revision is `0.4.0-alpha.2`… `0.4.0-alpha.1` is the newest alpha published" while package.json carried the newer release version. Evidence: call 1 output. Agent happened to pin from package.json. Ideal: version line generated from package.json / release automation. Fix: generate the header in the release script and add a CI check. Effect: prevents wrong-version pins; small token change.

**F2 — Missing example/recipe (HTML page).** No recipe or Quick Start line maps "serve an HTML page" to `page`. The nearest recipe (`health-page`) uses `respond.text`, so the agent read the schema twice to check for an HTML option (calls 5–6). Ideal: AI-AUTHORING has a one-line decision table (text/JSON → `respond`, HTML file → `page`, directory → `static`, file download → `download`) and a `static-page` recipe. Effect: ~2–3 fewer calls, roughly 15–25% fewer discovery tokens.

**F3 — Developer-experience problem (no minimal scaffold).** The only starter (`starters/default`) includes functions, middleware, tests, Makefile and AGENTS.md, so a page-only project is hand-written. The agent cloned the full repo to learn the format. Ideal: `urlcode init <dir> --template page` (or `--minimal`) emitting `urlcode.yaml` + `public/index.html` + README. Effect: hello world in ~2 calls; discovery collapses since the agent can run the CLI instead of reading docs.

**F4 — Capability question (not a bug).** `respond` accepts only `text`/`json`; inline HTML needs an extra file. Whether `respond.html` should exist is a product call; for one-line pages it would remove a file and the `page` indirection. Listed as an option, not a recommendation.

**F5 — Structural cost (no fix implied).** A hello world under URLCode needs a package dependency (19 packages, 42.5 MB) and Node ≥22.18 (vs any Node for A). Only worth reducing if a lighter distribution (single-file/binary via `install.sh`) already exists; not investigated.

No missing capability, schema, CLI, validation or error-message problems surfaced: the agent hit no errors. The categories those would fall under are untested by this task.

## Proposed backlog (not filed; awaiting review)
| # | Suggested issue title | Problem / evidence | Root cause | Solution | Benefit | Difficulty |
|---|---|---|---|---|---|---|
| 1 | Generate llms.txt version header from package.json and check it in CI | F1: header says 0.4.0-alpha.2 vs the newer package version | Hand-maintained prose | Templated header + CI diff check | Correct pin/version guidance | Low |
| 2 | Add "which handler for which response" table and a `static-page` recipe to AI-AUTHORING/llms.txt | F2: 2 schema reads, 6 discovery calls | No path from "HTML page" to `page` | Table + recipe with test fixture | −2–3 calls per page task | Low |
| 3 | `urlcode init --template page` minimal scaffold | F3: full clone + hand-written files | Only a heavy starter exists | Minimal template flag | Discovery ≈ 1–2 calls | Medium |
| 4 | Evaluate `respond.html` for inline HTML answers | F4 | Schema limits `respond` to text/json | Decide; add if wanted | One fewer file per tiny page | Low–Medium (product decision) |
| 5 | Make this benchmark a repeatable harness under benchmarks/ | n=1; thinking not enforceable | Manual orchestration | Script the launch/measure/verify steps; run n≥5 per arm; add a heavier task where URLCode should win (redirect + header policy) | Real baseline instead of an anecdote | Medium |

## Reproducing the table
`node benchmarks/ab/summarize.ts A=raw/agent-a.transcript.jsonl B=raw/agent-b.transcript.jsonl` (from the repository root, with this directory's path) reproduces every token, tool-call, doc-read and discovery figure above, including tokens to first successful run (43,088 and 396,348); `derived/measurements.json` holds the same values, derived from the recorded transcripts on 2026-09-20 with no model launched. The old `raw/summarize_transcript.py` is replaced by the shared script.

## Caveats
n=1 with no variance estimate; token counts differ run to run. The control task is the ideal case for plain Node, so this result says little about URLCode on tasks with redirects, policies or functions. A shares the same harness prefix, but neither agent was blind to being benchmarked. Thinking level unverified. No URLCode changes were made and no issues were filed.
