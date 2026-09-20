import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initProject, addRedirect } from '../src/authoring.ts';
import { loadDocument } from '../src/config.ts';
import { runProjectTests } from '../src/project-tests.ts';
import { project,redirect } from './helpers.ts';
import { renderAgentsGuide, renderMcpConfig, skillPath } from '../src/agents-guide.ts';
const cli = fileURLToPath(new URL('../src/cli.ts',import.meta.url));
test('the unified starter initializes and passes real HTTP assertions', async t => {
  const root = await project(t,{});
  {
    const target = join(root,'app');
    await initProject(target);
    assert.equal((await runProjectTests(target)).failed,0);
    await assert.rejects(initProject(target),{ code:'EEXIST' });
    assert.ok((await readFile(join(target,'.gitignore'),'utf8')).includes('.env.*'));
    // The CI template is a dotfile directory: init must copy it as-is.
    assert.ok((await readFile(join(target,'.github','workflows','urlcode.yml'),'utf8')).includes('jimhoyd-com/urlcode/action@'));
    // The generated AGENTS.md names the exact checks and the starter's real route count.
    const routes = Object.keys((await loadDocument(target)).routes).length;
    const guide = await readFile(join(target,'AGENTS.md'),'utf8');
    for (const command of ['urlcode validate --local','urlcode test',`urlcode audit --expect-routes ${routes}`,'urlcode capabilities','urlcode recipes list']) assert.ok(guide.includes(command),`AGENTS.md lacks ${command}`);
    assert.ok(guide.includes(skillPath),'AGENTS.md does not point at the packaged skill');
    assert.ok(guide.split('\n').length <= 80,'AGENTS.md must stay under 80 lines');
    for (const tool of ['get_context','get_capability','get_schema','search_recipes','explain','get_manifest','--allow-authoring']) assert.ok(guide.includes(tool),`AGENTS.md lacks ${tool}`);
    // .mcp.json registers the read-only server for the project directory itself.
    const mcp = JSON.parse(await readFile(join(target,'.mcp.json'),'utf8')) as { mcpServers: Record<string,{ command: string; args: string[] }> };
    assert.deepEqual(mcp,{ mcpServers:{ urlcode:{ command:'urlcode',args:['mcp','--project','.'] } } });
  }
});
test('the committed starter .mcp.json equals what init generates', async () => {
  const starter = fileURLToPath(new URL('../starters/default',import.meta.url));
  assert.equal(await readFile(join(starter,'.mcp.json'),'utf8'),renderMcpConfig('.'),'starters/default/.mcp.json is stale; regenerate it with renderMcpConfig and commit');
  assert.ok(!renderMcpConfig('app').includes('--allow-authoring'));
  for (const bad of ['','/abs','../up','a/../b']) assert.throws(() => renderMcpConfig(bad),bad);
});
test('the committed starter AGENTS.md equals what init generates from this runtime', async () => {
  // init copies the starter verbatim except for this file, which it generates
  // from the capability catalog; a clone of the starter must carry the same text.
  const starter = fileURLToPath(new URL('../starters/default',import.meta.url));
  const routes = Object.keys((await loadDocument(starter)).routes).length;
  assert.equal(await readFile(join(starter,'AGENTS.md'),'utf8'),renderAgentsGuide({ routes }),
    'starters/default/AGENTS.md is stale; regenerate it with renderAgentsGuide and commit');
  const guide = renderAgentsGuide({ routes });
  // Only capabilities this version implements natively may be named.
  for (const name of ['redirect','respond','page','static','download','function','proxy','conditional']) assert.ok(guide.includes(`\`${name}\``));
  assert.ok(guide.includes('## Feedback'));
  assert.ok(guide.includes("user's explicit approval"));
  assert.ok(guide.split('\n').length <= 80, 'generated project guidance must remain concise');
  assert.throws(() => renderAgentsGuide({ routes:-1 }));
});
test('authoring validates destination, rejects collisions and preserves original on failure', async t => {
  const root = await project(t,{ '/go':redirect() });
  const original = await readFile(join(root,'urlcode.yaml'),'utf8');
  await assert.rejects(addRedirect(root,'javascript:alert(1)','bad'));
  assert.equal(await readFile(join(root,'urlcode.yaml'),'utf8'),original);
  await assert.rejects(addRedirect(root,'https://example.org','go'));
  assert.equal(await addRedirect(root,'https://example.org','new'),'/new');
  assert.equal((await loadDocument(root)).routes['/new']?.redirect?.url,'https://example.org');
});
test('init --template page writes the smallest project, which validates locally and passes its tests', async t => {
  const root = await project(t,{});
  const target = join(root,'site');
  const init = spawnSync(process.execPath,[cli,'init',target,'--template','page'],{ encoding:'utf8',timeout:20000 });
  assert.equal(init.status,0,init.stderr);
  assert.deepEqual((await readdir(target)).sort(),['README.md','public','tests','urlcode.yaml']);
  for (const args of [['validate','--local'],['test']]) {
    const result = spawnSync(process.execPath,[cli,...args,'--project',target],{ encoding:'utf8',timeout:20000 });
    assert.equal(result.status,0,result.stdout+result.stderr);
  }
  for (const args of [['init',join(root,'x'),'--template','other'],['init',join(root,'y'),'--template','page','--with','ui'],['validate','--template','page']]) {
    assert.equal(spawnSync(process.execPath,[cli,...args],{ encoding:'utf8',timeout:20000 }).status,1,args.join(' '));
  }
});
test('CLI errors use nonzero status and do not echo secret arguments', async t => {
  const root = await project(t,{});
  for (const args of [['init','unused','--template','dynamic'],['unknown'],['serve','--port','invalid'],['add','javascript:SECRET','--project',root]]) {
    const result = spawnSync(process.execPath,[cli,...args],{ encoding:'utf8',timeout:10000 });
    assert.equal(result.status,1); assert.ok(!result.stderr.includes('SECRET'));
  }
});
test('authoring does not read credentials or execute functions in an untrusted project', async t => {
  const root = await project(t,{'/f':{function:{source:'f.mjs'},secrets:{KEY:{secret:'missing'}}}},{'f.mjs':'while(true) {} export default () => new Response("no")','.env.local':'invalid dotenv'});
  assert.equal(await addRedirect(root,'https://example.com','new'),'/new');
});
test('audit CLI fails count mismatch and does not print redirect destinations',async t=>{
  const root=await project(t,{'/go':redirect('https://example.com/SECRET')});
  for(const [count,code] of [['1',0],['2',1]] as const) {
    const result=spawnSync(process.execPath,[cli,'audit','--project',root,'--expect-routes',count],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,code);assert.ok(!result.stdout.includes('SECRET'));
    const report: unknown=JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
    assert.ok(typeof report==='object' && report!==null && 'ready' in report);assert.equal(report.ready,code===0);
  }
});

test('serve names the port and a next step when the port is taken, as one JSON error event', async t => {
  const root = await project(t,{ '/go':redirect() });
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const { port } = blocker.address() as AddressInfo;
  for (const command of ['serve','dev']) {
    const result = await new Promise<{ status:number|null; stderr:string }>(resolve => {
      const child = spawn(process.execPath,[cli,command,'--project',root,'--host','127.0.0.1','--port',String(port)],{ timeout:20000 });
      let stderr = ''; child.stderr.on('data',chunk => { stderr += chunk; });
      child.on('close',status => resolve({ status,stderr }));
    });
    assert.notEqual(result.status,0,command);
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length,1,`${command} must print one line: ${result.stderr}`);
    const event = JSON.parse(lines[0]!);
    assert.equal(event.event,'error');
    assert.ok(event.message.includes(String(port)),event.message);
    assert.ok(event.message.includes('127.0.0.1'),event.message);
    assert.ok(event.message.includes('--port'),event.message);
  }
});

test('serve exposes deployment capacity controls and rejects invalid values', async t => {
  const root = await project(t,{ '/go':redirect() });
  const run = (...args: string[]) => spawnSync(process.execPath,[cli,...args],{ encoding:'utf8',timeout:20000 });
  for (const args of [['--workers','0'],['--workers','abc'],['--function-timeout-ms','5'],['--max-in-flight','0'],
    ['--max-in-flight-health','99999'],['--max-body-bytes','0'],['--request-log','verbose']]) {
    const result = run('serve','--project',root,'--port','0',...args);
    assert.equal(result.status,1,`expected ${args.join(' ')} to be rejected`);
    assert.equal(JSON.parse(result.stderr).event,'error');
    assert.ok(!result.stdout.includes('listening'));
  }
  // Accepted values reach the runtime rather than being silently ignored.
  const started = run('validate','--project',root);
  assert.equal(started.status,0);
  assert.ok(run('--help').stdout.includes('--max-in-flight-health'));
});

test('doctor reports the node runtime facts', async () => {
  const report: unknown = JSON.parse(spawnSync(process.execPath,[cli,'doctor'],{ encoding:'utf8',timeout:10000 }).stdout);
  assert.ok(typeof report==='object' && report!==null && 'node' in report && 'platform' in report);
  assert.equal(typeof report.node,'string');
});

test('urlcode test is quiet by default and logs every request only with --verbose', async t => {
  const root = await project(t,{});
  const target = join(root,'app');
  await initProject(target);
  const run = (...args: string[]) => spawnSync(process.execPath,[cli,'test','--project',target,...args],{ encoding:'utf8',timeout:20000 });
  const quiet = run(), loud = run('--verbose');
  assert.equal(quiet.status,0);
  assert.ok(!quiet.stdout.includes('"event":"test"'));
  assert.equal((JSON.parse(quiet.stdout.trim().split('\n').pop() ?? '') as { failed:number }).failed,0);
  assert.ok(loud.stdout.includes('"event":"test"'));
});

test('urlcode test still runs where no temporary data directory can be created',async t => {
  const root = await project(t,{});
  const target = join(root,'app');
  await initProject(target);
  const run = spawnSync(process.execPath,[cli,'test','--project',target],{ encoding:'utf8',timeout:20000,env:{ ...process.env,TMPDIR:join(root,'missing','tmp') } });
  assert.equal(run.status,0);
  assert.equal((JSON.parse(run.stdout.trim().split('\n').pop() ?? '') as { failed:number }).failed,0);
});
