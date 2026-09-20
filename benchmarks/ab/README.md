# A/B agent benchmark tooling

Repeatable tooling for the A/B methodology: the same task given to a control
arm (conventional stack) and a URLCode arm, agent transcripts measured the same
way, an acceptance script shared by both. It is distinct from
[`benchmarks/agent`](../agent/README.md), which scores generated code against
task suites; this directory measures what the *agent* spent and did. Issue #310.

```sh
node benchmarks/ab/summarize.ts A=<a.jsonl> B=<b.jsonl>   # table from raw transcripts, free
benchmarks/ab/run --task benchmarks/ab/tasks/hello-world.yaml --repeat 5 --dry-run   # plan only
benchmarks/ab/run --task benchmarks/ab/tasks/blog.yaml --out <dir> \
  --transcript a=<a.jsonl> --transcript b=<b.jsonl>        # measurements.json from transcripts, free
```

## Cost and authorization

**Nothing here spends API budget by default.** `benchmarks/ab/run` with no
flags, or with `--dry-run`, prints the plan and writes nothing;
`--transcript` only reads files. A real run starts one agent session per arm per
repeat, so `--repeat N` is `2N` sessions. The two recorded runs are the size
guide: hello-world was about 0.09M (control) and 0.45M (URLCode) cumulative
tokens, the blog task 0.43M and 2.4M, almost all of it cache reads, for one
run of each arm. Five repeats of the blog task is therefore on the order of
14M tokens; price it at the model's current list prices before starting.

Launching is refused unless all three are present, matching the repository's
rule that model runs need an explicit decision (see
[`SPIKE-AI-FRAMEWORK-BENCHMARK.md`](../../docs/SPIKE-AI-FRAMEWORK-BENCHMARK.md), Phase 2, which
fixes budgets and stopping rules before running, and the "Running against a
model" section of the [agent README](../agent/README.md)):

1. `--launch-models` on the command line;
2. `--launcher <command>`: this repository ships no model driver here. The
   command is run once per arm and repeat with `AB_TASK`, `AB_ARM`,
   `AB_REPEAT`, `AB_PROMPT_FILE`, `AB_WORKDIR` and `AB_TRANSCRIPT` set, must
   leave a Claude Code transcript at `AB_TRANSCRIPT`, and owns the credential,
   model, effort and tool limits, which stay identical across repeats;
3. `URLCODE_AB_LAUNCH_AUTHORIZED` set to the issue, PR or approval that grants
   this run's budget. It is recorded in `plan.json`.

After each launch the acceptance command for that arm runs and its exit code
lands in `measurements.json` (`acceptance`). Agents write code that the
acceptance commands then execute; run launches in a disposable environment.

## Task specs

`tasks/*.yaml`: `id`, `title`, a shared `prompt`, per-arm `suffix` and per-arm
`acceptance` (`cwd`, `command`). `{dir}` is the arm's working directory,
`{root}` the repository root, `{spec}` the `promptFile`. `hello-world.yaml` uses
`acceptance/http-page.ts` (start, request `/`, check status, content type,
doctype, balanced tags, text). `blog.yaml` points at the recorded run's
`acceptance/run.mjs`, which hard-codes its own directory layout, so it can
score only a run laid out like `benchmarks/results/blog-ab-2026-09-20/`.

## Output

`measurements.json` keeps the recorded shape (`agent_a`, `agent_b`, `tokens`
with `input`, `output`, `cache_read`, `cache_creation`, `cumulative_total`,
`tokens_to_first_success_incl_issuing_call`, `tool_calls`, `failed_commands`,
`doc_reads`, ...) for one run per arm. With repeats (`n > 1`) each arm holds
`runs` (one measurement per run) and `summary`: `{n, median, min, max}` per
metric. Metrics that a run lacks (no successful run) are left out of that
spread.

## What the summarizer counts

- **Tokens**: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, summed once per API message. A message
  streamed as several records with one `message.id` counts once, from its
  *last* record (earlier records carry partial output tokens). Both recorded
  runs use this Claude Code layout; the blog run is the streamed variant, the
  hello-world run mostly not. Input may be JSONL or a JSON array of records.
- **Tokens to first successful run**: cumulative four-way total through the API
  call that issued the first Bash command that exited cleanly and looks like
  running the app (`curl`, `npm start|test`, `node --test`, `node file.js`,
  `urlcode serve|test`; here-document bodies and `--help` do not count).
- **Failed commands**: Bash calls whose result has `is_error` or an
  `Exit code N`.
- **Doc reads**: tool calls (Read path, or a read-verb Bash command) touching
  `docs/`, `llms*.txt`, `schemas/` or `recipes/`, including files read after
  `cd`-ing into those directories. Counted per call; distinct paths are listed.
- **Discovery calls / share**: read-only calls (Read/Grep/Glob/web, or Bash
  without writes, installs or runs) up to and including the first successful
  run, divided by all tool calls.

These are pattern heuristics over commands, not judgments: check unusual
transcripts with `--json`, which lists the doc paths found. They reproduce the
hand-derived hello-world figures exactly (see `test/ab-benchmark.test.ts`).

`fixtures/` holds two small synthetic transcripts (no private data) that the
tests use, one per layout variant.

## Not done yet (issue #310)

A task where URLCode should win (a redirect service with a header policy), and
a rerun of hello-world on the current release, both need real model runs.
