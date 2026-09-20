// Read-only measurement; never dispatches workflows or changes repository settings.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
export interface Job {
  name: string; conclusion: string | null; created_at?: string | null;
  started_at: string | null; completed_at: string | null;
  steps: { name: string; started_at: string | null; completed_at: string | null }[];
}
export interface Run {
  id: number; event: string; head_sha: string; created_at: string;
  status: string; conclusion: string | null; run_attempt: number; html_url: string;
}
export function seconds(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const value = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
export function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}
export function measure(run: Run, jobs: Job[]) {
  const matrix = jobs.filter(job => /^(verify|workspaces) \(/.test(job.name)).map(job => job.name).sort();
  const staticJob = jobs.find(job => job.name === 'static');
  const lane = jobs.find(job => job.name === 'plan')?.conclusion !== 'success' ? 'legacy-or-unclassified'
    : staticJob?.conclusion === 'skipped' ? 'docs' : staticJob ? 'full' : 'unclassified';
  const active = jobs.filter(job => job.conclusion !== 'skipped');
  const executions = active.map(job => seconds(job.started_at, job.completed_at));
  const complete = run.status === 'completed' && active.length > 0 && executions.every(value => value !== null);
  const end = complete ? active.map(job => job.completed_at!).sort().at(-1)! : null;
  return {
    ...run, lane, matrix,
    // Rerun creation time includes time spent waiting for a human to retry.
    baselineEligible: complete && run.conclusion === 'success' && run.run_attempt === 1,
    elapsedSeconds: complete && run.run_attempt === 1 ? seconds(run.created_at, end) : null,
    runnerMinutes: complete ? executions.reduce<number>((sum, value) => sum + value!, 0) / 60 : null,
    jobs: active.map(job => ({ name: job.name, executionSeconds: seconds(job.started_at, job.completed_at),
      // Job creation can precede dependency resolution. This is observed wait, not guaranteed pure runner queue time.
      creationToStartSeconds: seconds(job.created_at, job.started_at),
      workflowToStartSeconds: seconds(run.created_at, job.started_at),
      steps: job.steps.map(step => ({ name: step.name, executionSeconds: seconds(step.started_at, step.completed_at) })) }))
  };
}
export function summarize(runs: ReturnType<typeof measure>[]) {
  const groups = new Map<string, typeof runs>();
  for (const run of runs) {
    const key = JSON.stringify([run.event, run.lane, run.matrix]);
    const group = groups.get(key) ?? []; group.push(run); groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    const eligible = group.filter(run => run.baselineEligible);
    const values = (items: (number | null)[]) => items.filter((value): value is number => value !== null);
    return { event: group[0]!.event, lane: group[0]!.lane, matrix: group[0]!.matrix,
      totalRuns: group.length, successfulFirstAttempts: eligible.length, sufficientSample: eligible.length >= 20,
      conclusions: Object.fromEntries([...new Set(group.map(run => run.conclusion ?? 'in_progress'))].map(conclusion =>
        [conclusion, group.filter(run => (run.conclusion ?? 'in_progress') === conclusion).length])),
      elapsedSeconds: distribution(values(eligible.map(run => run.elapsedSeconds))),
      runnerMinutes: distribution(values(eligible.map(run => run.runnerMinutes))),
      jobs: [...new Set(eligible.flatMap(run => run.jobs.map(job => job.name)))].sort().map(name => {
        const jobs = eligible.flatMap(run => run.jobs.filter(job => job.name === name));
        return { name, executionSeconds: distribution(values(jobs.map(job => job.executionSeconds))),
          creationToStartSeconds: distribution(values(jobs.map(job => job.creationToStartSeconds))),
          workflowToStartSeconds: distribution(values(jobs.map(job => job.workflowToStartSeconds))) };
      }) };
  });
}
async function main() {
  const limit = Number(process.argv[2] ?? '100');
  const since = process.argv[3];
  assert(Number.isInteger(limit) && limit >= 1 && limit <= 1000, 'Usage: npm run ci:history -- [1..1000] [YYYY-MM-DD]');
  assert(!since || /^\d{4}-\d{2}-\d{2}$/.test(since), 'Use YYYY-MM-DD for the inclusive start date');
  const repo = process.env.GITHUB_REPOSITORY ?? 'jimhoyd-com/urlcode';
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
  const api = async (path: string, paginate = false) => JSON.parse((await exec('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path], { maxBuffer: 32 * 1024 * 1024 })).stdout);
  const runs: Run[] = [];
  for (let page = 1; runs.length < limit; page++) {
    const data = await api(`repos/${repo}/actions/workflows/ci.yml/runs?per_page=100&page=${page}${since ? `&created=${encodeURIComponent(`>=${since}`)}` : ''}`) as { workflow_runs: Run[] };
    runs.push(...data.workflow_runs.slice(0, limit - runs.length));
    if (data.workflow_runs.length < 100) break;
  }
  const measurements: ReturnType<typeof measure>[] = [];
  // Bounded API concurrency; failures stop the report rather than silently shrinking the sample.
  for (let offset = 0; offset < runs.length; offset += 4) {
    measurements.push(...await Promise.all(runs.slice(offset, offset + 4).map(async run => {
      const pages = await api(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`, true) as { jobs: Job[] }[];
      return measure(run, pages.flatMap(page => page.jobs));
    })));
  }
  console.log(JSON.stringify({ repository: repo, generatedAt: new Date().toISOString(), requestedLimit: limit, since: since ?? null,
    notes: ['Latest job results only; earlier retry attempts are not a total usage ledger.',
      'Percentiles use successful first attempts, separated by event, lane and exact matrix.',
      'Use a date cutoff to avoid mixing workflow generations with identical job names.',
      'Wait includes scheduling/dependency delay; runner-minutes are execution time, not billable minutes.',
      'At least 20 successful first attempts per group are needed for the requested baseline.'],
    groups: summarize(measurements), runs: measurements }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
