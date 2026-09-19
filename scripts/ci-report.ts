import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const id = process.argv[2];
assert(id && /^\d+$/.test(id), 'Usage: npm run ci:report -- RUN_ID');
const repo = process.env.GITHUB_REPOSITORY ?? 'jimhoyd-com/urlcode';
assert.match(repo, /^[\w.-]+\/[\w.-]+$/);
const api = (path: string, paginate = false): unknown => JSON.parse(execFileSync('gh', ['api', ...(paginate ? ['--paginate', '--slurp'] : []), path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
interface Step { name: string; started_at: string | null; completed_at: string | null; conclusion: string | null }
interface Job extends Step { id: number; steps: Step[] }
const run = api(`repos/${repo}/actions/runs/${id}`) as { created_at: string; updated_at: string; status: string; conclusion: string | null; html_url: string };
const pages = api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`, true) as { jobs: Job[] }[];
const seconds = (start: string | null, end: string | null) => start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null;
console.log(JSON.stringify({ url: run.html_url, status: run.status, conclusion: run.conclusion,
  elapsedSeconds: run.status === 'completed' ? seconds(run.created_at, run.updated_at) : null,
  jobs: pages.flatMap(page => page.jobs).map(job => ({ name: job.name, conclusion: job.conclusion,
    // This includes dependency wait, not just runner queueing.
    secondsFromWorkflowCreationToStart: seconds(run.created_at, job.started_at),
    executionSeconds: seconds(job.started_at, job.completed_at),
    steps: job.steps.map(step => ({ name: step.name, conclusion: step.conclusion, executionSeconds: seconds(step.started_at, step.completed_at) }))
  })) }, null, 2));
