import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkPage } from '../benchmarks/ab/acceptance/http-page.ts';
import { authorizationVariable, buildPlan, launchRefusal, parseSpec } from '../benchmarks/ab/run.ts';
import { aggregate, docPathsOf, isDiscoveryCall, isRunCommand, parseTranscript, spread, summarizeRecords, summarizeTranscript } from '../benchmarks/ab/summarize.ts';

const exec = promisify(execFile);
const fixture = (name: string) => `benchmarks/ab/fixtures/${name}`;
const helloRaw = 'benchmarks/ab-hello-world/2026-09-20-urlcode-0.4.2/raw';
const blogRaw = 'benchmarks/results/blog-ab-2026-09-20/raw';
const runEntry = (...args: string[]) => exec(process.execPath, ['benchmarks/ab/run.ts', ...args], { env: { ...process.env, [authorizationVariable]: '' } }).then(r => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));

test('single-record layout: tokens, tool calls, failures, doc reads, first success and discovery', async () => {
  const s = await summarizeTranscript(fixture('single-record.jsonl'));
  assert.deepEqual(s.tokens, { input: 5, output: 65, cache_read: 1000, cache_creation: 50, total: 1120 });
  assert.equal(s.apiCalls, 4);
  assert.equal(s.toolCalls, 3);
  assert.equal(s.shellCommands, 3);
  assert.equal(s.failedCommands, 1);
  assert.equal(s.docReads, 1);
  assert.deepEqual(s.docReadPaths, ['docs/', 'llms.txt']);
  // The failed `npm test` is skipped; the heredoc text "npm start" is file content, so the run is `node server.js`.
  assert.equal(s.tokensToFirstSuccess, 162 + 221 + 331);
  assert.equal(s.discoveryCalls, 1);
  assert.equal(s.discoveryShare, 0.33);
  assert.equal(s.durationS, 10);
  assert.equal(s.timeToFirstSuccessS, 9);
});

test('streamed layout: records sharing a message id count once, from the last record; array results and Read paths work', async () => {
  const s = await summarizeTranscript(fixture('streamed.jsonl'));
  assert.deepEqual(s.tokens, { input: 6, output: 122, cache_read: 620, cache_creation: 20, total: 768 });
  assert.equal(s.apiCalls, 4);
  assert.equal(s.toolCalls, 4);
  assert.equal(s.shellCommands, 3);
  assert.equal(s.failedCommands, 0);
  assert.equal(s.docReads, 2);
  assert.deepEqual(s.docReadPaths, ['/work/urlcode/docs/AI-AUTHORING.md', 'schemas/urlcode.schema.json']);
  assert.equal(s.tokensToFirstSuccess, 113 + 191 + 210);
  assert.equal(s.discoveryCalls, 3);
  assert.equal(s.discoveryShare, 0.75);
});

test('a JSON array of records parses like JSONL, and bad input is named', async () => {
  const lines = (await readFile(fixture('single-record.jsonl'), 'utf8')).trim().split('\n');
  const asArray = `[${lines.join(',')}]`;
  assert.deepEqual(summarizeRecords(parseTranscript(asArray)), summarizeRecords(parseTranscript(lines.join('\n'))));
  assert.throws(() => parseTranscript('{"a":1}\nnot json'), /line 2 is not JSON/);
  assert.equal(summarizeRecords([]).tokensToFirstSuccess, null);
  assert.equal(summarizeRecords([]).discoveryShare, null);
});

test('command classification', () => {
  assert.ok(isRunCommand('cd app && npm start'));
  assert.ok(isRunCommand('curl -si http://localhost:3000/'));
  assert.ok(!isRunCommand('npx urlcode serve --help'));
  assert.ok(!isRunCommand('cd src && node src/cli.ts validate --local'));
  assert.deepEqual(docPathsOf({ name: 'Bash', command: 'cd /x/urlcode-src/docs && cat AI-AUTHORING.md', path: '' }), ['/x/urlcode-src/docs/']);
  assert.ok(!isRunCommand('npm install && npx urlcode validate --local'));
  assert.ok(!isRunCommand("cat > README.md <<'E'\nnpm start\nE"));
  assert.ok(isDiscoveryCall({ name: 'Bash', command: 'mkdir -p s && git clone -q x 2>&1 | tail -2; ls; node -v' }));
  assert.ok(isDiscoveryCall({ name: 'Grep', command: '' }));
  assert.ok(!isDiscoveryCall({ name: 'Bash', command: 'npm install' }));
  assert.ok(!isDiscoveryCall({ name: 'Bash', command: 'echo x > a.txt' }));
  assert.ok(!isDiscoveryCall({ name: 'Write', command: '' }));
  assert.deepEqual(docPathsOf({ name: 'Bash', command: 'sed -n 1,40p docs/ASSETS.md', path: '' }), ['docs/ASSETS.md']);
  assert.deepEqual(docPathsOf({ name: 'Bash', command: 'echo docs/x', path: '' }), []);
  assert.deepEqual(docPathsOf({ name: 'Read', command: '', path: '/a/llms-full.txt' }), ['/a/llms-full.txt']);
  assert.deepEqual(docPathsOf({ name: 'Read', command: '', path: '/a/src/index.ts' }), []);
});

test('the recorded hello-world run reproduces the published report figures', async () => {
  const a = await summarizeTranscript(`${helloRaw}/agent-a.transcript.jsonl`), b = await summarizeTranscript(`${helloRaw}/agent-b.transcript.jsonl`);
  assert.deepEqual(a.tokens, { input: 4, output: 1039, cache_read: 71050, cache_creation: 16128, total: 88221 });
  assert.deepEqual(b.tokens, { input: 18, output: 2194, cache_read: 423292, cache_creation: 24640, total: 450144 });
  assert.equal(a.tokensToFirstSuccess, 43088);
  assert.equal(b.tokensToFirstSuccess, 396348);
  assert.equal(b.toolCalls, 8);
  assert.equal(b.docReads, 6);
  assert.equal(b.discoveryCalls, 6);
  assert.equal(b.discoveryShare, 0.75);
  assert.equal(a.failedCommands + b.failedCommands, 0);
});

test('the recorded blog run is parsed by the same code', async () => {
  const a = await summarizeTranscript(`${blogRaw}/agent-a-transcript.jsonl`), b = await summarizeTranscript(`${blogRaw}/agent-b-transcript.jsonl`);
  assert.equal(a.toolCalls, 7);
  assert.equal(b.toolCalls, 28);
  assert.equal(b.apiCalls, 26);
  assert.equal(b.tokens.total, b.tokens.input + b.tokens.output + b.tokens.cache_read + b.tokens.cache_creation);
  assert.ok(b.tokens.output > 20000, 'streamed messages take usage from the last record, not the first partial one');
  assert.equal(typeof b.tokensToFirstSuccess, 'number');
});

test('median and range over repeats', () => {
  assert.deepEqual(spread([5, 1, 3]), { n: 3, median: 3, min: 1, max: 5 });
  assert.deepEqual(spread([4, 1, 2, 10]), { n: 4, median: 3, min: 1, max: 10 });
  assert.equal(spread([]), null);
  const one = summarizeRecords(parseTranscript('')), spreads = aggregate([one, one]);
  assert.deepEqual(spreads.tool_calls, { n: 2, median: 0, min: 0, max: 0 });
  assert.equal(spreads.tokens_to_first_success, null);
});

test('task specs parse and produce a plan for both arms', async () => {
  for (const name of ['hello-world', 'blog']) {
    const spec = parseSpec(await readFile(`benchmarks/ab/tasks/${name}.yaml`, 'utf8'));
    const plan = buildPlan(spec, { repeat: 3, out: '/out', workRoot: '/work' });
    assert.equal(plan.modelRuns, 6);
    assert.equal(plan.arms.length, 2);
    assert.notEqual(plan.arms[0]!.promptSha256, plan.arms[1]!.promptSha256);
    assert.ok(plan.arms.every(arm => !/\{(dir|root|spec)\}/.test(arm.prompt + arm.acceptance.command.join(' '))));
  }
  const spec = parseSpec(await readFile('benchmarks/ab/tasks/hello-world.yaml', 'utf8'));
  assert.throws(() => buildPlan(spec, { repeat: 0, out: '/o', workRoot: '/w' }), /--repeat/);
  assert.throws(() => buildPlan(spec, { repeat: 21, out: '/o', workRoot: '/w' }), /--repeat/);
  assert.throws(() => parseSpec('id: x'), /needs id/);
});

test('launching is refused without the flag, a launcher and the authorization reference', () => {
  assert.match(launchRefusal({ launchModels: false }, {}) ?? '', /--launch-models/);
  assert.match(launchRefusal({ launchModels: true }, { [authorizationVariable]: 'issue 310' }) ?? '', /--launcher/);
  assert.match(launchRefusal({ launchModels: true, launcher: 'x' }, {}) ?? '', new RegExp(authorizationVariable));
  assert.match(launchRefusal({ launchModels: true, launcher: 'x' }, { [authorizationVariable]: '  ' }) ?? '', /authorization/);
  assert.equal(launchRefusal({ launchModels: true, launcher: 'x' }, { [authorizationVariable]: 'issue 310' }), null);
});

test('dry run and the default plan launch nothing and write nothing', async t => {
  const out = await mkdtemp(join(tmpdir(), 'urlcode-ab-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  for (const flags of [['--dry-run'], []]) {
    const r = await runEntry('--task', 'benchmarks/ab/tasks/hello-world.yaml', '--repeat', '3', '--out', out, ...flags);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /6 model runs \(0 are launched/);
    assert.match(r.stdout, /Arm A \(Control\)[\s\S]*Arm B \(URLCode\)/);
    assert.match(r.stdout, /http-page\.ts/);
  }
  assert.deepEqual(await readdir(out), []);
});

test('the entry point refuses --launch-models without a launcher or authorization, before doing anything', async t => {
  const out = await mkdtemp(join(tmpdir(), 'urlcode-ab-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const marker = join(out, 'launched');
  const noLauncher = await runEntry('--task', 'benchmarks/ab/tasks/hello-world.yaml', '--out', out, '--launch-models');
  assert.equal(noLauncher.code, 2);
  const noAuth = await runEntry('--task', 'benchmarks/ab/tasks/hello-world.yaml', '--out', out, '--launch-models', '--launcher', `touch ${marker}`);
  assert.equal(noAuth.code, 2);
  assert.match(noAuth.stderr, /explicit authorization/);
  assert.deepEqual(await readdir(out), []);
});

test('--transcript writes measurements.json in the recorded shape, with median and range for repeats', async t => {
  const out = await mkdtemp(join(tmpdir(), 'urlcode-ab-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const spec = ['--task', 'benchmarks/ab/tasks/hello-world.yaml', '--out', out];
  const one = await runEntry(...spec, '--transcript', `a=${fixture('single-record.jsonl')}`, '--transcript', `b=${fixture('streamed.jsonl')}`, '--derived-note', 'fixtures');
  assert.equal(one.code, 0, one.stderr);
  const single = JSON.parse(await readFile(join(out, 'measurements.json'), 'utf8'));
  assert.equal(single.n, 1);
  assert.equal(single.derived_note, 'fixtures');
  assert.deepEqual(single.agent_a.tokens, { input: 5, output: 65, cache_read: 1000, cache_creation: 50, cumulative_total: 1120 });
  assert.equal(single.agent_b.tokens_to_first_success_incl_issuing_call, 514);
  assert.equal(single.agent_a.failed_commands, 1);

  const many = await runEntry(...spec, '--transcript', `a=${fixture('single-record.jsonl')}`, '--transcript', `a=${fixture('streamed.jsonl')}`, '--transcript', `a=${fixture('single-record.jsonl')}`, '--transcript', `b=${fixture('streamed.jsonl')}`, '--transcript', `b=${fixture('single-record.jsonl')}`, '--transcript', `b=${fixture('streamed.jsonl')}`);
  assert.equal(many.code, 0, many.stderr);
  const repeated = JSON.parse(await readFile(join(out, 'measurements.json'), 'utf8'));
  assert.equal(repeated.n, 3);
  assert.equal(repeated.agent_a.runs.length, 3);
  assert.deepEqual(repeated.agent_a.summary.total_tokens, { n: 3, median: 1120, min: 768, max: 1120 });
  assert.deepEqual(repeated.agent_b.summary.total_tokens, { n: 3, median: 768, min: 768, max: 1120 });
  const bad = await runEntry(...spec, '--transcript', `c=${fixture('streamed.jsonl')}`);
  assert.equal(bad.code, 2);
});

test('hello-world acceptance checks page structure and runs the recorded control app', async () => {
  const good = '<!DOCTYPE html><html><head><title>t</title></head><body><h1>Hello World</h1></body></html>';
  assert.ok(checkPage(200, 'text/html; charset=utf-8', good, 'Hello World').every(c => c.pass));
  assert.ok(checkPage(500, 'text/plain', 'Hello World', 'Hello World').filter(c => !c.pass).length >= 3);
  assert.ok(checkPage(200, 'text/html', good.replace('</body>', ''), 'Hello World').some(c => c.name.startsWith('balanced') && !c.pass));
  const r = await exec('node', ['benchmarks/ab/acceptance/http-page.ts', '--dir', 'benchmarks/ab-hello-world/2026-09-20-urlcode-0.4.2/agent-a/app', '--port', '4291']);
  assert.ok(JSON.parse(r.stdout).every((c: { pass: boolean }) => c.pass));
});
