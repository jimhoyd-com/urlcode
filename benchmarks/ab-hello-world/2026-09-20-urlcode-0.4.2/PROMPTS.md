# Repeating this benchmark
Launch two agents in parallel (Agent tool, model sonnet, general-purpose, background), each confined to its own empty directory, with no Skill tool and no memory.
- A (control): "Build a minimal web application that serves a Hello World page ... choose whatever conventional technology ..." (no URLCode).
- B: same requirements + "using URLCode: https://github.com/jimhoyd-com/urlcode ... discover how it works from the repository itself ... use the highest-level declarative features; custom JS only when the framework cannot express it. Deliverable in app/, scratch in scratch/."
Both: requirements = starts locally, HTTP server, serves `/`, valid HTML 200, displays "Hello World", README with install/run; no extra features; verify it runs.
Then: copy transcripts from ~/.claude/projects/<proj>/<session>/subagents/, run `raw/summarize_transcript.py <transcript>` (dedupe usage by message id, keep LAST record per id), verify each app from a clean copy following its README, and count LOC.
Known gaps: thinking level is not settable per agent; the session inherits a ~42k-token harness prefix in every agent; subagent `<usage>` "tokens" equals roughly the final context size, not cumulative spend.
