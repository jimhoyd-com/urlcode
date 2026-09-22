// Spawn the real coordinator with isolated process-boundary mocks. These tests
// exercise fail-closed ordering; they do not claim any real publication proof.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(new URL('../scripts/release-run.ts', import.meta.url));
const sha = 'a'.repeat(40);
interface Call { program: string; args: string[] }
async function scenario(args: string[], publishedTarget = false, channels: Record<string, string> = {}): Promise<{ status: number; output: string; calls: Call[]; rootManifest: string }> {
  const root = await mkdtemp(join(tmpdir(), 'urlcode-coordinator-test-'));
  try {
    const directories = ['.', 'packages/ui', 'packages/auth', 'packages/admin', 'packages/store'];
    for (const directory of directories) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, 'package.json'), JSON.stringify({
        name: directory === '.' ? '@jimhoyd/urlcode' : `@jimhoyd/urlcode-${directory.split('/')[1]}`,
        version: '0.4.0-alpha.4', license: 'Apache-2.0',
      }));
    }
    const log = join(root, 'calls.jsonl');
    const preload = join(root, 'boundary-mocks.mjs');
    await writeFile(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const sha = ${JSON.stringify(sha)};
const log = ${JSON.stringify(log)};
const record = (program, args) => appendFileSync(log, JSON.stringify({ program, args }) + '\\n');
const reply = (value, options) => options?.encoding ? value : Buffer.from(value);
const workflowRun = (id) => ({ id, head_sha: sha, head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', path: id === 202 ? '.github/workflows/candidate.yml' : '.github/workflows/ci.yml' });
childProcess.execFileSync = (program, args, options) => {
  record(program, args);
  if (program === 'git') {
    if (args[0] === 'rev-parse') return reply(sha + '\\n', options);
    if (args[0] === 'ls-remote' || args[0] === 'status') return reply('', options);
    throw new Error('Unexpected git command: ' + JSON.stringify(args));
  }
  if (program !== 'gh') throw new Error('Unexpected executable: ' + program);
  if (args[0] === 'pr' && args[1] === 'list') return reply('[]', options);
  if (args[0] === 'run' && args[1] === 'watch') return reply('', options);
  if (args[0] !== 'api' || args.includes('--method') || args.includes('-X')) throw new Error('Forbidden mutation in boundary fixture: ' + JSON.stringify(args));
  const endpoint = args.find(arg => arg.startsWith('repos/'));
  let body;
  if (endpoint.includes('/compare/')) body = { status: 'identical' };
  else if (endpoint.includes('/git/matching-refs/')) body = [];
  else if (endpoint.includes('/workflows/ci.yml/runs')) body = { workflow_runs: [workflowRun(101)] };
  else if (endpoint.includes('/workflows/candidate.yml/runs')) body = { workflow_runs: [workflowRun(202)] };
  else if (endpoint.includes('/check-runs')) body = { check_runs: [{ id: 303, name: 'CodeQL', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 404 } }] };
  else if (endpoint.includes('/actions/runs/202/artifacts')) body = { artifacts: [] };
  else if (endpoint.endsWith('/actions/runs/202')) body = workflowRun(202);
  else throw new Error('Unexpected GitHub read: ' + endpoint);
  // Real \`gh api --paginate --slurp\` wraps each page in an array; this fixture
  // only ever produces one page, so slurping it is just wrapping it once.
  return reply(JSON.stringify(args.includes('--slurp') ? [body] : body), options);
};
syncBuiltinESMExports();
globalThis.fetch = async (input) => {
  const url = String(input);
  record('fetch', [url]);
  if (!url.startsWith('https://registry.npmjs.org/')) throw new Error('Network denied: ' + url);
  return new Response(JSON.stringify({ versions: ${publishedTarget ? "{ '0.4.0-alpha.4': {} }" : '{}'}, 'dist-tags': ${JSON.stringify(channels)} }), { status: 200 });
};
`);
    let output = '';
    let status = 0;
    try {
      output = execFileSync(process.execPath, ['--import', pathToFileURL(preload).href, script, ...args], {
        cwd: root, encoding: 'utf8', timeout: 15000, stdio: 'pipe',
        env: { ...process.env, GITHUB_REPOSITORY: 'example/urlcode', NODE_OPTIONS: '' },
      });
    } catch (error) {
      const failure = error as { status: number | null; stdout?: string; stderr?: string };
      status = failure.status ?? -1;
      output = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }
    const calls = (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
    return { status, output, calls, rootManifest: await readFile(join(root, 'package.json'), 'utf8') };
  } finally { await rm(root, { recursive: true, force: true }); }
}
function mutations(calls: Call[]): Call[] {
  return calls.filter(call => call.program === 'gh' && (call.args.includes('--method') || call.args.includes('-X') || ['workflow', 'release'].includes(call.args[0] ?? '') || (call.args[0] === 'run' && call.args[1] === 'rerun')));
}

test('coordinator dry-run only reads release state and does not dispatch, tag or publish', async () => {
  const result = await scenario([]);
  assert.equal(result.status, 0, result.output);
  assert.equal(result.output.split('\n').filter(line => line.includes('"phase":"package"')).length, 1);
  assert.deepEqual(mutations(result.calls), []);
  assert(result.calls.every(call => call.program === 'fetch' || call.program === 'git'));
  assert.equal(JSON.parse(result.rootManifest).version, '0.4.0-alpha.4');
});

test('coordinator rejects a retired extension npm scope before inspecting state', async () => {
  const result = await scenario(['--package', 'auth']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Only core is released through the npm coordinator/);
  assert.deepEqual(result.calls, []);
});

test('coordinator rejects unknown flags before inspecting or mutating external state', async () => {
  const result = await scenario(['--exectue']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Unknown release option/);
  assert.deepEqual(result.calls, []);
});

test('successful gate runs with missing candidate bytes stop before any tag mutation', async () => {
  const result = await scenario(['--execute', '--skip-template']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /candidate artifacts are missing or expired/i);
  assert(result.calls.some(call => call.program === 'gh' && call.args.some(arg => arg.includes('/actions/runs/202/artifacts'))), 'Candidate retention must be inspected');
  assert.deepEqual(mutations(result.calls), [], 'Never create a release tag based only on a successful candidate run');
});


test('coordinated preparation rejects an already published target before opening a release PR', async () => {
  const result = await scenario(['--version', '0.4.0-alpha.4', '--execute'], true);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /already published; select a new coordinated version/);
  assert.deepEqual(mutations(result.calls), []);
  assert(!result.calls.some(call => call.args[0] === 'clone' || call.args[1] === 'create'));
});


test('stable preparation checks latest channel regression before creating a release PR', async () => {
  const result = await scenario(['--version', '0.4.1', '--execute'], false, { latest: '0.5.0', alpha: '0.4.0-alpha.3' });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Refusing channel regression: 0.5.0 -> 0.4.1/);
  assert.deepEqual(mutations(result.calls), []);
  assert(!result.calls.some(call => call.args[0] === 'clone'));
});
