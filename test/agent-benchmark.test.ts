import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, codeRatio, countLines, isExcluded, normalizePath } from '../benchmarks/agent/count-lines.ts';
import { selectAdapter, stubAdapter } from '../benchmarks/agent/adapters.ts';
import { armPrompt, home, loadEvals, loadTasks, matchesRoute, runArm, runDirectory, runEval, scoreEval, securityChecklist, summarize, summarizeEvals, validateCases, writeEval, writeRun, rubricIds, arms } from '../benchmarks/agent/harness.ts';
import type { Eval } from '../benchmarks/agent/harness.ts';

const scratch = async (t: { after(fn: () => Promise<void>): void }) => { const dir = await mkdtemp(join(tmpdir(),'urlcode-agent-benchmark-test-')); t.after(() => rm(dir, { recursive:true, force:true })); return dir; };

test('the counting rule: functions and declared modules are the idea, everything else is plumbing', () => {
  assert.equal(classify('functions/hello.mjs'), 'idea');
  assert.equal(classify('functions/nested/deep.mjs'), 'idea');
  assert.equal(classify('./functions/hello.mjs'), 'idea');
  assert.equal(classify('app/functions/hello.mjs'), 'idea');
  assert.equal(classify('middleware/auth.mjs'), 'plumbing');
  assert.equal(classify('urlcode.yaml'), 'plumbing');
  assert.equal(classify('server.mjs'), 'plumbing');
  assert.equal(classify('public/index.html'), 'plumbing');
  assert.equal(classify('tests/requests.json'), 'plumbing');
  assert.equal(classify('lib/links.mjs', ['lib/links.mjs']), 'idea');
  assert.equal(classify('lib/links.test.mjs', ['lib/links.mjs']), 'plumbing');
  assert.equal(classify('src/app/notes.mjs', ['src/app/']), 'idea');
  assert.equal(classify('src/app.mjs', ['src/app']), 'plumbing');
  assert.equal(classify('functionsx/a.mjs'), 'plumbing');
  assert.equal(classify('a.mjs', ['']), 'plumbing');
  assert.equal(normalizePath('.\\functions\\a.mjs'), 'functions/a.mjs');
  assert.equal(normalizePath('/lib/a.mjs'), 'lib/a.mjs');
  assert.ok(isExcluded('node_modules/x/index.js'));
  assert.ok(isExcluded('app/dist/bundle.js'));
  assert.ok(isExcluded('.git/config'));
  assert.ok(!isExcluded('lib/distribution.mjs'));
});

test('lines count when not blank; comments count; the ratio is idea over total or null', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('\n\n  \n'), 0);
  assert.equal(countLines('a\r\n\r\n// comment\n  b  \n'), 3);
  const ratio = codeRatio([
    { path: 'functions/a.mjs', content: 'export default () => 1;\n\n// idea comment\n' },
    { path: 'urlcode.yaml', content: 'version: "1"\nroutes:\n  /a:\n    function: {source: functions/a.mjs}\n' },
    { path: 'node_modules/x.js', content: 'ignored\n'.repeat(50) },
    { path: 'lib/table.mjs', content: 'export const t = 1;\n' },
  ], ['lib/table.mjs']);
  assert.deepEqual(ratio.files.map(file => [file.path, file.lines, file.kind]), [['functions/a.mjs', 2, 'idea'], ['lib/table.mjs', 1, 'idea'], ['urlcode.yaml', 4, 'plumbing']]);
  assert.equal(ratio.idea, 3); assert.equal(ratio.plumbing, 4); assert.equal(ratio.total, 7); assert.equal(ratio.ratio, 3 / 7);
  assert.deepEqual(codeRatio([]), { files: [], idea: 0, plumbing: 0, total: 0, ratio: null });
  assert.equal(codeRatio([{ path: 'node_modules/a.js', content: 'x' }]).ratio, null);
});

test('ten tasks load with shared fixtures, notes and a prepared answer for each arm', async () => {
  const tasks = await loadTasks();
  assert.equal(tasks.length, 10);
  assert.deepEqual(tasks.map(task => task.id), ['admin-backend','authenticated-endpoint','contact-form','crud-backend','file-download-service','json-api','redirect-service','static-site-api','url-shortener','webhook-receiver']);
  for (const task of tasks) {
    assert.ok(task.prompt.length > 100 && task.required.length >= 5, `${task.id} has a prompt and a required list`);
    const cases = validateCases(JSON.parse(await readFile(join(task.root, task.acceptance.fixture), 'utf8')));
    assert.ok(cases.length >= 8, `${task.id} has at least eight acceptance cases`);
    for (const arm of arms) {
      const answer = JSON.parse(await readFile(join(home,'answers',task.id,arm,'answer.json'),'utf8')) as { files: string[]; start?: string };
      for (const file of answer.files) assert.ok((await stat(join(home,'answers',task.id,arm,file))).isFile(), `${task.id}/${arm}/${file} exists`);
      if (arm === 'conventional') assert.equal(typeof answer.start, 'string');
      else assert.ok(answer.files.includes('urlcode.yaml'));
      const prompt = await armPrompt(task, arm);
      assert.ok(prompt.includes(`# Task: ${task.title}`) && prompt.includes(task.prompt.trim()));
      for (const name of Object.keys(task.environment)) assert.ok(prompt.includes(name), `${task.id} ${arm} prompt names ${name}`);
    }
  }
  const [only] = await loadTasks(undefined, ['json-api']);
  assert.equal(only?.id, 'json-api');
  await assert.rejects(loadTasks(undefined, ['nope']), /Unknown task "nope"/);
});

test('task definitions are validated: id matches the directory, unknown fields and bad environment names fail', async t => {
  const root = await scratch(t), dir = join(root,'sample');
  await mkdir(join(dir,'acceptance'), { recursive:true });
  const base = { id: 'sample', title: 'Sample', description: 'd', prompt: 'p', acceptance: { fixture: 'acceptance/requests.json', note: 'acceptance/README.md' } };
  await writeFile(join(dir,'acceptance','README.md'), 'note\n');
  await writeFile(join(dir,'acceptance','requests.json'), JSON.stringify([{ path: '/', status: 200 }]));
  const write = (extra: Record<string, unknown>) => writeFile(join(dir,'task.yaml'), JSON.stringify({ ...base, ...extra }));
  await write({});
  assert.equal((await loadTasks(root))[0]?.id, 'sample');
  await write({ id: 'other' }); await assert.rejects(loadTasks(root), /id must match the directory name/);
  await write({ extra: true }); await assert.rejects(loadTasks(root), /unknown field extra/);
  await write({ environment: { lower: 'x' } }); await assert.rejects(loadTasks(root), /environment must map NAMES to strings/);
  await write({ acceptance: { fixture: 'acceptance/missing.json', note: 'acceptance/README.md' } }); await assert.rejects(loadTasks(root));
  await write({});
  await writeFile(join(dir,'acceptance','requests.json'), JSON.stringify([{ path: 'relative', status: 200 }]));
  await assert.rejects(loadTasks(root), /Test path must be local/);
});

test('the authoring evals carry the full rubric and a scoreable expectation', async t => {
  const evals = await loadEvals();
  assert.deepEqual(evals.map(item => item.id), ['add-authenticated-endpoint','add-middleware','add-redirect','create-webhook-endpoint','serve-directory']);
  for (const item of evals) {
    assert.deepEqual(item.rubric.map(entry => entry.id).sort(), [...rubricIds].sort());
    assert.ok(Object.keys(item.expect.handlers).length > 0);
    assert.ok((await stat(join(home,'answers','evals',item.id,'urlcode','urlcode.yaml'))).isFile());
  }
  const dir = await scratch(t);
  const rubric = rubricIds.map(id => ({ id, description: id }));
  const write = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));
  await write('x.yaml', { id: 'x', title: 'X', prompt: 'p', rubric, expect: { handlers: { '/a': 'redirect' }, javascript: false } });
  assert.equal((await loadEvals(dir))[0]?.id, 'x');
  await write('x.yaml', { id: 'y', title: 'X', prompt: 'p', rubric, expect: { handlers: { '/a': 'redirect' }, javascript: false } });
  await assert.rejects(loadEvals(dir), /id must match the file name/);
  await write('x.yaml', { id: 'x', title: 'X', prompt: 'p', rubric: rubric.slice(1), expect: { handlers: { '/a': 'redirect' }, javascript: false } });
  await assert.rejects(loadEvals(dir), /score every criterion exactly once/);
  await write('x.yaml', { id: 'x', title: 'X', prompt: 'p', rubric: [...rubric, { id: 'style', description: 'x' }], expect: { handlers: { '/a': 'redirect' }, javascript: false } });
  await assert.rejects(loadEvals(dir), /unknown rubric id style/);
  await write('x.yaml', { id: 'x', title: 'X', prompt: 'p', rubric, expect: { handlers: { '/a': 'teleport' }, javascript: false } });
  await assert.rejects(loadEvals(dir), /must name a handler/);
  await write('x.yaml', { id: 'x', title: 'X', prompt: 'p', rubric, expect: { handlers: { '/a': 'redirect' } } });
  await assert.rejects(loadEvals(dir), /expect.javascript must be true or false/);
});

test('the security checklist reports pattern evidence and passes clean text', () => {
  const clean = securityChecklist([{ path: 'server.mjs', content: 'const token = process.env.TOKEN;\nres.setHeader("access-control-allow-origin", "https://app.example.com");\n' }]);
  assert.equal(clean.length, 5); assert.ok(clean.every(check => check.pass && check.evidence.length === 0));
  const findings = securityChecklist([
    { path: 'config.mjs', content: 'export const apiKey = "sk-live-0123456789abcdef";\n' },
    { path: 'handler.mjs', content: 'const run = new Function("return 1");\nimport { execSync } from "node:child_process";\n' },
    { path: 'client.mjs', content: 'const agent = new Agent({ rejectUnauthorized: false });\n' },
    { path: 'cors.mjs', content: "res.setHeader('Access-Control-Allow-Origin', '*');\nres.setHeader('Access-Control-Allow-Credentials', 'true');\n" },
  ]);
  assert.deepEqual(findings.map(check => [check.id, check.pass]), [['no-hardcoded-secrets', false], ['no-dynamic-code', false], ['no-shell-execution', false], ['no-tls-verification-disabled', false], ['no-wildcard-cors-with-credentials', false]]);
  assert.deepEqual(findings[0]?.evidence, ['config.mjs:1']);
  assert.deepEqual(findings[4]?.evidence, ['cors.mjs:1', 'cors.mjs:2']);
});

test('fixture paths match route keys literally, by parameter and under a static mount', () => {
  assert.ok(matchesRoute('/a', '/a')); assert.ok(matchesRoute('/a', '/a?x=1')); assert.ok(!matchesRoute('/a', '/a/'));
  assert.ok(matchesRoute('/r/{code}', '/r/abc')); assert.ok(!matchesRoute('/r/{code}', '/r/')); assert.ok(!matchesRoute('/r/{code}', '/r/a/b'));
  assert.ok(matchesRoute('/assets/*', '/assets/site.css')); assert.ok(matchesRoute('/assets/*', '/assets/x/y.css')); assert.ok(!matchesRoute('/assets/*', '/assets'));
  assert.ok(matchesRoute('/', '/')); assert.ok(!matchesRoute('/', '/a'));
});

test('the stub adapter runs both arms of a task end to end and the record says it is not evidence', async t => {
  const root = await scratch(t), [task] = await loadTasks(undefined, ['redirect-service']);
  const adapter = stubAdapter(join(home,'answers'));
  assert.equal(adapter.name, 'stub');
  const records = [];
  for (const arm of arms) {
    const workspace = join(root, arm); await mkdir(workspace);
    const record = await runArm(task!, arm, adapter, workspace, { date: '2026-01-02T03:04:05.000Z' });
    records.push(record);
    assert.equal(record.evidence, 'stub'); assert.equal(record.model, 'stub'); assert.equal(record.arm, arm); assert.equal(record.task, 'redirect-service');
    assert.equal(record.tests.failed, 0, `${arm}: ${JSON.stringify(record.tests.failures)} ${JSON.stringify(record.tests.cases.filter(c => !c.pass))}`);
    assert.equal(record.tests.passed, 9); assert.equal(record.tests.total, 9); assert.deepEqual(record.failures, []);
    assert.equal(record.tokens.total, 0); assert.equal(record.turns, 0);
    assert.ok(record.codeRatio.total > 0 && record.wallMs.total >= record.wallMs.acceptance);
    assert.ok(record.security.every(check => check.pass), JSON.stringify(record.security));
    assert.match(record.promptSha256, /^[0-9a-f]{64}$/);
    assert.ok(!record.codeRatio.files.some(file => file.path === 'tests/requests.json' && arm === 'urlcode'), 'the fixture the harness wrote is not counted');
    const file = await writeRun(root, record, 1);
    assert.equal(file, join(root, `2026-01-02-stub-${arm}`, 'redirect-service.json'));
    assert.equal(JSON.parse(await readFile(file,'utf8')).task, 'redirect-service');
    assert.equal(await writeRun(root, record, 2), join(root, `2026-01-02-stub-${arm}`, 'redirect-service-2.json'));
  }
  const conventional = records[0]!, urlcode = records[1]!;
  assert.ok(conventional.codeRatio.files.some(file => file.path === 'lib/links.mjs' && file.kind === 'idea'), 'the reported module is the idea');
  assert.ok(urlcode.codeRatio.files.some(file => file.path === 'urlcode.yaml' && file.kind === 'plumbing'));
  assert.ok(urlcode.codeRatio.files.some(file => file.path === 'functions/product.mjs' && file.kind === 'idea'));
  assert.ok(urlcode.codeRatio.files.some(file => file.path === 'tests/requests.agent.json'), 'the agent\'s own fixture stays in the count');
  const summary = summarize(records) as { evidence: string; arms: Record<string, { runs: number; testsPassed: number; codeRatio: number | null }> };
  assert.equal(summary.evidence, 'stub');
  assert.equal(summary.arms.conventional?.runs, 1); assert.equal(summary.arms.urlcode?.testsPassed, 9);
  assert.equal(summary.arms.urlcode?.codeRatio, urlcode.codeRatio.ratio);
  assert.equal(runDirectory(root, '2026-01-02T00:00:00Z', 'stub', 'urlcode'), join(root,'2026-01-02-stub-urlcode'));
  assert.throws(() => runDirectory(root, 'today', 'stub', 'urlcode'));
  assert.throws(() => runDirectory(root, '2026-01-02T00:00:00Z', '../x', 'urlcode'));
});

test('a conventional answer that never listens, a missing prepared answer and an unknown adapter are reported, not thrown', async t => {
  const root = await scratch(t), [task] = await loadTasks(undefined, ['json-api']);
  const broken = { name: 'broken', async run({ workspace }: { workspace: string }) { await writeFile(join(workspace,'server.mjs'), 'process.exit(3);\n'); return { tokensIn: 5, tokensOut: 7, turns: 2, retries: 1, files: ['server.mjs'], start: 'node server.mjs' }; } };
  const workspace = join(root,'w'); await mkdir(workspace);
  const record = await runArm(task!, 'conventional', broken, workspace, { startupMs: 5000 });
  assert.equal(record.evidence, 'model'); assert.equal(record.tests.passed, 0); assert.equal(record.tests.total, 12);
  assert.match(record.tests.failures[0]!, /exited with 3 before listening/);
  assert.deepEqual(record.tokens, { input: 5, output: 7, total: 12 }); assert.equal(record.retries, 1);
  const none = join(root,'none'); await mkdir(none);
  const failed = await runArm(task!, 'urlcode', stubAdapter(join(root,'no-answers')), none);
  assert.match(failed.failures[0]!, /generation failed: No prepared urlcode answer/);
  assert.equal(failed.tests.failed, 12);
  assert.throws(() => selectAdapter('gpt-x', { answers: root }), /Unknown adapter "gpt-x"/);
  assert.equal(selectAdapter('stub', { answers: root }).name, 'stub');
});

test('an authoring eval is scored mechanically from the workspace and the reported commands', async t => {
  const root = await scratch(t), evals = await loadEvals();
  const item = evals.find(entry => entry.id === 'add-redirect')!;
  const good = join(root,'good'); await mkdir(good);
  const record = await runEval(item, stubAdapter(join(home,'answers')), good, { date: '2026-01-02T03:04:05.000Z' });
  assert.equal(record.evidence, 'stub'); assert.equal(record.score.passed, 8); assert.equal(record.score.total, 8);
  assert.deepEqual(record.commands, ['urlcode validate --local', 'urlcode test']);
  assert.equal(await writeEval(root, record, 1), join(root,'2026-01-02-stub-evals','add-redirect.json'));
  const summary = summarizeEvals([record]) as { passRate: number; criteria: Record<string, { passed: number; total: number }> };
  assert.equal(summary.passRate, 1); assert.equal(summary.criteria['tests-written']?.passed, 1);

  // The same request answered badly: a function where a redirect would do, a Node import, a policy in the project, no tests, no validation.
  const bad = join(root,'bad'); await mkdir(join(bad,'functions'), { recursive:true });
  await writeFile(join(bad,'urlcode.yaml'), 'version: "1"\nroutes:\n  /old-pricing:\n    function: {source: functions/go.mjs}\n');
  await writeFile(join(bad,'functions','go.mjs'), "import { readFileSync } from 'node:fs';\nexport default () => Response.redirect('https://example.com/pricing', 301);\n");
  await writeFile(join(bad,'policy.json'), '{"version":1,"projectSha256":"x","routes":{}}');
  const score = await scoreEval(item, bad, { tokensIn: 0, tokensOut: 0, turns: 1, retries: 0, files: [], commands: ['ls'] });
  const by = Object.fromEntries(score.criteria.map(c => [c.id, c]));
  assert.equal(by['valid-yaml']?.pass, true); assert.equal(by['no-unsupported-fields']?.pass, true);
  assert.equal(by['native-functionality']?.pass, false); assert.match(by['native-functionality']!.evidence, /\/old-pricing: redirect/);
  assert.equal(by['no-unnecessary-javascript']?.pass, false);
  assert.equal(by['no-boundary-violations']?.pass, false); assert.match(by['no-boundary-violations']!.evidence, /functions\/go.mjs:1/); assert.match(by['no-boundary-violations']!.evidence, /policy.json looks like an operator policy/);
  assert.equal(by['tests-written']?.pass, false);
  assert.equal(by['validation-run']?.pass, false); assert.match(by['validation-run']!.evidence, /no urlcode validate or test/);
  assert.equal(by['provider-limits-respected']?.pass, true);
  assert.equal(score.passed, 3);

  // Unsupported fields fail the schema criterion but not the YAML one; a proxy fails the portable-subset criterion unless allowed.
  const odd = join(root,'odd'); await mkdir(odd);
  await writeFile(join(odd,'urlcode.yaml'), 'version: "1"\nroutes:\n  /old-pricing:\n    redirect: {url: https://example.com/pricing, status: 301}\n    timeout: 5\n');
  const oddScore = Object.fromEntries((await scoreEval(item, odd, undefined)).criteria.map(c => [c.id, c.pass]));
  assert.equal(oddScore['valid-yaml'], true); assert.equal(oddScore['no-unsupported-fields'], false); assert.equal(oddScore['native-functionality'], false);
  await writeFile(join(odd,'urlcode.yaml'), 'version: "1"\nroutes:\n  /old-pricing:\n    proxy: {url: https://example.com/pricing}\n');
  const proxied: Eval = { ...item, expect: { handlers: { '/old-pricing': 'proxy' }, javascript: false, allows: [] } };
  assert.equal((await scoreEval(proxied, odd, undefined)).criteria.find(c => c.id === 'provider-limits-respected')?.pass, false);
  assert.equal((await scoreEval({ ...proxied, expect: { ...proxied.expect, allows: ['proxy'] } }, odd, undefined)).criteria.find(c => c.id === 'provider-limits-respected')?.pass, true);
  const missing = join(root,'missing'); await mkdir(missing);
  const empty = await scoreEval(item, missing, undefined);
  assert.deepEqual(empty.criteria.filter(c => c.pass).map(c => c.id), ['no-unnecessary-javascript','no-boundary-violations'], 'an empty workspace passes only the two absence criteria');
});

// --- The Anthropic adapter, driven by a fake fetch and a fake command runner; nothing here touches the network. ---
import { anthropicAdapter, anthropicFromEnvironment, defaultModel } from '../benchmarks/agent/adapters/anthropic.ts';
import { baselineFrom, compare, parseLog, render } from '../benchmarks/agent/gate.ts';

type Canned = { status?: number; headers?: Record<string, string>; body: unknown };
const reply = (content: unknown[], stop = 'tool_use', usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 }) => ({ body: { model: 'served-model', content, stop_reason: stop, usage } });
const use = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
function fakeFetch(script: Canned[]) {
  const calls: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const call = async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const next = script.shift(); if (!next) throw new Error('fake fetch exhausted');
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { 'content-type': 'application/json', ...next.headers } });
  };
  return { calls, fetch: call as unknown as typeof fetch };
}
const fakeExec = () => { const ran: { file: string; args: string[]; cwd: string }[] = []; return { ran, exec: async (c: { file: string; args: string[]; cwd: string }) => { ran.push(c); return { code: 0, output: 'ok' }; } }; };

test('the anthropic adapter runs the loop over fetch, writes only inside the workspace and reports the usage fields', async t => {
  const workspace = await scratch(t), { ran, exec } = fakeExec();
  const api = fakeFetch([
    { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } } },
    reply([{ type: 'text', text: 'Writing.' }, use('t1','write_file',{ path: 'urlcode.yaml', content: 'version: "1"\nroutes: {}\n' }), use('t2','write_file',{ path: 'tests/requests.json', content: '[]' })]),
    reply([use('t3','write_file',{ path: '../escape.txt', content: 'x' }), use('t4','read_file',{ path: '/etc/passwd' }), use('t5','run_command',{ command: 'urlcode validate --project /elsewhere' }), use('t6','run_command',{ command: 'rm -rf /' })]),
    reply([use('t7','run_command',{ command: 'urlcode validate --local' }), use('t8','run_command',{ command: 'urlcode test' })]),
    reply([{ type: 'text', text: 'Done.' }], 'end_turn'),
    reply([use('t9','finish',{ modules: ['functions/x.mjs'], summary: 'A redirect.' })]),
  ]);
  const adapter = anthropicAdapter({ apiKey: 'k', fetch: api.fetch, exec, sleep: async () => {}, core: join(home,'..','..') });
  assert.equal(adapter.name, defaultModel);
  const result = await adapter.run({ task: 'evals/add-redirect', arm: 'urlcode', prompt: 'Add a redirect', workspace });
  assert.deepEqual(result.files, ['tests/requests.json','urlcode.yaml']);
  assert.equal(await readFile(join(workspace,'urlcode.yaml'),'utf8'), 'version: "1"\nroutes: {}\n');
  assert.equal(await stat(join(workspace,'..','escape.txt')).catch(() => null), null);
  assert.deepEqual(result.commands, ['urlcode validate --local','urlcode test']);
  assert.deepEqual(result.modules, ['functions/x.mjs']);
  assert.equal(result.retries, 1); assert.equal(result.turns, 5);
  assert.equal(result.tokensIn, 5 * 105); assert.equal(result.tokensOut, 5 * 20);
  assert.match(result.notes ?? '', /served by served-model/);
  // Commands run the core CLI against the workspace, never a model-supplied project path.
  assert.equal(ran.length, 2); assert.equal(ran[0]!.cwd, await realpath(workspace)); assert.equal(ran[0]!.file, process.execPath);
  assert.ok(ran[0]!.args.includes('--project') && ran[0]!.args.includes('validate'));
  // The request carries the key, the version, the reference material for the URLCode arm and the tools; the refused calls came back as tool errors.
  const first = api.calls[1]!;
  assert.equal(first.headers['x-api-key'], 'k'); assert.equal(first.headers['anthropic-version'], '2023-06-01'); assert.equal(first.body.model, defaultModel);
  assert.ok((first.body.system as { text: string }[]).some(block => block.text.includes('<reference path="skills/urlcode/SKILL.md">')));
  assert.deepEqual((first.body.tools as { name: string }[]).map(tool => tool.name), ['list_files','read_file','write_file','run_command','finish']);
  const errors = (api.calls[3]!.body.messages as { role: string; content: { is_error?: boolean; content: string }[] }[]).at(-1)!.content;
  assert.equal(errors.length, 4); assert.ok(errors.every(block => block.is_error));
  assert.match(errors[0]!.content, /leaves the workspace/); assert.match(errors[2]!.content, /paths outside the workspace/); assert.match(errors[3]!.content, /only urlcode/);
  // The conventional arm gets no URLCode material and a different allow-list.
  const plain = fakeFetch([reply([use('c1','run_command',{ command: 'urlcode validate' })]), reply([use('c2','finish',{ start: 'node server.mjs' })])]);
  const other = await anthropicAdapter({ apiKey: 'k', fetch: plain.fetch, exec, sleep: async () => {} }).run({ task: 'redirect-service', arm: 'conventional', prompt: 'p', workspace: await scratch(t) });
  assert.equal(other.start, 'node server.mjs'); assert.deepEqual(other.commands, []);
  assert.ok(!(plain.calls[0]!.body.system as { text: string }[]).some(block => block.text.includes('<reference')));
});

test('the anthropic adapter stops at its caps, surfaces refusals and needs a key', async t => {
  const loop = (n: number) => Array.from({ length: n }, (_, i) => reply([use(`w${i}`,'write_file',{ path: `f${i}.txt`, content: 'x'.repeat(100) })]));
  const base = { apiKey: 'k', sleep: async () => {}, exec: fakeExec().exec };
  await assert.rejects(anthropicAdapter({ ...base, fetch: fakeFetch(loop(5)).fetch, maxTurns: 3 }).run({ task: 't', arm: 'urlcode', prompt: 'p', workspace: await scratch(t) }), /turn cap of 3/);
  await assert.rejects(anthropicAdapter({ ...base, fetch: fakeFetch(loop(5)).fetch, maxBytes: 250 }).run({ task: 't', arm: 'urlcode', prompt: 'p', workspace: await scratch(t) }), /byte cap of 250/);
  let clock = 0;
  await assert.rejects(anthropicAdapter({ ...base, fetch: fakeFetch(loop(5)).fetch, now: () => (clock += 1000), maxWallMs: 1500 }).run({ task: 't', arm: 'urlcode', prompt: 'p', workspace: await scratch(t) }), /wall-time cap/);
  await assert.rejects(anthropicAdapter({ ...base, fetch: fakeFetch([{ body: { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber', explanation: 'no' } } }]).fetch }).run({ task: 't', arm: 'urlcode', prompt: 'p', workspace: await scratch(t) }), /model refused \(cyber\)/);
  await assert.rejects(anthropicAdapter({ ...base, fetch: fakeFetch([{ status: 401, body: { error: { message: 'bad key' } } }]).fetch }).run({ task: 't', arm: 'urlcode', prompt: 'p', workspace: await scratch(t) }), /Messages API 401 error/);
  await assert.rejects(anthropicAdapter({ ...base, maxRetries: 1, fetch: fakeFetch([{ status: 429, body: {} }, { status: 429, body: {} }]).fetch }).run({ task: 't', arm: 'urlcode', prompt: 'p', workspace: await scratch(t) }), /Messages API 429 error/);
  assert.throws(() => anthropicFromEnvironment({}), /ANTHROPIC_API_KEY/);
  assert.equal(anthropicFromEnvironment({ ANTHROPIC_API_KEY: 'k', URLCODE_BENCHMARK_MODEL: 'some-model' }).name, 'some-model');
  assert.throws(() => anthropicAdapter({ apiKey: 'k', model: '../x' }), /plain name/);
});

test('the eval gate reads the runner log, treats a stub baseline as no baseline and fails on a drop or a broken run', () => {
  const log = (rate: number, failures = 0, evidence = 'model') => [
    JSON.stringify({ event: 'eval', eval: 'add-redirect', score: '8/8', failed: [], failures }), 'noise',
    JSON.stringify({ event: 'evals', harnessVersion: '1', evidence, evals: 1, passed: Math.round(rate * 8), total: 8, passRate: rate, criteria: { 'valid-yaml': { passed: 1, total: 1 } } }),
  ].join('\n');
  const run = parseLog(log(1)); assert.equal(run.evals.length, 1); assert.equal(run.summary?.passRate, 1);
  const stub = baselineFrom(parseLog(log(1, 0, 'stub')).summary!, 'stub', '2026-01-01T00:00:00Z'); assert.equal(stub.stub, true);
  assert.equal(compare(parseLog(log(0.5)), stub).pass, true);
  assert.equal(compare(parseLog(log(0.5)), undefined).pass, true);
  const real = baselineFrom(run.summary!, 'm', '2026-01-02T00:00:00Z'); assert.equal(real.stub, false);
  assert.equal(compare(parseLog(log(1)), real).pass, true);
  const drop = compare(parseLog(log(0.875)), real); assert.equal(drop.pass, false); assert.match(drop.reason, /87\.5% is below the baseline 100\.0%/);
  assert.match(compare(parseLog(log(1, 1)), real).reason, /generation failed for add-redirect/);
  assert.equal(compare(parseLog('nothing'), real).pass, false);
  assert.equal(compare(parseLog(log(0.5)), { ...real, harnessVersion: '0' }).pass, true);
  assert.match(render(run, drop, 'm'), /## Authoring evals: fail[\s\S]*\| valid-yaml \| 1\/1 \|[\s\S]*\| add-redirect \| 8\/8 \| - \|/);
});
