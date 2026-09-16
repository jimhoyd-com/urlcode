import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initProject, addRedirect } from '../src/authoring.js';
import { loadDocument } from '../src/config.js';
import { runProjectTests } from '../src/project-tests.js';
import { project,redirect } from './helpers.js';
const cli = fileURLToPath(new URL('../src/cli.js',import.meta.url));
test('both starters initialize independently and pass real HTTP assertions', async t => {
  const root = await project(t,{});
  for (const template of ['redirects','dynamic']) {
    const target = join(root,template);
    await initProject(target,template);
    assert.equal((await runProjectTests(target)).failed,0);
    await assert.rejects(initProject(target,template),{ code:'EEXIST' });
    assert.ok((await readFile(join(target,'.gitignore'),'utf8')).includes('.env.*'));
  }
});
test('authoring validates destination, rejects collisions and preserves original on failure', async t => {
  const root = await project(t,{ '/go':redirect() });
  const original = await readFile(join(root,'urlcode.yaml'),'utf8');
  await assert.rejects(addRedirect(root,'javascript:alert(1)','bad'));
  assert.equal(await readFile(join(root,'urlcode.yaml'),'utf8'),original);
  await assert.rejects(addRedirect(root,'https://example.org','go'));
  assert.equal(await addRedirect(root,'https://example.org','new'),'/new');
  assert.equal((await loadDocument(root)).routes['/new'].redirect.url,'https://example.org');
});
test('CLI errors use nonzero status and do not echo secret arguments', async t => {
  const root = await project(t,{});
  for (const args of [['unknown'],['serve','--port','invalid'],['add','javascript:SECRET','--project',root]]) {
    const result = spawnSync(process.execPath,[cli,...args],{ encoding:'utf8',timeout:10000 });
    assert.equal(result.status,1); assert.ok(!result.stderr.includes('SECRET'));
  }
});
test('authoring does not read credentials or execute functions in an untrusted project', async t => {
  const root = await project(t,{'/f':{function:{source:'f.mjs'},secrets:{KEY:{secret:'missing'}}}},{'f.mjs':'while(true) {} export default () => new Response("no")','.env.local':'invalid dotenv'});
  assert.equal(await addRedirect(root,'https://example.com','new'),'/new');
});
