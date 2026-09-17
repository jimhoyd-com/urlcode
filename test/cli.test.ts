import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initProject, addRedirect } from '../src/authoring.ts';
import { loadDocument } from '../src/config.ts';
import { runProjectTests } from '../src/project-tests.ts';
import { project,redirect } from './helpers.ts';
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
  }
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

test('doctor reports whether this Node build can run live links', async () => {
  const report: unknown = JSON.parse(spawnSync(process.execPath,[cli,'doctor'],{ encoding:'utf8',timeout:10000 }).stdout);
  assert.ok(typeof report==='object' && report!==null && 'liveLinks' in report && 'sqlite' in report);
  assert.equal(typeof report.liveLinks,'boolean');
  assert.equal(typeof report.sqlite,'string');
});
