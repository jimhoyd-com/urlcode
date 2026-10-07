// Reproducer for #1130: on Windows Node 24, test/prepare.test.ts's `npm pack --ignore-scripts --json` once wrote its
// complete JSON and was then killed by a 30 s timeout. This runs the same command on the same two-file fixture
// --runs times, --concurrency at a time, with --burn worker threads spinning the CPU, and records for every run when
// the child exited and when its pipes closed. Each child gets npm-trace.mjs preloaded. A run that does not finish within
// --timeout-ms gets its trace, the tail of npm's own debug log and (on Windows) the child's process tree printed.
// --mode sync uses spawnSync as the test does; --mode legacy as it did before #1135; --mode async uses spawn, which
// tells exit and pipe close apart.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { npmCommand, quietNpmEnv } from '../npm-command.ts';

const { values } = parseArgs({ options: {
  runs: { type: 'string', default: '200' },
  concurrency: { type: 'string', default: '2' },
  burn: { type: 'string', default: '0' },
  mode: { type: 'string', default: 'async' },
  'timeout-ms': { type: 'string', default: '30000' },
  'slow-ms': { type: 'string', default: '10000' },
} });
const runs = Number(values.runs);
const concurrency = Number(values.concurrency);
const timeoutMs = Number(values['timeout-ms']);
const slowMs = Number(values['slow-ms']);
const mode = values.mode;
if (mode !== 'async' && mode !== 'sync' && mode !== 'legacy') throw new Error('--mode is async, sync or legacy');

const burners = Array.from({ length: Number(values.burn) }, () => new Worker('for (;;) Math.sqrt(Math.random());', { eval: true }));
const trace = new URL('./npm-trace.mjs', import.meta.url).href;
const root = mkdtempSync(join(tmpdir(), 'npm-pack-hang-'));
const fixture = (slot: number): string => {
  const dir = join(root, `slot-${slot}`);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'urlcode-prepare-fixture', version: '1.0.0', type: 'module', files: ['dist'], scripts: { prepare: 'node -e 0' } }));
  writeFileSync(join(dir, 'dist', 'addons.json'), 'existing build');
  return dir;
};

interface Outcome { run: number; status: number | null; signal: string | null; exitMs?: number | undefined; closeMs?: number | undefined; totalMs: number; timedOut: boolean; stdoutBytes: number; jsonComplete: boolean }

const processTree = (pid: number): string => {
  if (process.platform !== 'win32') { try { return execFileSync('ps', ['-o', 'pid,ppid,stat,etime,args', '-g', String(pid)], { encoding: 'utf8' }); } catch (error) { return String(error); } }
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$all = Get-CimInstance Win32_Process; $ids = @(${pid}); do { $n = $ids.Count; $ids = @($ids + ($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object ProcessId)) | Select-Object -Unique } while ($ids.Count -ne $n); $all | Where-Object { $ids -contains $_.ProcessId } | Format-Table -AutoSize ProcessId,ParentProcessId,CreationDate,CommandLine | Out-String -Width 400`,
    ], { encoding: 'utf8', timeout: 60_000 });
  } catch (error) { return String(error); }
};

const evidence = (dir: string, traceFile: string, tree: string, outcome: Outcome, stdout: string, stderr: string): void => {
  const logs = join(dir, 'cache', '_logs');
  const debug = existsSync(logs) ? readdirSync(logs).sort().map(name => `--- ${name}\n${readFileSync(join(logs, name), 'utf8').split('\n').slice(-40).join('\n')}`).join('\n') : '(no npm debug log)';
  console.log([
    `::group::run ${outcome.run} ${JSON.stringify(outcome)}`,
    `trace:\n${existsSync(traceFile) ? readFileSync(traceFile, 'utf8') : '(none)'}`,
    `process tree at timeout:\n${tree || '(not taken)'}`,
    `npm debug log (tail):\n${debug}`,
    `stderr:\n${stderr || '(empty)'}`,
    `stdout tail:\n${stdout.slice(-300)}`,
    '::endgroup::',
  ].join('\n'));
};

const once = async (run: number, dir: string): Promise<Outcome> => {
  const traceFile = join(dir, `trace-${run}.txt`);
  rmSync(join(dir, 'cache', '_logs'), { recursive: true, force: true });
  const command = npmCommand(['pack', '--ignore-scripts', '--json']);
  // legacy is the spawn prepare.test.ts used when #1130 failed: default stdio (a stdin pipe too), no quiet settings.
  const quiet = mode === 'legacy' ? {} : quietNpmEnv;
  const env = { ...process.env, npm_config_cache: join(dir, 'cache'), ...quiet, NPM_HANG_TRACE: traceFile, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${trace}`.trim() };
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  if (mode !== 'async') {
    const result = mode === 'legacy'
      ? spawnSync(command.command, command.args, { cwd: dir, env, encoding: 'utf8', timeout: timeoutMs })
      : spawnSync(command.command, command.args, { cwd: dir, env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    const outcome: Outcome = { run, status: result.status, signal: result.signal, totalMs: elapsed(), timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', stdoutBytes: result.stdout?.length ?? 0, jsonComplete: /\]\s*$/.test(result.stdout ?? '') };
    if (outcome.timedOut || outcome.status !== 0 || outcome.totalMs > slowMs) evidence(dir, traceFile, '', outcome, result.stdout ?? '', result.stderr ?? '');
    return outcome;
  }
  return await new Promise<Outcome>(resolve => {
    const child = spawn(command.command, command.args, { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let exitMs: number | undefined;
    let status: number | null = null;
    let signal: string | null = null;
    let tree = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('exit', (code, sig) => { exitMs = elapsed(); status = code; signal = sig; });
    const timer = setTimeout(() => {
      timedOut = true;
      tree = processTree(child.pid!);
      if (process.platform === 'win32') { try { execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)]); } catch { /* already gone */ } } else child.kill('SIGKILL');
      // Pipes held by a surviving grandchild never close; resolve anyway once the tree is killed.
      setTimeout(() => finish(), 2_000);
    }, timeoutMs);
    let done = false;
    const finish = (closeMs?: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const outcome: Outcome = { run, status, signal, exitMs, closeMs, totalMs: elapsed(), timedOut, stdoutBytes: stdout.length, jsonComplete: /\]\s*$/.test(stdout) };
      if (timedOut || status !== 0 || outcome.totalMs > slowMs || (exitMs !== undefined && closeMs !== undefined && closeMs - exitMs > 1_000)) evidence(dir, traceFile, tree, outcome, stdout, stderr);
      resolve(outcome);
    };
    child.on('close', () => finish(elapsed()));
  });
};

const outcomes: Outcome[] = [];
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async (_, slot) => {
  const dir = fixture(slot);
  while (next < runs) {
    const outcome = await once(next++, dir);
    outcomes.push(outcome);
    if ((outcomes.length % 25) === 0) console.log(`${outcomes.length}/${runs} runs`);
  }
}));
for (const burner of burners) await burner.terminate();
rmSync(root, { recursive: true, force: true });

const times = outcomes.map(outcome => outcome.totalMs).sort((a, b) => a - b);
const summary = {
  mode, runs: outcomes.length, concurrency, burn: burners.length, node: process.version, platform: process.platform,
  timedOut: outcomes.filter(outcome => outcome.timedOut).length,
  failed: outcomes.filter(outcome => outcome.status !== 0).length,
  slow: outcomes.filter(outcome => outcome.totalMs > slowMs).length,
  exitedButPipesOpen: outcomes.filter(outcome => outcome.exitMs !== undefined && (outcome.closeMs === undefined || outcome.closeMs - outcome.exitMs > 1_000)).length,
  medianMs: times[Math.floor(times.length / 2)], p99Ms: times[Math.floor(times.length * 0.99)], maxMs: times.at(-1),
};
console.log(JSON.stringify(summary));
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`, { flag: 'a' });
process.exitCode = summary.timedOut || summary.failed ? 1 : 0;
