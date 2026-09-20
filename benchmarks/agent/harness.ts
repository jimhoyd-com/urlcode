// The benchmark harness: tasks, evals, prompts, acceptance execution and the
// run record. run.ts is the command line over this module; the unit tests
// exercise it directly with the stub adapter.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadDocument, parseYaml } from '../../src/config.ts';
import { assert, ConfigError } from '../../src/errors.ts';
import { hit } from '../../src/readiness.ts';
import type { RequestCase } from '../../src/readiness.ts';
import { codeRatio, isExcluded } from './count-lines.ts';
import type { CodeRatio, GeneratedFile } from './count-lines.ts';
import type { AdapterResult, Arm, ModelAdapter } from './adapters.ts';

export const harnessVersion = '1';
export const arms: readonly Arm[] = ['conventional','urlcode'];
export const home = resolve(import.meta.dirname);

export interface Task {
  id: string; title: string; prompt: string; description: string; required: string[];
  /** Application modules beyond `functions/` that count as the idea in either arm. */
  modules: string[];
  acceptance: { fixture: string; note: string };
  /** Operator-provided environment both arms receive (shared tokens, upstream origins). Never a real secret. */
  environment: Record<string, string>;
  /** Directory the task was loaded from. */
  root: string;
}
export type RubricId = typeof rubricIds[number];
export interface EvalExpectation {
  /** Route path to the native handler key the request calls for. */
  handlers: Record<string, string>;
  /** Whether the request needs code at all; when false, any generated JavaScript fails the criterion. */
  javascript: boolean;
  /** Handlers outside the portable subset the request explicitly asks for. */
  allows: string[];
}
export interface Eval { id: string; title: string; prompt: string; rubric: { id: RubricId; description: string }[]; expect: EvalExpectation }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringList = (value: unknown, what: string): string[] => { assert(Array.isArray(value) && value.every(item => typeof item === 'string'), `${what} must be a list of strings`); return value; };

export async function loadTask(root: string): Promise<Task> {
  const file = join(root,'task.yaml'), raw: unknown = parse(await readFile(file,'utf8'));
  assert(isRecord(raw), `${file} must be a mapping`);
  for (const key of ['id','title','prompt','description'] as const) assert(typeof raw[key] === 'string' && raw[key].trim().length > 0, `${file}: ${key} must be text`);
  assert(isRecord(raw.acceptance) && typeof raw.acceptance.fixture === 'string' && typeof raw.acceptance.note === 'string', `${file}: acceptance needs fixture and note paths`);
  const allowed = new Set(['id','title','prompt','description','required','modules','acceptance','environment']);
  assert(raw.environment === undefined || (isRecord(raw.environment) && Object.entries(raw.environment).every(([key,value]) => /^[A-Z][A-Z0-9_]*$/.test(key) && typeof value === 'string')), `${file}: environment must map NAMES to strings`);
  for (const key of Object.keys(raw)) assert(allowed.has(key), `${file}: unknown field ${key}`);
  const task: Task = { id: raw.id as string, title: raw.title as string, prompt: raw.prompt as string, description: raw.description as string,
    required: stringList(raw.required ?? [], `${file}: required`), modules: stringList(raw.modules ?? [], `${file}: modules`),
    acceptance: { fixture: raw.acceptance.fixture, note: raw.acceptance.note }, environment: { ...(raw.environment as Record<string, string> | undefined) }, root };
  assert(task.id === relative(dirname(root), root), `${file}: id must match the directory name`);
  await readFile(join(root, task.acceptance.note), 'utf8');
  validateCases(JSON.parse(await readFile(join(root, task.acceptance.fixture), 'utf8')));
  return task;
}

export async function loadTasks(directory = join(home,'tasks'), only?: readonly string[]): Promise<Task[]> {
  const ids = (await readdir(directory, { withFileTypes:true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  for (const id of only ?? []) assert(ids.includes(id), `Unknown task "${id}"; available: ${ids.join(', ')}`);
  return Promise.all(ids.filter(id => !only || only.includes(id)).map(id => loadTask(join(directory,id))));
}

/** One handler per route; the last five are outside the portable subset every target serves. */
const handlers = new Set(['redirect','respond','page','static','download','function','proxy','signals','conditional','link','extension']);
const nonPortable = ['proxy','signals','conditional','link','extension'];
export const rubricIds = ['native-functionality','valid-yaml','no-unsupported-fields','no-unnecessary-javascript','no-boundary-violations','tests-written','validation-run','provider-limits-respected'] as const;

export async function loadEvals(directory = join(home,'evals')): Promise<Eval[]> {
  const files = (await readdir(directory)).filter(name => name.endsWith('.yaml')).sort();
  return Promise.all(files.map(async name => {
    const file = join(directory,name), raw: unknown = parse(await readFile(file,'utf8'));
    assert(isRecord(raw) && typeof raw.id === 'string' && typeof raw.title === 'string' && typeof raw.prompt === 'string', `${file}: id, title and prompt are required`);
    assert(raw.id === name.slice(0,-5), `${file}: id must match the file name`);
    assert(Array.isArray(raw.rubric) && raw.rubric.length > 0, `${file}: rubric must be a non-empty list`);
    const rubric = raw.rubric.map((item: unknown) => {
      assert(isRecord(item) && typeof item.id === 'string' && typeof item.description === 'string', `${file}: each rubric item needs id and description`);
      assert((rubricIds as readonly string[]).includes(item.id), `${file}: unknown rubric id ${item.id}`);
      return { id: item.id, description: item.description };
    });
    assert(new Set(rubric.map(item => item.id)).size === rubricIds.length, `${file}: rubric must score every criterion exactly once`);
    assert(isRecord(raw.expect) && isRecord(raw.expect.handlers) && Object.keys(raw.expect.handlers).length > 0, `${file}: expect.handlers must map at least one route to a handler`);
    for (const [path, handler] of Object.entries(raw.expect.handlers)) assert(path.startsWith('/') && typeof handler === 'string' && handlers.has(handler), `${file}: expect.handlers ${path} must name a handler (${[...handlers].join(', ')})`);
    assert(typeof raw.expect.javascript === 'boolean', `${file}: expect.javascript must be true or false`);
    const expect: EvalExpectation = { handlers: raw.expect.handlers as Record<string, string>, javascript: raw.expect.javascript, allows: stringList(raw.expect.allows ?? [], `${file}: expect.allows`) };
    for (const key of Object.keys(raw.expect)) assert(['handlers','javascript','allows'].includes(key), `${file}: unknown expect field ${key}`);
    return { id: raw.id, title: raw.title, prompt: raw.prompt, rubric: rubric as Eval['rubric'], expect };
  }));
}

/** Validate a fixture the same way `urlcode test` does, so both arms run identical cases. */
export function validateCases(cases: unknown): RequestCase[] {
  assert(Array.isArray(cases) && cases.length > 0 && cases.length <= 10000, 'Acceptance fixture must be a non-empty array');
  for (const test of cases as unknown[]) {
    assert(isRecord(test), 'Invalid request test');
    assert(typeof test.path === 'string' && test.path.startsWith('/') && !test.path.startsWith('//') && !/[\r\n]/.test(test.path), 'Test path must be local');
    assert(Number.isInteger(test.status) && typeof test.status === 'number' && test.status >= 200 && test.status <= 599, 'Test must declare an HTTP status');
    assert(!test.method || (typeof test.method === 'string' && ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(test.method)), 'Invalid test method');
    assert(test.body === undefined || typeof test.body === 'string', 'Test body must be text');
    assert(test.expectBody === undefined || typeof test.expectBody === 'string', 'Expected body must be text');
    for (const headers of [test.headers,test.expectHeaders]) assert(headers === undefined || (isRecord(headers) && Object.values(headers).every(v => typeof v === 'string')), 'Test headers must be string mappings');
  }
  return cases as RequestCase[]; // trust boundary: fixture JSON, validated field by field above
}

/** The prompt an arm receives: the arm preamble from prompts/, then the task prompt. Stored with each run. */
export async function armPrompt(task: Task, arm: Arm): Promise<string> {
  const preamble = await readFile(join(home,'prompts',`${arm}.md`),'utf8');
  const names = Object.keys(task.environment);
  const environment = names.length ? `\n\nThe operator supplies these environment variables at run time; read them, never hard-code their values: ${names.join(', ')}.` : '';
  return `${preamble.trim()}\n\n# Task: ${task.title}\n\n${task.prompt.trim()}${environment}\n`;
}

export interface CaseResult { case: number; path: string; method: string; expectedStatus: number; status: number; pass: boolean; error?: string | undefined }
export interface AcceptanceResult { total: number; passed: number; failed: number; cases: CaseResult[]; failures: string[]; durationMs: number }

const freePort = () => new Promise<number>((done, fail) => {
  const server = createServer(); server.once('error', fail);
  server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => typeof address === 'object' && address ? done(address.port) : fail(new Error('No port'))); });
});
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function waitForPort(port: number, deadlineMs: number, alive: () => boolean): Promise<boolean> {
  const started = performance.now();
  while (performance.now() - started < deadlineMs) {
    if (!alive()) return false;
    const up = await new Promise<boolean>(done => { const req = request({ host:'127.0.0.1', port, path:'/', method:'HEAD', timeout:1000 }, res => { res.resume(); done(true); }); req.on('error', () => done(false)); req.on('timeout', () => { req.destroy(); done(false); }); req.end(); });
    if (up) return true;
    await sleep(100);
  }
  return alive();
}

/** Conventional arm: start the answer's own server on a free port and run the fixture against it. */
export interface ExecutionOptions { startupMs?: number | undefined; log?: ((line: string) => void) | undefined; environment?: Record<string, string> | undefined }
export async function runConventional(workspace: string, start: string | undefined, cases: readonly RequestCase[], { startupMs = 15000, log = () => {}, environment = {} }: ExecutionOptions = {}): Promise<AcceptanceResult> {
  const began = performance.now();
  if (!start) return { total: cases.length, passed: 0, failed: cases.length, cases: [], failures: ['no start command reported'], durationMs: 0 };
  const port = await freePort(), failures: string[] = [], output: string[] = [];
  // POSIX: its own process group, so stopping the shell also stops the server it started. Windows: cmd.exe, stopped with its whole tree.
  const windows = process.platform === 'win32';
  const env = { ...process.env, ...environment, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' };
  const child = windows
    ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', start], { cwd: workspace, env, stdio: ['ignore','pipe','pipe'], windowsHide: true })
    : spawn('/bin/sh', ['-c', start], { cwd: workspace, env, stdio: ['ignore','pipe','pipe'], detached: true });
  let exited: number | null | undefined;
  child.on('exit', code => { exited = code ?? -1; });
  const stop = (signal: NodeJS.Signals) => {
    try {
      if (windows && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      else if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* already gone */ }
  };
  for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (chunk: string) => { if (output.join('').length < 16384) output.push(chunk); log(chunk); });
  const agent = new Agent({ keepAlive:true, maxSockets:1 }), results: CaseResult[] = [];
  try {
    if (!(await waitForPort(port, startupMs, () => exited === undefined))) {
      failures.push(exited === undefined ? `server did not listen on ${port} within ${startupMs} ms` : `start command exited with ${exited} before listening`);
      if (output.length) failures.push(`output: ${output.join('').slice(0,2000)}`);
      return { total: cases.length, passed: 0, failed: cases.length, cases: [], failures, durationMs: performance.now() - began };
    }
    for (const [i, test] of cases.entries()) {
      const result = await hit({ address: { address:'127.0.0.1', family:'IPv4', port }, root: workspace, testPlan() { throw new Error('unused'); } }, test, agent, { protocol:'http:', hostname:'127.0.0.1', port });
      results.push({ case: i + 1, path: test.path, method: test.method ?? 'GET', expectedStatus: test.status, status: result.status, pass: result.pass, error: result.error });
    }
  } finally {
    agent.destroy();
    if (exited === undefined) { stop('SIGTERM'); await Promise.race([new Promise<void>(done => child.once('exit', () => done())), sleep(3000)]); if (exited === undefined) stop('SIGKILL'); }
    for (const stream of [child.stdout, child.stderr]) stream.destroy();
  }
  const passed = results.filter(r => r.pass).length;
  return { total: cases.length, passed, failed: cases.length - passed, cases: results, failures, durationMs: performance.now() - began };
}

function cli(core: string, args: string[], environment: Record<string, string>, log: (line: string) => void): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(done => {
    const child = spawn(process.execPath, ['--conditions=development', join(core,'src','cli.ts'), ...args], { cwd: core, env: { ...process.env, ...environment }, stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; log(chunk); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; log(chunk); });
    child.on('exit', code => done({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * URLCode arm: write the fixture as the project's `tests/requests.json`, play
 * the operator (grant exactly what `urlcode permissions` requests, in a policy
 * file outside the project) and run `urlcode test` from the core checkout.
 * The grant is part of the record: a real deployment reviews it by hand.
 */
export async function runUrlcode(workspace: string, core: string, cases: readonly RequestCase[], { log = () => {}, environment = {} }: ExecutionOptions = {}): Promise<AcceptanceResult> {
  const began = performance.now();
  await mkdir(join(workspace,'tests'), { recursive:true });
  // The agent's own fixture stays in the count under another name; the acceptance fixture takes its place.
  await rename(join(workspace,'tests','requests.json'), join(workspace,'tests','requests.agent.json')).catch(() => {});
  await writeFile(join(workspace,'tests','requests.json'), JSON.stringify(cases, null, 2) + '\n');
  const results: CaseResult[] = [], failures: string[] = [];
  const requested = await cli(core, ['permissions','--project',workspace], environment, log);
  if (requested.code !== 0) { failures.push(`urlcode permissions exited with ${requested.code}: ${(requested.stderr || requested.stdout).trim().slice(0,2000)}`); return { total: cases.length, passed: 0, failed: cases.length, cases: results, failures, durationMs: performance.now() - began }; }
  const policy = `${workspace}.policy.json`;
  await writeFile(policy, requested.stdout);
  const { code, stdout, stderr } = await cli(core, ['test','--project',workspace,'--policy',policy,'--verbose'], environment, log);
  for (const line of stdout.split('\n').filter(Boolean)) {
    let event: unknown; try { event = JSON.parse(line); } catch { continue; }
    if (isRecord(event) && event.event === 'test' && typeof event.case === 'number') {
      const test = cases[event.case - 1];
      if (test) results.push({ case: event.case, path: test.path, method: test.method ?? 'GET', expectedStatus: test.status, status: typeof event.status === 'number' ? event.status : 0, pass: event.pass === true });
    }
  }
  if (results.length !== cases.length) failures.push(`urlcode test exited with ${code} after ${results.length} of ${cases.length} cases${stderr ? `: ${stderr.trim().slice(0,2000)}` : ''}`);
  const passed = results.filter(r => r.pass).length;
  return { total: cases.length, passed, failed: cases.length - passed, cases: results, failures, durationMs: performance.now() - began };
}

/** Every text file the workspace holds, except the fixture the harness wrote and the excluded directories. */
export async function collectGenerated(workspace: string, written: readonly string[] = []): Promise<GeneratedFile[]> {
  const skip = new Set(written.map(path => path.replace(/\\/g,'/'))), files: GeneratedFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes:true })).sort((a,b) => a.name < b.name ? -1 : 1)) {
      const path = relative(workspace, join(dir, entry.name)).replace(/\\/g,'/');
      if (isExcluded(path) || skip.has(path)) continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name));
      else if (entry.isFile()) { const bytes = await readFile(join(dir, entry.name)); if (!bytes.subarray(0,512).includes(0)) files.push({ path, content: bytes.toString('utf8') }); }
    }
  }
  await walk(workspace);
  return files;
}

export interface SecurityCheck { id: string; pass: boolean; evidence: string[] }
/** Mechanical checks for the obvious mistakes, by pattern over the generated text. A pass is absence of the pattern, nothing more. */
export function securityChecklist(files: readonly GeneratedFile[]): SecurityCheck[] {
  const find = (pattern: RegExp) => files.flatMap(file => file.content.split(/\r?\n/).flatMap((line, i) => pattern.test(line) ? [`${file.path}:${i + 1}`] : [])).slice(0, 10);
  const checks: [string, RegExp][] = [
    ['no-hardcoded-secrets', /\b(?:api[_-]?key|secret|password|client[_-]?secret)\b\s*[:=]\s*["'`][^"'`]{12,}["'`]/i],
    ['no-dynamic-code', /\beval\s*\(|new\s+Function\s*\(/],
    ['no-shell-execution', /child_process|\bexecSync\s*\(|\bspawnSync\s*\(/],
    ['no-tls-verification-disabled', /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/],
  ];
  const result = checks.map(([id, pattern]) => { const evidence = find(pattern); return { id, pass: evidence.length === 0, evidence }; });
  const wildcard = find(/access-control-allow-origin['"]?\s*[:,]\s*['"]\*['"]/i), credentials = find(/access-control-allow-credentials['"]?\s*[:,]\s*['"]?true/i);
  result.push({ id: 'no-wildcard-cors-with-credentials', pass: !(wildcard.length && credentials.length), evidence: wildcard.length && credentials.length ? [...wildcard, ...credentials] : [] });
  return result;
}

export interface Criterion { id: RubricId; pass: boolean; evidence: string }
export interface EvalScore { id: string; passed: number; total: number; criteria: Criterion[] }

/**
 * Score an authoring eval mechanically from what is in the workspace and what
 * the adapter reported. Every criterion is a yes or a no with its evidence; a
 * criterion the harness cannot see (validation-run without a command list)
 * fails rather than being skipped, so the pass rate never flatters a run.
 */
export async function scoreEval(item: Eval, workspace: string, answer: AdapterResult | undefined): Promise<EvalScore> {
  const files = await collectGenerated(workspace);
  const yaml = files.find(file => file.path === 'urlcode.yaml');
  const code = files.filter(file => /\.(?:m?js)$/.test(file.path) && !file.path.startsWith('tests/'));
  const criteria: Criterion[] = [];
  const score = (id: RubricId, pass: boolean, evidence: string) => criteria.push({ id, pass, evidence });
  let parsed: unknown, loaded: Awaited<ReturnType<typeof loadDocument>> | undefined, loadError = '';
  try { parsed = yaml ? parseYaml(yaml.content) : undefined; } catch (error) { loadError = error instanceof Error ? error.message : String(error); }
  const wellFormed = isRecord(parsed) && typeof parsed.version === 'string' && isRecord(parsed.routes);
  score('valid-yaml', wellFormed, yaml ? (wellFormed ? 'urlcode.yaml parses with version and routes' : loadError || 'urlcode.yaml is not a mapping with version and routes') : 'no urlcode.yaml');
  if (wellFormed) { try { loaded = await loadDocument(workspace); } catch (error) { loadError = error instanceof Error ? error.message : String(error); } }
  score('no-unsupported-fields', loaded !== undefined, loaded ? `${Object.keys(loaded.routes).length} routes load against the schema` : loadError || 'project did not load');
  const routes = loaded?.routes ?? {};
  const missing = Object.entries(item.expect.handlers).filter(([path, handler]) => !(path in routes) || !(handler in (routes[path] as object)));
  score('native-functionality', loaded !== undefined && missing.length === 0, missing.length ? `expected ${missing.map(([path, handler]) => `${path}: ${handler}`).join(', ')}` : Object.entries(item.expect.handlers).map(([path, handler]) => `${path}: ${handler}`).join(', '));
  score('no-unnecessary-javascript', item.expect.javascript || code.length === 0, code.length ? `${code.length} JavaScript file(s): ${code.map(file => file.path).join(', ')}${item.expect.javascript ? ' (the request needs code)' : ''}` : 'no JavaScript generated');
  const boundary = code.flatMap(file => file.content.split(/\r?\n/).flatMap((line, i) => /\bfrom\s+['"](?!\.)|\brequire\s*\(|\bimport\s*\(|\bfetch\s*\(|\bprocess\.|node:/.test(line) ? [`${file.path}:${i + 1}`] : []));
  const grants = files.filter(file => /policy.*\.json$/i.test(file.path) || /"projectSha256"/.test(file.content)).map(file => file.path);
  score('no-boundary-violations', boundary.length === 0 && grants.length === 0, [...boundary, ...grants.map(path => `${path} looks like an operator policy`)].join(', ') || 'only relative imports, no host access, no grants in the project');
  const tests = files.find(file => file.path === 'tests/requests.json');
  let cases: RequestCase[] = [];
  try { if (tests) cases = validateCases(JSON.parse(tests.content)); } catch { cases = []; }
  const untested = Object.keys(item.expect.handlers).filter(path => !cases.some(test => matchesRoute(path, test.path)));
  score('tests-written', tests !== undefined && cases.length > 0 && untested.length === 0, tests ? (untested.length ? `no case for ${untested.join(', ')}` : `${cases.length} case(s) cover every expected route`) : 'no tests/requests.json');
  const commands = answer?.commands ?? [];
  const ran = commands.filter(command => /\burlcode\s+(?:validate|test)\b/.test(command));
  score('validation-run', ran.length > 0, ran.length ? ran.join('; ') : (commands.length ? 'no urlcode validate or test among the reported commands' : 'adapter reported no commands'));
  const outside = Object.entries(routes).flatMap(([path, route]) => nonPortable.filter(key => key in (route as object) && !item.expect.allows.includes(key)).map(key => `${path}: ${key}`));
  score('provider-limits-respected', loaded !== undefined && outside.length === 0, outside.join(', ') || (loaded ? 'portable subset only' : 'project did not load'));
  assert(criteria.length === rubricIds.length && item.rubric.every(entry => criteria.some(c => c.id === entry.id)), 'every rubric criterion is scored');
  return { id: item.id, passed: criteria.filter(c => c.pass).length, total: criteria.length, criteria };
}

/** A fixture path exercises a route key when its segments match literally, by `{parameter}` or under a `/*` mount. */
export function matchesRoute(route: string, path: string): boolean {
  const target = path.split('?')[0]!.split('/'), pattern = route.split('/');
  if (pattern.at(-1) === '*') return target.length > pattern.length - 1 && pattern.slice(0, -1).every((segment, i) => segment === target[i]);
  return pattern.length === target.length && pattern.every((segment, i) => segment === target[i] || (/^\{.+\}$/.test(segment) && target[i]!.length > 0));
}

export interface EvalRecord {
  harnessVersion: string; date: string; model: string; eval: string; evidence: 'stub' | 'model';
  promptSha256: string; prompt: string; tokens: { input: number; output: number; total: number }; turns: number; retries: number;
  commands: string[]; failures: string[]; score: EvalScore;
}

/** One authoring eval: the eval preamble from prompts/ plus the request, then the mechanical score. */
export async function runEval(item: Eval, adapter: ModelAdapter, workspace: string, { date = new Date().toISOString() }: RunOptions = {}): Promise<EvalRecord> {
  const preamble = await readFile(join(home,'prompts','eval.md'),'utf8');
  const prompt = `${preamble.trim()}\n\n# Request: ${item.title}\n\n${item.prompt.trim()}\n`;
  let answer: AdapterResult | undefined, generateError: string | undefined;
  try { answer = await adapter.run({ task: `evals/${item.id}`, arm: 'urlcode', prompt, workspace }); }
  catch (error) { generateError = error instanceof Error ? error.message : String(error); }
  const score = await scoreEval(item, workspace, answer);
  return { harnessVersion, date, model: adapter.name, eval: item.id, evidence: adapter.name === 'stub' ? 'stub' : 'model',
    promptSha256: createHash('sha256').update(prompt).digest('hex'), prompt,
    tokens: { input: answer?.tokensIn ?? 0, output: answer?.tokensOut ?? 0, total: (answer?.tokensIn ?? 0) + (answer?.tokensOut ?? 0) }, turns: answer?.turns ?? 0, retries: answer?.retries ?? 0,
    commands: answer?.commands ?? [], failures: generateError ? [`generation failed: ${generateError}`] : [], score };
}

export async function writeEval(root: string, record: EvalRecord, repeat: number): Promise<string> {
  const dir = join(root, `${record.date.slice(0,10)}-${record.model}-evals`);
  assert(/^[a-z0-9][a-z0-9._-]*$/i.test(record.model), 'Run directory needs a plain model name');
  await mkdir(dir, { recursive:true });
  const file = join(dir, `${record.eval}${repeat > 1 ? `-${repeat}` : ''}.json`);
  await writeFile(file, JSON.stringify(record, null, 2) + '\n');
  return file;
}

export function summarizeEvals(records: readonly EvalRecord[]): Record<string, unknown> {
  const byCriterion = Object.fromEntries(rubricIds.map(id => [id, { passed: records.filter(r => r.score.criteria.some(c => c.id === id && c.pass)).length, total: records.length }]));
  const passed = records.reduce((sum, r) => sum + r.score.passed, 0), total = records.reduce((sum, r) => sum + r.score.total, 0);
  return { harnessVersion, evidence: records.every(r => r.evidence === 'model') ? 'model' : 'stub', evals: records.length, passed, total, passRate: total ? passed / total : null, criteria: byCriterion };
}

export interface RunRecord {
  harnessVersion: string; date: string; model: string; arm: Arm; task: string;
  /** Stub runs exercise the pipeline and are never evidence. */
  evidence: 'stub' | 'model';
  promptSha256: string; prompt: string;
  tokens: { input: number; output: number; total: number }; turns: number; retries: number; notes: string | undefined;
  generated: { files: number; lines: number };
  wallMs: { generate: number; acceptance: number; total: number };
  tests: AcceptanceResult; failures: string[];
  security: SecurityCheck[];
  codeRatio: CodeRatio;
}

export interface RunOptions { core?: string; log?: (line: string) => void; date?: string; startupMs?: number }

/** One run of one arm of one task: generate, test, count. The workspace must exist and be empty. */
export async function runArm(task: Task, arm: Arm, adapter: ModelAdapter, workspace: string, { core = resolve(home,'..','..'), log = () => {}, date = new Date().toISOString(), startupMs }: RunOptions = {}): Promise<RunRecord> {
  const prompt = await armPrompt(task, arm), began = performance.now();
  let answer: AdapterResult | undefined, generateError: string | undefined;
  try { answer = await adapter.run({ task: task.id, arm, prompt, workspace }); }
  catch (error) { generateError = error instanceof Error ? error.message : String(error); }
  const generateMs = performance.now() - began;
  const cases = validateCases(JSON.parse(await readFile(join(task.root, task.acceptance.fixture), 'utf8')));
  const fixturePath = 'tests/requests.json';
  const tests = !answer ? { total: cases.length, passed: 0, failed: cases.length, cases: [], failures: [], durationMs: 0 }
    : arm === 'urlcode' ? await runUrlcode(workspace, core, cases, { log, environment: task.environment }) : await runConventional(workspace, answer.start, cases, { log, startupMs, environment: task.environment });
  const files = await collectGenerated(workspace, arm === 'urlcode' ? [fixturePath] : []);
  const ratio = codeRatio(files, [...task.modules, ...(answer?.modules ?? [])]);
  const failures = [...(generateError ? [`generation failed: ${generateError}`] : []), ...tests.failures];
  return {
    harnessVersion, date, model: adapter.name, arm, task: task.id, evidence: adapter.name === 'stub' ? 'stub' : 'model',
    promptSha256: createHash('sha256').update(prompt).digest('hex'), prompt,
    tokens: { input: answer?.tokensIn ?? 0, output: answer?.tokensOut ?? 0, total: (answer?.tokensIn ?? 0) + (answer?.tokensOut ?? 0) },
    turns: answer?.turns ?? 0, retries: answer?.retries ?? 0, notes: answer?.notes,
    generated: { files: ratio.files.length, lines: ratio.total },
    wallMs: { generate: Math.round(generateMs), acceptance: Math.round(tests.durationMs), total: Math.round(performance.now() - began) },
    tests, failures, security: securityChecklist(files), codeRatio: ratio,
  };
}

/** `runs/<date>-<model>-<arm>/`, with the calendar date only so repeated runs on a day land together. */
export function runDirectory(root: string, date: string, model: string, arm: Arm): string {
  const day = date.slice(0,10);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(day) && /^[a-z0-9][a-z0-9._-]*$/i.test(model), 'Run directory needs an ISO date and a plain model name');
  return join(root, `${day}-${model}-${arm}`);
}

export async function writeRun(root: string, record: RunRecord, repeat: number): Promise<string> {
  const dir = runDirectory(root, record.date, record.model, record.arm);
  await mkdir(dir, { recursive:true });
  const file = join(dir, `${record.task}${repeat > 1 ? `-${repeat}` : ''}.json`);
  await writeFile(file, JSON.stringify(record, null, 2) + '\n');
  return file;
}

export function summarize(records: readonly RunRecord[]): Record<string, unknown> {
  const byArm = Object.fromEntries(arms.map(arm => {
    const runs = records.filter(r => r.arm === arm);
    const sum = (pick: (r: RunRecord) => number) => runs.reduce((total, r) => total + pick(r), 0);
    const total = sum(r => r.codeRatio.total);
    return [arm, { runs: runs.length, tasks: [...new Set(runs.map(r => r.task))].length, tokens: sum(r => r.tokens.total), turns: sum(r => r.turns), retries: sum(r => r.retries),
      lines: total, idea: sum(r => r.codeRatio.idea), plumbing: sum(r => r.codeRatio.plumbing), codeRatio: total ? sum(r => r.codeRatio.idea) / total : null,
      testsPassed: sum(r => r.tests.passed), testsTotal: sum(r => r.tests.total), failures: sum(r => r.failures.length), wallMs: sum(r => r.wallMs.total),
      securityFindings: sum(r => r.security.filter(c => !c.pass).length) }];
  }));
  return { harnessVersion, evidence: records.every(r => r.evidence === 'model') ? 'model' : 'stub', arms: byArm };
}

export { ConfigError };
