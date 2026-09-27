// Runs one reproducer command repeatedly and records what happened, for the
// manually dispatched #708 workflow (.github/workflows/v8-jit-repro.yml).
// It never retries a crash away: every run's exit code is recorded, a run that
// fails is counted, and this script exits 1 if any run failed or timed out. For the
// sandbox-test reproducer a failure can also be an ordinary test failure: the
// `fatal` and `signature` fields say whether V8 aborted and whether it was #708's check.
//
// Usage: node scripts/repro/run-capture.mjs --label NAME --runs K --timeout-ms T --log-dir DIR -- <command> [args...]
// Writes DIR/NAME-run<i>.log (stdout+stderr) for every crashed or timed-out run and the first run,
// DIR/NAME-summary.json, and appends a Markdown table to $GITHUB_STEP_SUMMARY when it is set.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
if (split < 0 || split === argv.length - 1) throw new Error('Usage: run-capture.mjs --label NAME --runs K --timeout-ms T --log-dir DIR -- <command> [args...]');
const opts = { label: 'repro', runs: 1, timeoutMs: 600000, logDir: 'repro-logs' };
for (let i = 0; i < split; i += 2) {
  const [key, value] = [argv[i], argv[i + 1]];
  if (value === undefined) throw new Error(`${key} needs a value`);
  if (key === '--label') opts.label = value;
  else if (key === '--runs') opts.runs = Number(value);
  else if (key === '--timeout-ms') opts.timeoutMs = Number(value);
  else if (key === '--log-dir') opts.logDir = value;
  else throw new Error(`Unknown option ${key}`);
}
if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive integer');
const [command, ...args] = argv.slice(split + 1);
await mkdir(opts.logDir, { recursive: true });

// V8_Fatal prints a block starting with "# Fatal error" (or "Check failed") and a native stack.
const FATAL = /Fatal error|Check failed|V8_Fatal|Native stack trace|FailureMessage/;
function fatalBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => FATAL.test(line));
  return start < 0 ? '' : lines.slice(Math.max(0, start - 2), start + 120).join('\n');
}

function once(index) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const chunks = [];
    child.stdout.on('data', chunk => { chunks.push(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { chunks.push(chunk); process.stderr.write(chunk); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs);
    child.on('error', error => { chunks.push(Buffer.from(`\n[run-capture] spawn error: ${error.message}\n`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8');
      const fatal = fatalBlock(output);
      // Record the raw code as well: on Windows an abort is typically 3 or 0x80000003/0xC0000409.
      const failed = !timedOut && (code !== 0 || signal !== null);
      resolve({ run: index, code, codeHex: typeof code === 'number' ? `0x${(code >>> 0).toString(16)}` : null, signal, timedOut, failed, fatalSeen: fatal !== '',
        elapsedMs: Date.now() - started, fatal, output, signature: /jit_page_->allocations_\.erase\(addr\) == 1/.test(output) });
    });
  });
}

const results = [];
for (let i = 1; i <= opts.runs; i++) {
  console.log(`[run-capture] ${opts.label} run ${i}/${opts.runs}: ${[command, ...args].join(' ')}`);
  const result = await once(i);
  if (i === 1 || result.failed || result.fatalSeen || result.timedOut) await writeFile(join(opts.logDir, `${opts.label}-run${i}.log`), result.output);
  delete result.output;
  results.push(result);
  console.log(`[run-capture] ${opts.label} run ${i}: exit=${result.code} (${result.codeHex}) signal=${result.signal} timedOut=${result.timedOut} failed=${result.failed} fatal=${result.fatalSeen} signature=${result.signature} ${result.elapsedMs}ms`);
  if (result.fatal) console.log(`[run-capture] fatal block:\n${result.fatal}`);
}
const failures = results.filter(r => r.failed);
const fatals = results.filter(r => r.fatalSeen);
const summary = { label: opts.label, node: process.version, platform: process.platform, arch: process.arch, command: [command, ...args],
  runs: results.length, failed: failures.length, fatal: fatals.length, matchingSignature: results.filter(r => r.signature).length,
  timeouts: results.filter(r => r.timedOut).length, results };
await writeFile(join(opts.logDir, `${opts.label}-summary.json`), JSON.stringify(summary, null, 2));
const line = `${failures.length}/${results.length} runs failed; ${fatals.length} printed a V8 fatal error, ${summary.matchingSignature} with the #708 signature; ${summary.timeouts} timed out.`;
console.log(`[run-capture] ${opts.label}: ${line}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(r => `| ${r.run} | ${r.code} (${r.codeHex}) | ${r.signal ?? ''} | ${r.timedOut} | ${r.failed} | ${r.fatalSeen} | ${r.signature} | ${r.elapsedMs} |`);
  const fatal = fatals.map(r => `<details><summary>run ${r.run} fatal block</summary>\n\n\`\`\`\n${r.fatal}\n\`\`\`\n</details>`);
  await appendFile(process.env.GITHUB_STEP_SUMMARY, [`### ${opts.label} on ${process.platform} ${process.version}`, '',
    line, '',
    '| run | exit | signal | timed out | failed | V8 fatal | #708 signature | ms |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows, '', ...fatal, ''].join('\n'));
}
process.exit(failures.length || fatals.length || summary.timeouts ? 1 : 0);
