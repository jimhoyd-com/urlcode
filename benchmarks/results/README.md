# Stored benchmark runs

Raw JSON output from a runtime performance benchmark (`benchmarks/*.ts`,
`npm run benchmark*`), one file per dated run, named
`<date>-<benchmark>.json`. These are development-machine measurements, not a
throughput SLA or a promise about any other host — see
[docs/PERFORMANCE.md](../../docs/PERFORMANCE.md) and
[docs/CAPACITY.md](../../docs/CAPACITY.md) for how the numbers are used and
caveated.

This is distinct from `benchmarks/agent/runs/`, which stores runs of the
agent code-generation benchmark (does URLCode reduce what an agent has to
write), not runtime performance.
