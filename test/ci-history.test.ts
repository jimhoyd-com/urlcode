import test from 'node:test';
import assert from 'node:assert/strict';
import { distribution, measure, seconds, summarize, type Job, type Run } from '../scripts/ci-history.ts';
const at = (second: number) => new Date(Date.UTC(2026, 8, 19, 0, 0, second)).toISOString();
const run: Run = { id: 1, event: 'push', head_sha: 'a', created_at: at(0), status: 'completed', conclusion: 'success', run_attempt: 1, html_url: 'https://example.test/1' };
const job = (name: string, start = 10, end = 70): Job => ({ name, conclusion: 'success', created_at: at(5), started_at: at(start), completed_at: at(end), steps: [] });
test('percentiles use nearest rank and reject missing, invalid or negative durations', () => {
  assert.deepEqual(distribution([]), { samples: 0, p50: null, p95: null });
  assert.deepEqual(distribution(Array.from({ length: 20 }, (_, i) => 20 - i)), { samples: 20, p50: 10, p95: 19 });
  for (const value of [seconds(null, at(1)), seconds('invalid', at(1)), seconds(at(2), at(1))]) assert.equal(value, null);
});
test('runner time sums overlapping executions while wall time ends at the last job', () => {
  const result = measure(run, [job('plan', 1, 5), job('static'), job('verify (ubuntu-latest, 24)', 15, 75)]);
  assert.equal(result.elapsedSeconds, 75);
  assert.equal(result.runnerMinutes, 124 / 60);
  assert.equal(result.jobs[1]!.creationToStartSeconds, 5);
  assert.equal(result.jobs[1]!.workflowToStartSeconds, 10);
});
test('docs skips do not count as execution and missing active durations prevent baseline inclusion', () => {
  const jobs = [job('plan'), { ...job('static'), conclusion: 'skipped', started_at: null, completed_at: null }];
  const result = measure(run, jobs);
  assert.equal(result.lane, 'docs'); assert.equal(result.runnerMinutes, 1);
  assert(result.baselineEligible);
  const incomplete = measure(run, [...jobs, { ...job('docs'), completed_at: null }]);
  assert.equal(incomplete.runnerMinutes, null); assert(!incomplete.baselineEligible);
});
test('baseline separates events and matrices and excludes failed or retried runs', () => {
  const jobs = [job('plan'), job('static'), job('verify (ubuntu-latest, 24)')];
  const records = Array.from({ length: 20 }, (_, id) => measure({ ...run, id }, jobs));
  records.push(measure({ ...run, conclusion: 'failure' }, jobs), measure({ ...run, run_attempt: 2 }, jobs),
    measure({ ...run, event: 'pull_request' }, jobs), measure(run, [...jobs, job('verify (windows-latest, 24)')]));
  const groups = summarize(records);
  assert.equal(groups.length, 3); assert.equal(groups[0]!.successfulFirstAttempts, 20);
  assert(groups[0]!.sufficientSample); assert(!groups[1]!.sufficientSample);
  assert.equal(groups[0]!.conclusions.failure, 1);
  assert.equal(measure({ ...run, run_attempt: 2 }, jobs).elapsedSeconds, null);
});
