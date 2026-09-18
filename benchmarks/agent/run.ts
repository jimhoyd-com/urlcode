// The agent benchmark runner. `npm run benchmark:agent` runs the stub adapter
// over every task and both arms, then over the authoring evals, and stores
// one JSON record per run under runs/<date>-<model>-<arm|evals>/. README.md
// explains the numbers.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { selectAdapter } from './adapters.ts';
import type { Arm } from './adapters.ts';
import { arms, ConfigError, home, loadEvals, loadTasks, runArm, runEval, summarize, summarizeEvals, writeEval, writeRun } from './harness.ts';
import type { EvalRecord, RunRecord } from './harness.ts';

const usage = `Usage: node benchmarks/agent/run.ts [options]
  --adapter name     model adapter (default: stub; README.md explains how to add one)
  --arm name         conventional, urlcode or both (default: both)
  --task id          run one task; repeatable (default: every task under tasks/)
  --repeat n         runs per task and arm (default: 1)
  --answers dir      prepared answers for the stub adapter (default: benchmarks/agent/answers)
  --runs dir         where run records are written (default: benchmarks/agent/runs)
  --keep             keep workspaces under the run directory instead of a temporary directory
  --evals            run only the authoring evals (default: tasks, then evals)
  --no-evals         run only the tasks
  --eval id          run one eval; repeatable (default: every eval under evals/)
  --list-evals       print the authoring evals and exit
  --verbose          echo server and test output
  --help`;

const { values } = parseArgs({ options: {
  adapter: { type:'string', default:'stub' }, arm: { type:'string', default:'both' }, task: { type:'string', multiple:true },
  repeat: { type:'string', default:'1' }, answers: { type:'string', default: join(home,'answers') }, runs: { type:'string', default: join(home,'runs') },
  keep: { type:'boolean', default:false }, evals: { type:'boolean', default:false }, 'no-evals': { type:'boolean', default:false }, eval: { type:'string', multiple:true },
  'list-evals': { type:'boolean', default:false }, verbose: { type:'boolean', default:false }, help: { type:'boolean', default:false },
} });

try {
  if (values.help) { console.log(usage); process.exit(0); }
  if (values['list-evals']) {
    for (const item of await loadEvals()) console.log(JSON.stringify({ id: item.id, title: item.title, rubric: item.rubric.map(r => r.id) }));
    process.exit(0);
  }
  if (!['conventional','urlcode','both'].includes(values.arm)) throw new ConfigError('--arm must be conventional, urlcode or both');
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new ConfigError('--repeat must be an integer from 1 to 20');
  const selected: readonly Arm[] = values.arm === 'both' ? arms : [values.arm as Arm];
  const adapter = selectAdapter(values.adapter, { answers: resolve(values.answers) });
  if (values.evals && values['no-evals']) throw new ConfigError('--evals and --no-evals exclude each other');
  const tasks = values.evals ? [] : await loadTasks(undefined, values.task);
  const evals = values['no-evals'] ? [] : (await loadEvals()).filter(item => !values.eval || values.eval.includes(item.id));
  for (const id of values.eval ?? []) if (!evals.some(item => item.id === id)) throw new ConfigError(`Unknown eval "${id}"`);
  const date = new Date().toISOString(), runs = resolve(values.runs), records: RunRecord[] = [], evalRecords: EvalRecord[] = [];
  const log = values.verbose ? (line: string) => process.stderr.write(line) : () => {};
  const scratch = values.keep ? undefined : await mkdtemp(join(tmpdir(),'urlcode-agent-benchmark-'));
  const workspaceFor = async (kind: string, id: string, i: number) => {
    const workspace = scratch ? await mkdtemp(join(scratch, `${id}-${kind}-`)) : join(runs, `${date.slice(0,10)}-${adapter.name}-${kind}`, 'workspaces', `${id}${i > 1 ? `-${i}` : ''}`);
    if (!scratch) { await rm(workspace, { recursive:true, force:true }); await mkdir(workspace, { recursive:true }); }
    return workspace;
  };
  try {
    for (const task of tasks) for (const arm of selected) for (let i = 1; i <= repeat; i++) {
      const record = await runArm(task, arm, adapter, await workspaceFor(arm, task.id, i), { date, log });
      records.push(record);
      const file = await writeRun(runs, record, i);
      console.log(JSON.stringify({ event:'run', task: task.id, arm, repeat: i, evidence: record.evidence, tests: `${record.tests.passed}/${record.tests.total}`, lines: record.codeRatio.total, idea: record.codeRatio.idea, plumbing: record.codeRatio.plumbing,
        codeRatio: record.codeRatio.ratio === null ? null : Number(record.codeRatio.ratio.toFixed(3)), tokens: record.tokens.total, turns: record.turns, failures: record.failures.length, file }));
    }
    for (const item of evals) for (let i = 1; i <= repeat; i++) {
      const record = await runEval(item, adapter, await workspaceFor('evals', item.id, i), { date });
      evalRecords.push(record);
      const file = await writeEval(runs, record, i);
      console.log(JSON.stringify({ event:'eval', eval: item.id, repeat: i, evidence: record.evidence, score: `${record.score.passed}/${record.score.total}`, failed: record.score.criteria.filter(c => !c.pass).map(c => c.id), failures: record.failures.length, file }));
    }
  } finally { if (scratch) await rm(scratch, { recursive:true, force:true }); }
  if (records.length) console.log(JSON.stringify({ event:'summary', ...summarize(records) }));
  if (evalRecords.length) console.log(JSON.stringify({ event:'evals', ...summarizeEvals(evalRecords) }));
  if (records.some(r => r.failures.length || r.tests.failed) || evalRecords.some(r => r.failures.length || r.score.passed < r.score.total)) process.exitCode = 1;
} catch (error) {
  if (error instanceof ConfigError) { console.error(error.message); process.exit(2); }
  throw error;
}
