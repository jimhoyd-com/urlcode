# Agent efficiency plan

Status: proposed. Evidence: benchmark redirector runs `test3` (0.4.6) and
`test4` (0.4.8), sonnet-5-medium, one repeat per arm, in the separate private
`urlcode-benchmarks` repository.

## Observed

Both arms pass 6/6 acceptance. URLCode (arm B) loses on cost and effort.

| | Fastify (A) | URLCode (B) |
|---|---|---|
| Tokens, test3 → test4 | 68k → 68k | 265k → 407k |
| Time | 20s | 56s → 74s |
| Tool calls | 2 | 8 → 11 |

The 0.4.8 redirect quick path did not reduce B's cost. Cache reads are over 90%
of B's tokens, so turn count is the driver. Each extra turn re-reads a growing
context.

## Findings

1. **Two of six requirements are not declarative.** Relative `Location`
   (`/users/:id` → `/profiles/:id`) is refused, and `/legacy/*` is not
   supported on `redirect` ([#383](https://github.com/jimhoyd-com/urlcode/issues/383),
   [OPEN-DECISIONS](OPEN-DECISIONS.md)). B wrote a function and eight
   fixed-depth routes, so deeper suffixes 404 while acceptance still passes.
   Root-relative destinations built only from path parameters carry none of the
   client-controlled-host risk that motivated the absolute-URL rule.
2. **Discovery sprawl.** B read the full `llms.txt`, then ran
   `urlcode context --task redirects` (which repeats its table), then grepped
   `OPEN-DECISIONS.md`, `PLUGINS.md`, `dist/index.d.ts` and the 240KB
   `llms-full.txt` three times, despite a prompt forbidding broad scans.
   `llms.txt` has two competing "Start here" sections.
3. **Function ergonomics.** Long-form `function: {source, args}` silently
   binds no args; only the string form does. The function cannot see the
   matched route or params. This cost a full rewrite cycle.
4. **Unused tooling.** MCP tools (`search_recipes`, `get_capability`,
   `explain_error`) and the `redirect` recipe were never used; nothing wires
   them into a fresh project. No single call returns a working file.
5. **Measurement.** One repeat per arm; B varied 54% between runs. A benefits
   from training-data familiarity. Acceptance does not test deep wildcards.
   (Repeat counts and acceptance changes belong to the benchmarks repository
   and are out of scope here.)

## Plan

### Phase 1 — Close capability gaps

- Decide #383. Add root-relative `redirect.url`: path only, `{param}` in path
  segments only, reject `//` and any host or scheme.
- Add a terminal wildcard redirect per the shape in OPEN-DECISIONS (`/**` route
  key, single `{**}` capture, reject `.`/`..` segments, cap captured length,
  order after more specific routes).
- Ship fixtures, update the `llms.txt` shape table and OPEN-DECISIONS.
- Done when requirements 3 and 4 classify as `declarative` with no function.

Needs a maintainer decision: this is the first exception to "exact or
`{param}`, no general-purpose wildcard" in [ROUTING.md](ROUTING.md).

### Phase 2 — Shrink discovery

- Cut `llms.txt` to about 3KB: one decision table, a pointer to
  `urlcode context`, and an explicit "do not grep `llms-full.txt`". Remove the
  duplicate "Start here" section; keep the full index in `llms-full.txt`.
- Make `context --task redirects` emit a complete paste-ready `urlcode.yaml`
  for each supported shape plus the `package.json` start script honoring `PORT`.
- Keep redirect scaffolding in task-scoped `context --task redirects`, not a
  second `init` template.
- Add a size gate in `test/` for `llms.txt` and the redirect context output.

### Phase 3 — Function ergonomics

- Long-form `function: {source, args}` binds args, or fails validation with the
  route named.
- Provide the matched route pattern and named params in the function context.
- Put one canonical function example in `llms.txt` and `context` output.

### Phase 4 — Wire up existing tooling

- `urlcode init` writes `.mcp.json` and a short `AGENTS.md` ("run
  `urlcode context` first; do not scan docs").
- Confirm the starter surfaces both without exposing arm information; the
  benchmark launcher side is coordinated in `urlcode-benchmarks`.

### Phase 5 — Verify

Rerun the A/B with at least five repeats per arm. Targets for B: at most 3 tool
calls, at most 120k tokens, no function for requirements 3 and 4, and correct
behavior on deep wildcards.

## Order

Phase 1, then 2 (which needs no design decision and can start immediately),
then 3, 4 and 5. Phases 1 and 2 should remove most of the gap: fewer
capability gaps means fewer turns.
