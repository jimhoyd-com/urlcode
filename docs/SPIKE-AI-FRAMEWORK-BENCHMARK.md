# Spike: AI-first URLCode framework benchmark

Status: proposed research and execution plan. This document adds no benchmark
implementation or measured results. It preserves the agreed independent-agent
experiment and improvement loop; executing the phases below is follow-up work.

## Objective and core principle

Measure whether autonomous agents can build a correct, realistic application
with URLCode, how much application intent its abstractions express, how easily
agents discover those abstractions, and how the resulting application performs.
Report AI effectiveness, framework expressiveness, AI discoverability and runtime
performance separately. Do not collapse them into a single score or assume that
URLCode will outperform another framework.

The canonical implementation rule for the explicitly guided run is:

> Use URLCode's highest-level declarative features whenever possible. Generate custom JavaScript only when the framework cannot express the requirement.

Before implementing functionality manually, check for a declarative primitive,
YAML configuration, built-in capability, extension, reusable template or documented
pattern. Custom JavaScript is an escape hatch. The experiment must also establish
whether an unfamiliar agent discovers this approach without explicit coaching.

## Phase 0 — Research existing work first

Before building the application or a new harness, investigate:

- RealWorld / Conduit and its reusable application and acceptance specification.
- TechEmpower Framework Benchmarks and their runtime methodology.
- SWE-bench and other coding-agent benchmarks.
- Agent productivity studies, framework comparison applications and standard
  CRUD/full-stack benchmark applications.
- URLCode's existing [agent harness](../benchmarks/agent/README.md), authoring
  evals, [next-steps plan](archive/2026-09-19/NEXT-STEPS.md), and runtime benchmarks in
  `benchmarks/routing.ts`, `benchmarks/bulk.ts` and
  `benchmarks/sandbox-vs-trusted.ts`.

Write a dated research report with primary-source links, versions/revisions,
what each candidate measures, what can be reused, what is missing, and the
reuse/adapt/build decision. Verify current maintenance status during research;
do not assume this proposal is novel or that an additional suite is necessary.

The existing agent harness already records shared acceptance results, generated
lines, prompts and provider-reported usage. Its README explicitly limits claims:
its tasks do not test persistence or runtime performance, its URLCode arm receives
curated guidance, and stub records are pipeline tests rather than model evidence.
Reuse suitable accounting and acceptance infrastructure after auditing it against
the current runtime. Do not treat its guided arm as the unprompted baseline or
silently reinterpret historical measurements under a new counting rule.

Exit criterion: record the selected specification and harness approach before
implementation begins, including the evidence for any departure from existing work.

## Phase 1 — Freeze a realistic, framework-neutral specification

Prefer RealWorld when practical. Otherwise justify a smaller RealWorld-inspired
application, such as TaskFlow: users own projects, projects contain tasks, and
users cannot access another user's private records. A basic Todo application alone
is insufficient. Freeze observable API behavior and shared acceptance tests before
agent runs; use exactly the same requirements for URLCode and Fastify.

Exercise routing, CRUD, authentication, authorization, persistent relational data,
relationships, validation, structured errors, filtering, sorting, pagination,
environment configuration, secrets, middleware, logging and automated tests.
Include registration/login, current-user lookup, ownership checks, restart
persistence, invalid inputs and unauthenticated/unauthorized requests in acceptance
coverage. Define logout semantics if applicable to the selected authentication
model. Specify a health endpoint and reproducible schema/migrations and seed data.

Also define isolated plaintext, JSON serialization, single-record database read
and database write endpoints, borrowing established runtime benchmark semantics
where practical. Freeze response bodies, status codes, headers, data size, database
work and cache behavior; database reads must actually hit the database, and writes
must persist. Keep these separate from realistic application workloads.

Use the same database engine/version and equivalent data in all comparable runs.
Choose it before implementation, not separately for each framework. Use synthetic
data and environment-supplied secrets. Keep benchmark applications isolated from
production runtime source. Record permitted extension packages and versions;
extension functionality must not be presented as built into core.

Correctness is the first gate: report passed/total acceptance cases, incomplete
requirements and failures. Do not compare an incomplete application's apparent
code savings or throughput as if it delivered the same functionality.

## Phase 2 — Reproducible harness and measurement

Capture exact prompts, model identifiers, agent/version, framework and extension
commits, lockfiles, documentation snapshots, harness version, runtime, OS, hardware,
database, tools and configuration. Record the initial workspace and available
instructions/tools. Fix time, turn and token budgets, stopping rules and permitted
human assistance before running; log interventions and failed or capped runs.

| Area | Measurements |
|---|---|
| Agent work | Input/output/cached/total tokens, elapsed time, turns, tool calls, shell commands, documentation searches, test/fix cycles, completion rate |
| Implementation | Total/source/configuration/JS/TS files, application LOC, configuration LOC, test LOC, direct/transitive dependencies, custom handlers and custom JavaScript |
| URLCode expression | Declarative routes, routes needing custom code, declarative versus imperative LOC, required extensions, JavaScript escape hatches, functionality manually duplicated despite an existing capability |
| Runtime | Startup time, idle memory, CPU, memory under load, requests/sec, p50/p95/p99 latency, response errors and timeouts |

Never estimate unavailable measurements: mark them unavailable and explain why.
Preserve provider usage fields and document whether cached tokens are included in
input totals so totals do not double-count them. Separate measured values from
derived calculations. Define LOC counting and exclusions in advance; separately
report configuration, tests, generated output, dependencies and copied templates.
Existing code-ratio metrics are not automatically declarative-coverage metrics.

For runtime comparisons hold hardware/resource limits, runtime, database, data,
concurrency, warm-up, duration and load generator constant. Specify startup start/
ready events and memory/CPU sampling. Record trust/sandbox mode, worker counts,
policies and extension overhead; compare equivalent behavior and disclose any
unavoidable differences. Do not disable correctness or security requirements to
improve scores. Reset data between trials and verify benchmark response semantics.

Predeclare repeated fresh-agent runs and repeated runtime trials, retain every
trial and report variability, sample counts and failures rather than selecting
best runs. Keep the load generator from becoming the bottleneck. Version changed
prompts, fixtures and counting rules so incompatible results are not pooled.

## Phase 3 — Independent URLCode agents

Each run starts with a fresh context and isolated worktree/environment. Agents
must not see another agent's implementation, logs or findings. The coordinator
collects evidence after each run; shared prompts contain the neutral specification
and operational rules, not the hypothesis or a desired token/LOC outcome.

### Protect the discovery baseline

This spike itself contains the instruction being tested. Do not expose it, its
index entry, benchmark prompts, prepared answers or prior findings to Agent A.
Use a pinned source/documentation snapshot preceding this spike, or a documented
filtered workspace with no access to excluded artifacts or repository history.
Apply the same underlying snapshot and access controls to the comparison runs,
with only the intended prompt treatment different. Record the exact manifest and
restrictions; if an agent reads excluded material, mark the run contaminated and
repeat it with a fresh agent rather than counting it as unprompted evidence.

Existing product documentation, skills and ordinary repository instructions are
part of what Agent A may discover; do not remove existing declarative guidance to
manufacture a worse baseline. Preserve the baseline before changing those sources.

### Agent A — Unprompted discovery

Supply the application specification, URLCode source and existing documentation.
The framework-specific instruction is only:

> Build this application using URLCode following the framework's documented conventions and recommended practices.

Do not supply the declarative-first rule or curated hints about where to find it.
Record whether the agent independently finds and uses it, including evidence of
unnecessary JavaScript, duplicated capabilities, missed primitives, misunderstood
abstractions, repeated searches, incorrect assumptions, unclear errors and stalls.
Treat these as potential framework/documentation problems, not automatically as
agent failures.

### Agent B — Explicitly URLCode-native

Run the identical application from scratch with a fresh independent agent. Add:

> Use URLCode's highest-level declarative features whenever possible. Generate custom JavaScript only when the framework cannot express the requirement.

> Before implementing functionality manually, determine whether URLCode already provides a declarative primitive, YAML configuration, built-in capability, extension, reusable template, or documented pattern.

Compare A and B on correctness, tokens, custom JavaScript, YAML, files, LOC,
implementation time, debugging cycles and documentation searches. A repeatable
advantage for B is evidence to investigate discoverability, not proof that every
individual mistake is a documentation defect.

### Agent C — Gap finder

Use another fresh agent, independent of A/B implementations and findings during
its attempt. Give it the same requirements and this instruction:

> Attempt to implement every requirement using URLCode's intended abstractions. Whenever URLCode cannot express something cleanly, document the limitation rather than hiding it behind substantial custom code.

Classify findings as missing capability, documentation gap, AI discoverability
problem, confusing API/schema, poor error message, unnecessary boilerplate,
extension-system limitation, performance problem, possible framework bug or agent
misunderstanding. Record the attempted declaration, missing requirement, relevant
documentation and any necessary workaround. A requirement that cannot be expressed
stays visibly incomplete; substantial custom code must not hide the gap.

## Phase 4 — Verify findings and prepare/file GitHub issues

After independent attempts are preserved, reproduce each candidate problem against
the pinned revision, inspect the supported contract and search existing issues and
PRs. Distinguish missing functionality from functionality the agent failed to find.
Do not file an issue merely because one agent made a mistake. Note corroborating
encounters by multiple fresh agents, while avoiding unsupported causal claims.

For each verified, actionable issue include:

- Problem and benchmark scenario, affected repository/revision and environment.
- Expected versus actual behavior and minimal synthetic reproduction.
- Relevant YAML/code, commands, errors and links to run evidence.
- Classification, proposed improvement and impact on human developers and agents.
- Acceptance criteria and related/duplicate issue links.

Use the owning repository's issue template and the ownership map in
[AGENTS.md](../AGENTS.md): core/runtime issues belong here, public documentation
in `urlcode-docs`, and extension defects in the corresponding extension repository.
Update existing issues with new evidence rather than duplicating them. Track
prepared, filed, duplicate and unverified dispositions in the findings report;
file verified issues and retain unresolved hypotheses as explicitly unverified
observations. Follow [SECURITY.md](../SECURITY.md) for private vulnerability reports.

## Phase 5 — Audit AI discoverability

Audit README, documentation, examples, schemas, CLI help, package metadata,
`llms.txt`, agent instructions/skills, scaffolding and errors. Determine whether an
unfamiliar agent can find the framework's purpose, declarative-first philosophy,
YAML capabilities, built-in primitives, extensions, authentication, database access,
validation, errors, custom functionality, testing and debugging guidance.

Specifically search for guidance equivalent to the canonical rule above; record
exact locations, prominence and the navigation/search path used to discover it.
Do not assume it is absent just because the exact sentence is missing. Check the
current contract when documents and historical benchmark assumptions differ.

Preserve Agent A's baseline before editing guidance. Then propose the smallest
authoritative set of changes that makes the principle clear to people and agents,
including when custom JavaScript is appropriate. Public authoring guidance belongs
in `urlcode-docs`; contributor records and spikes remain here. Do not copy the rule
everywhere or expose the experimental prompt as product guidance by accident.

## Phase 6 — Fastify comparison

Once the URLCode methodology works, give a fresh independent agent the same frozen
specification, budgets, tool access and acceptance criteria, using:

> Build this application using Fastify following the framework's documented conventions and recommended practices.

Do not mention URLCode or expose its implementations/findings. Use Fastify
idiomatically; do not force it to imitate URLCode's architecture. Compare correctness,
agent work, files/LOC/dependencies, configuration, debugging/searches and runtime
measurements separately. Document framework-specific dependencies and setup work.
Later candidates include Hono, Express, NestJS and Elysia; they are not prerequisites
for the first comparison.

## Phase 7 — Findings and deliverables

Publish the contributor findings in `docs/benchmarks/AI_FRAMEWORK_BENCHMARK.md` when
runs exist. Keep implementation and raw evidence paths versioned and linked from
that report; do not create a results document implying measurements already exist.
Deliver:

1. Dated benchmark research and reuse decision.
2. Frozen application specification and shared acceptance suite.
3. Reproducible harness, commands and independent agent prompts.
4. URLCode A/B/C and Fastify implementations or explicit incomplete outcomes.
5. Raw agent logs/usage, implementation counts and runtime trial data.
6. Methodology, provenance, comparison tables, uncertainty and evidence limitations.
7. Agent behavior/search/failure analysis and classified framework/discovery gaps.
8. Verified issue ledger, proposed/filed issue links and prioritized improvements.
9. Before/after findings following the fresh-agent regression phase.

Remove secrets from published logs while retaining measurement provenance. Keep
stub/harness validation records distinct from real-agent evidence. Report every
failed attempt, not just successful applications, and avoid subjective scores or
claims beyond the measured cases.

## Phases 8–9 — Improve and rerun with fresh agents

Prioritize demonstrated friction: missing declarative primitives, defaults, YAML,
schemas, errors, examples, extension discovery, README/AI documentation, CLI and
scaffolding. Make legitimate application-development improvements, not special
cases that game the benchmark. Track each change to its verified issue/evidence.

After improvements, rerun with entirely fresh agents and isolated environments.
The new discovery agent must again receive no explicit declarative-first rule or
prior findings; it may discover the improved ordinary documentation naturally.
Keep this spike and benchmark answers excluded. Repeat B, C and the comparison
where needed to distinguish framework changes from model/harness drift. Hold model,
budgets, requirements and runtime conditions fixed where possible; disclose changes
and do not attribute their effects solely to URLCode.

Compare before/after correctness, tokens, elapsed time, generated JavaScript, YAML,
LOC, files, dependencies, tool calls, searches, failed attempts, test/fix cycles and
runtime performance. Keep dimensions separate and preserve the original baseline.

The repeatable loop is: independent agent encounters friction → evidence captures
it → verified issue → URLCode improvement → fresh-agent rerun → measured outcome.
Use it for significant releases to detect regressions in AI usability, declarative
coverage, documentation, capability and runtime performance. Completion means
reproducible evidence and an actionable issue/improvement trail, not a claim that
URLCode won the comparison.
