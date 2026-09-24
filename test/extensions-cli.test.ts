import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExtensionRelease, runExtensionCommand } from '../packages/core/src/extensions-cli.ts';

const options = (project:string) => ({project});

test('noun-first extensions aliases list the project lock', async t => {
  const project=await mkdtemp(join(tmpdir(),'urlcode-extensions-cli-'));
  t.after(async()=>{await import('node:fs/promises').then(fs=>fs.rm(project,{recursive:true,force:true}));});
  const output:unknown[]=[];
  await writeFile(join(project,'urlcode.extension-bundles.lock.json'),JSON.stringify({format:1,bundles:[{name:'sample',version:'1.2.3',asset:'sample.tgz',sha256:'a'.repeat(64),entry:'node_modules/@jimhoyd/urlcode-sample/dist/index.js',catalog:{tag:'extension-bundles@v1.0.0',commit:'b'.repeat(40)},coreVersion:'1.0.0'}]}));
  output.length=0;
  await runExtensionCommand('extensions','list',[],options(project),value=>{output.push(value);return true;});
  assert.deepEqual(output,[{bundles:[{name:'sample',version:'1.2.3',release:'extension-bundles@v1.0.0',coreVersion:'1.0.0'}]}]);
});

test('core selects matching immutable extension and artifact catalogs unless an operator overrides them', async () => {
  const dependencies={runningCoreVersion:async()=> '1.2.3'};
  assert.deepEqual(await resolveExtensionRelease('bundles',undefined,dependencies),{release:'extension-bundles@v1.2.3'});
  assert.deepEqual(await resolveExtensionRelease('artifacts',undefined,dependencies),{release:'extensions@v1.2.3'});
  assert.deepEqual(await resolveExtensionRelease('bundles','extension-bundles@v0.9.0',dependencies),{release:'extension-bundles@v0.9.0'});
});

test('legacy extension-bundles list remains the static catalog alias', async () => {
  const output:unknown[]=[];
  await runExtensionCommand('extension-bundles','list',[],options('.'),value=>{output.push(value);return true;});
  assert.match(output[0] as string,/urlcode extension-bundles install/);
});
