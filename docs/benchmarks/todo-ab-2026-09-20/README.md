# Todo A/B agent benchmark, baseline run 1 (2026-09-20)

Baseline for the benchmark planned in [SPIKE-AI-FRAMEWORK-BENCHMARK.md](../../SPIKE-AI-FRAMEWORK-BENCHMARK.md):
two Sonnet 5 agents build the same Todo app, one without URLCode and one with it.
[REPORT.md](REPORT.md) has the measurements, acceptance results, code review, gap
analysis, backlog and placement guidance. n=1 per arm, so it is a baseline and not a verdict.

- `acceptance.mjs`: shared HTTP acceptance suite. Usage: `node acceptance.mjs <label> <dir> <startCmd> <dataEnvVar> <filterParam>`.
- `raw/`: acceptance results for both apps and run timestamps.
- `issues/`: bodies of the issues filed from this run (#253-#262).

The prompts are in [PROMPTS.md](PROMPTS.md). The two generated applications and the agent transcripts are not committed. Re-run with the same prompts and compare against these numbers.
