// The pass-rate gate for the scheduled evals. It reads the JSON lines the
// runner printed, compares the `evals` summary with runs/baseline.json, writes
// a Markdown summary (to $GITHUB_STEP_SUMMARY when set, else stdout) and
// exits 1 when the rate dropped. `--write-baseline` stores the summary as the
// new baseline instead; a baseline marked `stub: true` means "no baseline yet"
// and never fails the gate. README.md, "Scheduled evals", explains the policy.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { home } from './harness.ts';

export interface Baseline { stub: boolean; harnessVersion: string; model: string; date: string; evals: number; passed: number; total: number; passRate: number | null; criteria: Record<string, { passed: number; total: number }> }
interface EvalsLine { event: 'evals'; harnessVersion: string; evidence: 'stub' | 'model'; evals: number; passed: number; total: number; passRate: number | null; criteria: Baseline['criteria'] }
interface EvalLine { event: 'eval'; eval: string; score: string; failed: string[]; failures: number }

/** The runner's JSON lines: one per eval and the closing summary. Other lines (warnings, server output) are ignored. */
export function parseLog(log: string): { summary: EvalsLine | undefined; evals: EvalLine[] } {
  let summary: EvalsLine | undefined; const evals: EvalLine[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let parsed: unknown; try { parsed = JSON.parse(line); } catch { continue; }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const event = (parsed as { event?: unknown }).event;
    if (event === 'evals') summary = parsed as EvalsLine; else if (event === 'eval') evals.push(parsed as EvalLine);
  }
  return { summary, evals };
}

export interface Verdict { pass: boolean; reason: string; passRate: number | null; baselineRate: number | null }

/** Fail when generation failed anywhere, when the run produced no evals, or when the rate is below a real (non-stub) baseline for the same harness version. */
export function compare(run: { summary: EvalsLine | undefined; evals: EvalLine[] }, baseline: Baseline | undefined): Verdict {
  const { summary, evals } = run;
  if (!summary || summary.evals === 0 || summary.passRate === null) return { pass: false, reason: 'the run produced no eval records', passRate: null, baselineRate: baseline?.passRate ?? null };
  const broken = evals.filter(item => item.failures > 0).map(item => item.eval);
  if (broken.length) return { pass: false, reason: `generation failed for ${broken.join(', ')}`, passRate: summary.passRate, baselineRate: baseline?.passRate ?? null };
  if (!baseline || baseline.stub || baseline.passRate === null) return { pass: true, reason: 'no baseline yet; this run sets the reference once stored', passRate: summary.passRate, baselineRate: null };
  if (baseline.harnessVersion !== summary.harnessVersion) return { pass: true, reason: `baseline is from harness ${baseline.harnessVersion}, this run is harness ${summary.harnessVersion}; not comparable, store a new baseline`, passRate: summary.passRate, baselineRate: baseline.passRate };
  if (summary.passRate < baseline.passRate) return { pass: false, reason: `pass rate ${percent(summary.passRate)} is below the baseline ${percent(baseline.passRate)} (${baseline.model}, ${baseline.date.slice(0,10)})`, passRate: summary.passRate, baselineRate: baseline.passRate };
  return { pass: true, reason: `pass rate ${percent(summary.passRate)} meets the baseline ${percent(baseline.passRate)}`, passRate: summary.passRate, baselineRate: baseline.passRate };
}

export const percent = (rate: number | null): string => rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;

export function baselineFrom(summary: EvalsLine, model: string, date: string): Baseline {
  return { stub: summary.evidence === 'stub', harnessVersion: summary.harnessVersion, model, date, evals: summary.evals, passed: summary.passed, total: summary.total, passRate: summary.passRate, criteria: summary.criteria };
}

export function render(run: { summary: EvalsLine | undefined; evals: EvalLine[] }, verdict: Verdict, model: string): string {
  const lines = [`## Authoring evals: ${verdict.pass ? 'pass' : 'fail'}`, '', `Model: \`${model}\`. Pass rate **${percent(verdict.passRate)}** (baseline ${percent(verdict.baselineRate)}). ${verdict.reason}.`, ''];
  if (run.summary) {
    lines.push('| Criterion | Passed |', '|---|---|');
    for (const [id, score] of Object.entries(run.summary.criteria)) lines.push(`| ${id} | ${score.passed}/${score.total} |`);
    lines.push('', '| Eval | Score | Failed criteria |', '|---|---|---|');
    for (const item of run.evals) lines.push(`| ${item.eval} | ${item.score} | ${item.failed.join(', ') || '-'} |`);
  }
  return lines.join('\n') + '\n';
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { log: { type: 'string' }, baseline: { type: 'string', default: join(home, 'runs', 'baseline.json') }, model: { type: 'string', default: 'unknown' }, 'write-baseline': { type: 'boolean', default: false } } });
  if (!values.log) { console.error('Usage: node benchmarks/agent/gate.ts --log runner-output.jsonl [--baseline runs/baseline.json] [--model id] [--write-baseline]'); process.exit(2); }
  const run = parseLog(await readFile(values.log, 'utf8'));
  if (values['write-baseline']) {
    if (!run.summary) { console.error('no evals summary in the log'); process.exit(2); }
    await writeFile(values.baseline, JSON.stringify(baselineFrom(run.summary, values.model, new Date().toISOString()), null, 2) + '\n');
    console.log(`baseline written to ${values.baseline}`);
  } else {
    const baseline = JSON.parse(await readFile(values.baseline, 'utf8').catch(() => 'null')) as Baseline | null;
    const verdict = compare(run, baseline ?? undefined), summary = render(run, verdict, values.model);
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
    console.log(summary);
    process.exitCode = verdict.pass ? 0 : 1;
  }
}
