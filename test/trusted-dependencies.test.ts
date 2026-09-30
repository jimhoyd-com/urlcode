import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile, mkdir, symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {project, approveBindings} from './helpers.ts';
import {inspectProject, reviewProject} from '../packages/core/src/tooling.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';

test('trusted static, reexport, literal dynamic, JSON and cyclic helpers enter review without execution',async t=>{
  const root=await project(t,{'/':{function:{source:'f.mjs'},env:{TOKEN:{env:'TOKEN'}}}},{
    'f.mjs':"export {default} from './helper.mjs'; throw new Error('never execute during review');",
    'helper.mjs':"import './f.mjs'; import data from './data.json' with {type:'json'}; export default ()=>import('./lazy.mjs');",
    'lazy.mjs':'export default 1;', 'data.json':'{"n":1}'
  });
  const before=await reviewProject(root),permissions=await approveBindings(root);
  assert.equal(before.trustedDependencies.complete,true);
  assert.deepEqual(before.trustedDependencies.files.map(file=>file.path),['data.json','f.mjs','helper.mjs','lazy.mjs']);
  await writeFile(join(root,'helper.mjs'),'export default ()=>new Response("changed");');
  assert.notEqual((await inspectProject(root)).projectSha256,before.projectSha256);
  await assert.rejects(createRuntime(root,{permissions,environment:{TOKEN:'synthetic'}}),/denied|revision/i);
});

test('site package metadata and lock bytes invalidate review; report never exposes resolved credentials',async t=>{
  const site=await project(t,{},{});
  const root=join(site,'app');await mkdir(root);
  await writeFile(join(root,'urlcode.yaml'),'version: "1"\nroutes:\n  /:\n    function:\n      source: f.mjs\n    env:\n      TOKEN:\n        env: TOKEN\n');
  await writeFile(join(root,'f.mjs'),"import 'some-lib/subpath'; export default ()=>new Response('ok');");
  await writeFile(join(site,'package.json'),'{"type":"module"}');
  const lock={packages:{'node_modules/some-lib':{version:'1.0.0',integrity:'sha512-YWJj',resolved:'https://user:secret@example.test/private'}}};
  await writeFile(join(site,'package-lock.json'),JSON.stringify(lock));
  const before=await reviewProject(root);
  assert.deepEqual(before.trustedDependencies.packages,['some-lib']);
  assert.deepEqual(before.trustedDependencies.packageDeclarations,[{name:'some-lib',lockfile:'../package-lock.json',version:'1.0.0',integrity:'sha512-YWJj'}]);
  assert.ok(!JSON.stringify(before.trustedDependencies).includes('secret'));
  await writeFile(join(site,'package.json'),'{"type":"commonjs"}');
  const changed=await inspectProject(root);assert.notEqual(changed.projectSha256,before.projectSha256);
  await mkdir(join(site,'node_modules/some-lib'),{recursive:true});
  await writeFile(join(site,'node_modules/some-lib/index.mjs'),'export default "modified installed bytes";');
  assert.equal((await inspectProject(root)).projectSha256,changed.projectSha256,'lock metadata does not attest node_modules edits');
  const permissions=await approveBindings(root);
  lock.packages['node_modules/some-lib'].integrity='sha512-ZGVm';
  await writeFile(join(site,'package-lock.json'),JSON.stringify(lock));
  assert.notEqual((await inspectProject(root)).projectSha256,changed.projectSha256);
  await assert.rejects(createRuntime(root,{permissions,environment:{TOKEN:'synthetic'}}),/denied|revision/i);
});

test('opaque code stays permitted and review reports its limits without executing or following escapes',async t=>{
  const root=await project(t,{'/':{function:{source:'f.mjs'}}},{
    'f.mjs':"import './link.mjs'; import './missing.mjs'; import '../outside.mjs'; import './node_modules/example/index.mjs'; const x='foo'; import(x); const require=createRequire(import.meta.url); require(x); export default ()=>null;",
    'target.mjs':'throw new Error("never run")'
  });
  await symlink(join(root,'target.mjs'),join(root,'link.mjs'));
  const {trustedDependencies:inventory}=await reviewProject(root);
  assert.equal(inventory.complete,false);
  for(const reason of ['symlink','unresolved','outside-project-or-url-import','dynamic-import','commonjs-or-created-loader','package-path-not-inventoried'])assert.ok(inventory.opaque.some(edge=>edge.reason===reason),reason);
  assert.deepEqual(inventory.files.map(file=>file.path),['f.mjs']);
});

test('oversize helper is explicit and does not impose a trusted execution allowlist',async t=>{
  const root=await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':"import './large.mjs'; export default ()=>null;",'large.mjs':' '.repeat(2*1024*1024+1)});
  const {trustedDependencies:inventory}=await inspectProject(root);
  assert.equal(inventory.complete,false);assert.ok(inventory.opaque.some(edge=>edge.reason==='byte-limit'));
});

test('TypeScript dependencies are inspected with Node stripping and no compiler execution',async t=>{
  const root=await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':"import {n} from './helper.ts'; export default ()=>n;",'helper.ts':'export const n:number=1;'});
  assert.deepEqual((await inspectProject(root)).trustedDependencies.files.map(file=>file.path),['f.mjs','helper.ts']);
});


test('nested package scope changes invalidate the pin',async t=>{
  const root=await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':"import './lib/helper.js'; export default ()=>null;",'lib/helper.js':'export const n=1;','lib/package.json':'{"type":"module"}'});
  const before=await inspectProject(root);
  assert.ok(before.trustedDependencies.files.some(file=>file.path==='lib/package.json'));
  await writeFile(join(root,'lib/package.json'),'{"type":"commonjs"}');
  assert.notEqual((await inspectProject(root)).projectSha256,before.projectSha256);
});

test('large graphs and package lists have bounded inventory and explicit truncation',async t=>{
  const files:Record<string,string>={};
  files['f.mjs']=Array.from({length:270},(_,i)=>`import './h${i}.mjs'; import 'package-${i}';`).join('\n')+'\nexport default ()=>null;';
  for(let i=0;i<270;i++)files[`h${i}.mjs`]='export default 1;';
  const root=await project(t,{'/':{function:{source:'f.mjs'}}},files);
  const {trustedDependencies:inventory}=await inspectProject(root);
  assert.equal(inventory.complete,false);assert.ok(inventory.files.length<=256);assert.ok(inventory.packages.length<=256);assert.ok(inventory.opaque.length<=256);
  assert.ok(inventory.opaque.some(edge=>edge.reason==='file-count-limit'));
});
