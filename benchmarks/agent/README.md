# Agent benchmark

Does URLCode reduce what an agent has to generate to ship the same small
application? This directory is the instrument for that question: ten tasks,
two arms, one acceptance suite per task shared by both arms, a documented
line-counting rule, a runner that stores every raw run, and five authoring
evals scored against a fixed rubric. It answers nothing on its own. **No
number in this directory is evidence until a stored run under `runs/` with a
real model adapter backs it**; the repository ships the adapter and a
scheduled workflow, and the runs land as workflow artifacts.

```sh
npm run benchmark:agent              # every task, both arms, then the evals, with the stub adapter
node benchmarks/agent/run.ts --task redirect-service --arm urlcode --verbose
node benchmarks/agent/run.ts --evals # the authoring evals only
node benchmarks/agent/run.ts --help
```

The default adapter requires nothing beyond the repository: no API key, no
network, no extra dependency. The stub adapter copies prepared answers from `answers/` into
an empty workspace so the whole pipeline (prompt, generation, acceptance,
counting, security checklist, storage) runs end to end and is itself tested.

## What the numbers are

Each run of one arm of one task writes one JSON record to
`runs/<date>-<model>-<arm>/<task>.json` (`-<n>` suffixed for repeats). It
holds, in this order of importance:

| Field | Meaning |
|---|---|
| `evidence` | `stub` or `model`. Stub records exercise the pipeline and are git-ignored; only `model` records may be cited. |
| `tests` | The shared acceptance suite: cases, passed, failed, per-case status and any harness failure (server never listened, `urlcode test` did not finish). |
| `codeRatio` | The **application-specific code ratio**: idea lines divided by all generated lines, with every file listed and classified. |
| `generated` | Files and non-blank lines the agent produced, after the exclusions below. |
| `tokens`, `turns`, `retries` | The adapter's own accounting for the run. The harness never estimates them; the stub reports zero. |
| `wallMs` | Generation, acceptance and total wall time in milliseconds. |
| `security` | A checklist of obvious mistakes found by pattern over the generated text (hard-coded secrets, `eval`, shell execution, TLS verification off, wildcard CORS with credentials). A pass is the absence of the pattern, nothing more. |
| `prompt`, `promptSha256` | The exact prompt the arm received, so a run can be reproduced and compared. |
| `harnessVersion`, `date`, `model` | Provenance. Change `harnessVersion` in `harness.ts` when the rule, the prompts or the fixtures change so old runs are not compared with new ones. |

The runner prints one line per run and a `summary` line that sums each arm:
lines, idea, plumbing, the pooled ratio, tests passed, failures, tokens,
turns, retries, wall time and security findings. The headline result the
plan asks for is "same tests passed, N percent fewer generated lines, M
percent fewer tokens, ratio X versus Y"; every term of it is in the summary.

## What the numbers are not

- **Not a measure of the application's quality.** The acceptance suite
  checks the behaviors the task lists and nothing else. Two arms that pass
  every case are equal for the purposes of this benchmark even if one is
  better engineered.
- **Not a measure of runtime performance.** `benchmarks/routing.ts` and
  `benchmarks/bulk.ts` are the runtime benchmarks.
- **Not independent of the prompts.** Both arms get a short preamble
  (`prompts/conventional.md`, `prompts/urlcode.md`) that tells the agent how
  it is judged. The URLCode arm assumes the agent has the skill, `urlcode
  context`, the recipes and the YAML reference, as `docs/NEXT-STEPS.md` §0.1
  specifies. A real adapter must give it those and nothing more.
- **Not persistence.** URLCode functions hold no cross-request state, so no
  task reads back what it wrote. Tasks that create or change records
  (shortener, CRUD, admin, contact form) are judged on validation and
  response shape, and their acceptance notes say so. This keeps the two
  arms comparable; it also means the benchmark does not measure a database
  layer.
- **Not the full task list.** `docs/NEXT-STEPS.md` names twelve
  representative tasks; ten ship here. The OAuth-protected internal app
  needs the auth extension, which is not part of this repository, and the
  API proxy needs a public HTTPS upstream, which the offline acceptance
  suite cannot provide. Both are the next two tasks once those can be run
  offline.
- **Not a security audit.** The checklist is a regex over generated text.
- **Not comparable across harness versions or models** unless the run
  records say the same `harnessVersion` and `model`.

## Tasks

Each task under `tasks/<id>/` has:

- `task.yaml`: `id`, `title`, `description` (why the task is in the set and
  what its idea is), `prompt` (what both arms receive after their preamble),
  `required` (a human-readable list of what the fixture checks), optional
  `modules` (paths that count as the idea in either arm), optional
  `environment` (operator-supplied values both arms receive; benchmark
  constants, never secrets), and `acceptance`.
- `acceptance/requests.json`: the shared fixture, in the format `urlcode
  test` reads (`path`, `method`, `headers`, `body`, `status`,
  `expectHeaders`, `expectBody`). It is validated the same way `urlcode
  test` validates it, so both arms face identical cases.
- `acceptance/README.md`: how the fixture is applied and what it deliberately
  does not check.

| Task | Idea | Plumbing the task forces |
|---|---|---|
| `redirect-service` | a redirect table | status codes, parameter validation, 405/404 |
| `url-shortener` | a link table and registration rules | routing, JSON body handling, 415/400/422 |
| `webhook-receiver` | the acknowledgement shape | shared-token check, body contract |
| `json-api` | a catalog | filter validation, integer ids, read-only methods |
| `static-site-api` | page content, a version body | page and asset serving, caching, clean URLs |
| `authenticated-endpoint` | two bodies | bearer check, challenge, `no-store` |
| `crud-backend` | record rules and a seed | four verbs, body handling, every edge status |
| `admin-backend` | stats, a user table, one action | Basic auth, page serving, routing |
| `file-download-service` | file bytes and names | attachments, ranges, ETags, traversal |
| `contact-form` | field rules and a honeypot | page serving, body parsing, method dispatch |

## The two arms

**Conventional.** The agent picks its stack and reports the command that
serves HTTP on `$PORT`. The harness starts that command in the workspace
with `PORT`, `HOST=127.0.0.1` and the task's `environment`, waits for the
port, sends the fixture with the same pass rule `urlcode test` uses, and
stops the process group.

**URLCode.** The harness writes the fixture as the project's
`tests/requests.json` (the agent's own fixture is kept in the count under
`tests/requests.agent.json`), plays the operator by granting exactly what
`urlcode permissions` requests in a policy file outside the project, and
runs `urlcode test` from this checkout. The grant is part of the record: a
real deployment reviews it by hand, and the benchmark does not pretend
otherwise.

## The code ratio

`count-lines.ts` is the counting rule and has no I/O, so it is unit-tested
directly. The rule:

- A line counts when it is not blank. Comments count: the agent wrote them.
- **Idea**: files under `functions/` at any depth in either arm, plus any
  path the task or the adapter lists as an application module (an exact
  file or a directory prefix). The conventional arm's own modules (a link
  table, a validator, a catalog) are the idea when the adapter says so; the
  prompt asks the agent to report them.
- **Plumbing**: every other generated file. Routing, including
  `urlcode.yaml`; servers; authentication, sessions and middleware;
  validation; headers; static serving and the published assets themselves;
  deployment and configuration; tests and lockfiles; documentation.
- **Excluded**: the acceptance fixture the harness wrote, `node_modules`,
  `.git`, `dist`, `coverage`, `.urlcode` and binary files.

`urlcode.yaml` is plumbing on purpose. The claim under test is that the
declaration is *shorter* than the code it replaces, not that it is free, so
it must be on the same side of the ledger as the server it stands in for.
The ratio is reported beside total lines for the same reason: a high ratio
over many lines is not a saving.

## Security checklist

`securityChecklist` in `harness.ts` runs five pattern checks over every
generated text file and records up to ten `file:line` evidences per check.
It catches obvious mistakes, not subtle ones, and a pass means only that
the pattern is absent.

## Authoring evals

`evals/<id>.yaml` are the §0.2 regression prompts: add a redirect, add an
authenticated endpoint, serve a directory, add middleware, create a webhook
endpoint. Each carries the full eight-criterion rubric and an `expect`
block that makes it scoreable without a judge model:

| Criterion | Scored from |
|---|---|
| `valid-yaml` | `urlcode.yaml` parses and has `version` and `routes` |
| `no-unsupported-fields` | the project loads against the schema |
| `native-functionality` | every `expect.handlers` route declares that handler |
| `no-unnecessary-javascript` | no `.js`/`.mjs` generated when `expect.javascript` is false |
| `no-boundary-violations` | generated code has only relative imports, no `node:`, `fetch`, `process` or `require`, and no operator policy in the project |
| `tests-written` | `tests/requests.json` has a case for every expected route |
| `validation-run` | the adapter's reported commands include `urlcode validate` or `urlcode test` |
| `provider-limits-respected` | no `proxy`, `signals`, `conditional`, `link` or `extension` unless `expect.allows` names it |

A criterion the harness cannot see fails rather than being skipped. Records
go to `runs/<date>-<model>-evals/<id>.json`; the `evals` summary line gives
the pass rate overall and per criterion. The plan's rule is that a new
feature must not lower that rate, which needs a stored model baseline first.

## Running against a model

`adapters/anthropic.ts` is the real adapter: an agentic loop over the
Messages API with Node's global `fetch` and no extra dependency. The model
gets five tools (`list_files`, `read_file`, `write_file`, `run_command`,
`finish`); files stay inside the workspace (paths and symlinks are checked),
and `run_command` accepts only `urlcode validate|test|context|routes|explain|
audit|permissions` in the URLCode arm and `node <file>` / `npm
install|ci|test|run` in the conventional arm, each with a timeout. The
URLCode arm's system prompt carries the skill, `docs/RECIPES.md` and the
YAML reference, cached across turns; the conventional arm gets nothing
URLCode-specific. Tokens are the API's own `usage` fields (input, cache
writes and cache reads summed as input), turns are API calls, retries are
429/5xx/network retries. Hard caps: 40 turns, 20 minutes and 512 KiB
written per run; reaching one is recorded as a generation failure.

```sh
ANTHROPIC_API_KEY=... npm run benchmark:agent -- --evals --adapter anthropic
URLCODE_BENCHMARK_MODEL=<model id> npm run benchmark:agent -- --adapter anthropic --task redirect-service
```

| Setting | Where | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | repository secret / environment | Required. Absent in CI, the workflow prints "no credential; evals skipped" and exits 0. |
| `URLCODE_BENCHMARK_MODEL` | repository variable / environment | Optional model id; the default is the current recommended model in `adapters/anthropic.ts`. The run directory is named after it. |

The adapter sends `fallbacks: "default"` so a request the model's safety
classifiers decline is re-run server-side on Anthropic's recommended
substitute; the run's `notes` field lists every model that served it.

## Scheduled evals

The scheduled workflow checks for its credential before checkout or dependency
installation. Run artifacts are retained for 14 days; download evidence needed
for a longer comparison before it expires.

`.github/workflows/evals.yml` runs the five authoring evals weekly and on
`workflow_dispatch` with the adapter above, uploads `benchmarks/agent/runs/`
and the runner output as a workflow artifact, writes the pass rate and the
per-criterion table to the job summary, and runs `gate.ts` against
`runs/baseline.json`.

**A green run is not evidence on its own.** Without an `ANTHROPIC_API_KEY`
secret the job skips the model entirely and still concludes green, because
skipping is not a failure — and in the Actions list that is the same mark a
real passing evaluation gets. A skipped run says so at the top of its job
summary and uploads `agent-benchmark-SKIPPED-<run id>` instead of run records.
Read a green result as a passing evaluation only when the run carries an
`agent-benchmark-runs-<run id>` artifact.

**Cost.** An estimate, not a measurement: each eval is a short authoring
task of a few turns with roughly 15k tokens of cached reference material per
request, so one weekly run of five evals is on the order of a few hundred
thousand input tokens (mostly cache reads) and a few thousand output tokens,
in the low single dollars at current list prices for the default model. A
full task run (ten tasks, two arms) is several times that. Check the
`tokens` field of the stored records before repeating runs.

**The baseline.** `runs/baseline.json` is the reference pass rate. The
committed one comes from the stub adapter and carries `"stub": true`, which
the gate reads as "no baseline yet": a model run then passes whatever its
rate and the summary says so. To store a real baseline, run the evals with
the model, then `node benchmarks/agent/gate.ts --log <runner output>
--model <id> --write-baseline` and commit the file (the artifact from a
workflow run contains the same runner output as `evals-output.jsonl`). The
gate compares only within the same `harnessVersion`; bump the version and
store a new baseline when the prompts, the rubric or the evals change.

**What a drop means.** The gate fails when the pass rate is below the
baseline, when any eval's generation failed (an API error, a refusal, a
cap reached), or when the run produced no records. A drop is a signal that
a change to the skill, the recipes, the YAML reference, `urlcode context`
or the harness made the authoring task harder for the model, or that the
model changed; the per-criterion table in the summary and the `evidence`
strings in the stored records say which criterion moved. It is not by
itself a bug in URLCode. Repeat the run once before acting on a single
drop, since a model run is not deterministic; if it holds, fix the
regression or, when the change is intended, store a new baseline in the
same pull request.

## Adding a real adapter

`adapters.ts` defines the interface: an adapter receives `{task, arm,
prompt, workspace}` and returns token counts, turns, retries, the files it
wrote, the start command (conventional arm), the application modules it
considers the idea, the commands it ran and free-text notes.
`adapters/anthropic.ts` is the reference implementation. Add another to
`selectAdapter`, name it after the model so the run directory says which
one, and keep these rules:

- Give the URLCode arm the skill, `urlcode context`, the recipes and the
  YAML reference, and give the conventional arm nothing URLCode-specific.
  Neither arm sees the acceptance fixture.
- Report the model's own token accounting. Never estimate.
- Run each arm several times (`--repeat`) with the same model and store
  every run. Publish only what the stored runs support.
- Keep secrets out of the repository; task `environment` values are
  constants, and a real deployment would replace them.

Runs from a real adapter are not git-ignored (only `*-stub-*` directories
are), so the evidence lands next to the instrument that produced it.
