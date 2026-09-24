import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { project } from './helpers.ts';
const repo = fileURLToPath(new URL('..',import.meta.url));
// Anything from a third party is pinned to a full commit; `./action` is this repository.
const pinned = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function uses(document: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (isRecord(node)) { if (typeof node.uses === 'string') found.push(node.uses); Object.values(node).forEach(walk); }
  };
  walk(document); return found;
}
test('the project action is a composite action with the documented inputs and pinned dependencies', async () => {
  const action: unknown = parse(await readFile(join(repo,'action','action.yml'),'utf8'));
  assert.ok(isRecord(action) && isRecord(action.inputs) && isRecord(action.runs) && isRecord(action.outputs));
  assert.equal(typeof action.name,'string'); assert.equal(typeof action.description,'string');
  assert.equal(action.runs.using,'composite');
  assert.deepEqual(Object.keys(action.inputs),['site','host-file','node-version','expect-routes','allow-empty-project','compliance','compliance-rules','compliance-warn','origin','route-diff']);
  for (const [name,input] of Object.entries(action.inputs)) assert.ok(isRecord(input) && typeof input.description === 'string' && 'default' in input, `input ${name}`);
  assert.equal(isRecord(action.inputs.site) && action.inputs.site.default,'.');
  assert.equal(isRecord(action.inputs['host-file']) && action.inputs['host-file'].default,'');
  assert.equal(isRecord(action.inputs['node-version']) && action.inputs['node-version'].default,'26');
  assert.equal(isRecord(action.inputs.compliance) && action.inputs.compliance.default,'baseline');
  assert.equal(isRecord(action.inputs['route-diff']) && action.inputs['route-diff'].default,'true');
  const steps = action.runs.steps;
  assert.ok(Array.isArray(steps) && steps.length >= 6);
  for (const step of steps) assert.ok(isRecord(step) && (typeof step.uses === 'string' || step.shell === 'bash'),'every run step declares bash');
  const used = uses(action);
  assert.ok(used.length >= 1); for (const ref of used) assert.match(ref,pinned);
  const runs = steps.map(step => isRecord(step) && typeof step.run === 'string' ? step.run : '').join('\n');
  for (const command of ['npm ci --ignore-scripts','urlcode extensions list --strict','urlcode artifacts list --strict','urlcode validate','urlcode test','audit --project app','--compare','--format markdown','comment.mjs']) assert.ok(runs.includes(command),command);
  assert.ok(!/secrets\./.test(await readFile(join(repo,'action','action.yml'),'utf8')),'the action uses only github.token');
});
test('the starter workflow and the repository workflows pin third-party actions by commit', async () => {
  const starter: unknown = parse(await readFile(join(repo,'starters','default','.github','workflows','urlcode.yml'),'utf8'));
  const refs = uses(starter);
  assert.ok(refs.some(ref => ref.startsWith('jimhoyd-com/urlcode/action@')));
  for (const ref of refs.filter(ref => !ref.startsWith('jimhoyd-com/urlcode/action@'))) assert.match(ref,pinned);
  assert.ok(isRecord(starter) && isRecord(starter.permissions) && starter.permissions['pull-requests'] === 'write');
  const workflows = (await readdir(join(repo,'.github','workflows'))).filter(name => /\.ya?ml$/.test(name));
  const workflowRefs = (await Promise.all(workflows.map(async name => uses(parse(await readFile(join(repo,'.github','workflows',name),'utf8')))))).flat();
  assert.ok(workflowRefs.includes('./action'),'CI exercises the in-repository action');
  for (const ref of workflowRefs.filter(ref => !ref.startsWith('./'))) assert.match(ref,pinned);
});
test('the comment script creates, then updates, one comment keyed by project and skips without permission', async t => {
  const root = await project(t,{});
  const diff = join(root,'diff.md'); await writeFile(diff,'### Added routes (1)\n\n| Route |\n|---|\n| `/new` |\n');
  const calls: { method: string; url: string; body: string }[] = [];
  let existing = false;
  let status = 200;
  const server = http.createServer((req,res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      calls.push({ method:req.method ?? '', url:req.url ?? '', body });
      if (status !== 200) { res.writeHead(status); res.end('{}'); return; }
      if (req.method === 'GET') { res.end(JSON.stringify(existing ? [{ id:1, body:'unrelated' },{ id:7, body:'<!-- urlcode-route-diff project="site" -->\nold' }] : [{ id:1, body:'unrelated' }])); return; }
      res.end(JSON.stringify({ id:7, html_url:'https://example.test/comment/7' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address === 'object');
  // The fake API lives in this process, so the script must run asynchronously.
  const run = (env: Record<string, string>) => promisify(execFile)(process.execPath,[join(repo,'action','comment.mjs')],{ encoding:'utf8', timeout:20000, env:{ ...process.env, ...env } });
  const env = { GITHUB_TOKEN:'token', GITHUB_REPOSITORY:'acme/site', GITHUB_API_URL:`http://127.0.0.1:${address.port}`, DIFF_FILE:diff, PROJECT:'site', PR_NUMBER:'12', HEAD_SHA:'abcdef0123456789' };
  let result = await run(env);
  assert.deepEqual(calls.map(c => [c.method,c.url]),[['GET','/repos/acme/site/issues/12/comments?per_page=100&page=1'],['POST','/repos/acme/site/issues/12/comments']]);
  const posted: unknown = JSON.parse(calls[1]?.body ?? '');
  assert.ok(isRecord(posted) && typeof posted.body === 'string');
  assert.ok(posted.body.startsWith('<!-- urlcode-route-diff project="site" -->\n## URLCode route changes'));
  assert.ok(posted.body.includes('`abcdef0`') && posted.body.includes('| `/new` |'));
  assert.ok(result.stdout.includes('created'));
  existing = true; calls.length = 0; result = await run(env);
  assert.deepEqual(calls.map(c => [c.method,c.url]),[['GET','/repos/acme/site/issues/12/comments?per_page=100&page=1'],['PATCH','/repos/acme/site/issues/comments/7']]);
  assert.ok(result.stdout.includes('updated'));
  status = 403; calls.length = 0; result = await run(env);
  assert.ok(result.stdout.includes('::notice::') && result.stdout.includes('403'));
  // Not a pull request: nothing is called.
  const skipped = await run({ ...env, PR_NUMBER:'' });
  assert.ok(skipped.stdout.includes('not a pull request'));
});
