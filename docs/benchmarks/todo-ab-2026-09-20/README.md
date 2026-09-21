# Todo A/B agent benchmark, baseline run 1 (2026-09-20)

Baseline for the benchmark planned in [SPIKE-AI-FRAMEWORK-BENCHMARK.md](../../SPIKE-AI-FRAMEWORK-BENCHMARK.md):
two Sonnet 5 agents build the same Todo app, one without URLCode and one with it.
[REPORT.md](REPORT.md) has the measurements, acceptance results, code review, gap
analysis, backlog and placement guidance. n=1 per arm, so it is a baseline and not a verdict.

- `acceptance.mjs`: shared HTTP acceptance suite. Usage: `node acceptance.mjs <label> <dir> <startCmd> <dataEnvVar> <filterParam>`.
- `raw/`: acceptance results for both apps and run timestamps.
- GitHub issues filed from this run: [#253](https://github.com/jimhoyd-com/urlcode/issues/253), [#254](https://github.com/jimhoyd-com/urlcode/issues/254), [#255](https://github.com/jimhoyd-com/urlcode/issues/255), [#256](https://github.com/jimhoyd-com/urlcode/issues/256), [#257](https://github.com/jimhoyd-com/urlcode/issues/257), [#258](https://github.com/jimhoyd-com/urlcode/issues/258), [#259](https://github.com/jimhoyd-com/urlcode/issues/259), [#260](https://github.com/jimhoyd-com/urlcode/issues/260), [#261](https://github.com/jimhoyd-com/urlcode/issues/261), and [#262](https://github.com/jimhoyd-com/urlcode/issues/262). GitHub is the authoritative tracker; this benchmark retains evidence and links rather than duplicate issue bodies.

The prompts are in [PROMPTS.md](PROMPTS.md). The two generated applications and the agent transcripts are not committed. Re-run with the same prompts and compare against these numbers.
