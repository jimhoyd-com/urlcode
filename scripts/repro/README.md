# V8 JIT worker crash reproducers (#708)

Diagnostic scripts for [#708](https://github.com/jimhoyd-com/urlcode/issues/708):
on Windows with Node 24, `test/sandbox.test.ts` has aborted with
`Check failed: jit_page_->allocations_.erase(addr) == 1` in
`v8::internal::ThreadIsolation::UnregisterJitAllocationForTesting`, after
every test in the file had passed. The sandbox pool runs QuickJS compiled to
WebAssembly in worker threads, and terminates and respawns those workers on a
guest deadline.

These scripts try to make that abort happen on demand, so it can be reported
upstream with a reproducer. They are not tests: `npm test` does not run them,
the published archive leaves them out (the root `files` list omits
`scripts/`), and nothing in CI runs them automatically. They never retry a
crash and they change nothing in the sandbox.

| Script | What it does | Depends on |
| --- | --- | --- |
| `wasm-worker-churn.mjs` | Keeps `--concurrency` worker threads in flight, `--iterations` in total. Each compiles and runs WebAssembly under top-level await and is terminated at a random point: while loading or compiling, while running hot code that V8 is tiering up, or not at all. It then exits the process with workers still running. Workloads: `synthetic` (a generated module of hot loops), `wasm-file` (compiles the QuickJS `.wasm`, or `--wasm-file PATH`) and `quickjs` (`quickjs-emscripten` evaluating JavaScript in a loop). Identical module bytes are shared across workers unless `--unique-modules` is given. `--seed` repeats a run. | Node only; the `wasm-file` and `quickjs` workloads are skipped if `quickjs-emscripten` is not installed |
| `function-pool-churn.ts` | Drives URLCode's real `SandboxPool` (the engine behind `sandbox: true` routes) through the deadline-terminate, respawn and close cycle of the "repeated guest deadlines" test, `--iterations` times. `--pattern test` mirrors the test; `--pattern churn` makes every slow request end in a deadline terminate and closes the pool while respawns may still be starting. `--pools` runs several pools at once. | This checkout |
| `run-capture.mjs` | Runs a command `--runs` times, each in a fresh process with a `--timeout-ms` limit, and records the exit code, signal and any V8 fatal block. Writes a log per failed run (and the first run), a JSON summary and, on GitHub Actions, a step summary. Exits 1 if any run failed, printed a V8 fatal error or timed out. | Node only |

## Running locally

```sh
npm ci
node scripts/repro/wasm-worker-churn.mjs --iterations 2000 --concurrency 8
node --conditions=development scripts/repro/function-pool-churn.ts --iterations 20
node scripts/repro/run-capture.mjs --label sandbox --runs 10 --timeout-ms 900000 --log-dir repro-logs -- \
  node --conditions=development --test test/sandbox.test.ts
```

A run that ends with a `"result":"no-crash"` line and exit code 0 did not
reproduce the abort. A reproduction ends with V8's `# Fatal error` block on
stderr and a non-zero exit (on Windows typically `3`, `0x80000003` or
`0xC0000409`). Extra V8 flags go before the script, for example
`node --no-wasm-lazy-compilation scripts/repro/wasm-worker-churn.mjs`.

## Running on GitHub Actions

The **Repro — V8 JIT worker crash (#708)** workflow
(`.github/workflows/v8-jit-repro.yml`) runs all three on demand. It has only a
`workflow_dispatch` trigger and is not a required check. Start it from the
Actions tab, or:

```sh
gh workflow run v8-jit-repro.yml --ref <branch> \
  -f reproducer=all -f os='["windows-latest"]' -f node='["22","24","26"]' -f runs=10
```

Each OS and Node leg uploads a `v8-jit-repro-<os>-node<major>` artifact holding
every failed run's full output, the per-reproducer JSON summaries and the
runner environment. The job's step summary lists each run's exit code and
whether the #708 signature appeared. The observed frequency for an upstream
report is the number of runs with that signature over the number of runs.
