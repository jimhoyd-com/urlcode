import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stringify,parse} from 'yaml';
import {loadDocument} from '../packages/core/src/config.ts';
import {compileRoutes} from '../packages/core/src/router.ts';
import {redirectStarter,buildTaskContext,renderTaskContext,redirectShapes,contextTasks,estimateTokens} from '../packages/core/src/context.ts';
import {serveMcp} from '../packages/core/src/mcp.ts';
import {Readable,Writable} from 'node:stream';
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));

// #383: `--task redirects` must never drift from what the runtime actually accepts — every `yaml`
// shape marked supported has to compile for real, against the schema and the router's redirect assertions.
test('every supported redirect shape actually compiles',async()=>{
 for(const shape of redirectShapes.filter(s=>s.support==='supported')) {
  const root=await mkdtemp(join(tmpdir(),'urlcode-redirect-shape-'));
  const document={version:'1',routes:{'/placeholder-ok':{redirect:{url:'https://example.com/placeholder'}}},...(shape.yaml as {routes?:unknown;site?:unknown})};
  await writeFile(join(root,'urlcode.yaml'),stringify(document));
  if((document as {site?:{notFound?:string}}).site?.notFound) await writeFile(join(root,(document as {site:{notFound:string}}).site.notFound),'<h1>missing</h1>');
  const loaded=await loadDocument(root);
  await assert.doesNotReject(compileRoutes(loaded,{}),shape.need);
 }
});
test('the redirect starter compiles as one project and carries a PORT-aware start script',async()=>{
 const starter=redirectStarter();
 const root=await mkdtemp(join(tmpdir(),'urlcode-redirect-starter-'));
 await writeFile(join(root,starter.file),starter.yaml);
 for(const [name,body] of Object.entries(starter.companions))await writeFile(join(root,name),body);
 const loaded=await loadDocument(root);
 await assert.doesNotReject(compileRoutes(loaded,{}));
 assert.match(starter.packageScripts.start!,/urlcode serve .*\$\{PORT:-3000\}/);
 assert.ok(starter.yaml.includes('/legacy/**')&&starter.yaml.includes('/profiles/{id}'),'starter carries the wildcard and relative shapes');
 assert.ok(!starter.yaml.includes('//evil'),'starter must not contain a gap shape');
});
test('every gap shape fails validation the way the note claims',async()=>{
 const cases:Record<string,unknown>={
  'host or scheme chosen from the request':{routes:{'/a':{redirect:{url:'//evil.example/x'}}}},
 };
 for(const [need,routes] of Object.entries(cases)) {
  const shape=redirectShapes.find(s=>s.need===need);assert.ok(shape,need);assert.equal(shape.support,'gap');
  const root=await mkdtemp(join(tmpdir(),'urlcode-redirect-gap-'));
  await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',...(routes as object)}));
  const loaded=await loadDocument(root);
  await assert.rejects(compileRoutes(loaded,{}));
 }
});
test('buildTaskContext rejects an unknown task and accepts every declared one',async()=>{
 await assert.rejects(buildTaskContext('.','wildcards'),/Unknown context task/);
 for(const task of contextTasks)await assert.doesNotReject(buildTaskContext('.',task));
});
test('buildTaskContext reports this project\'s own redirects and stays well under the whole-project context',async()=>{
 const root=await mkdtemp(join(tmpdir(),'urlcode-redirect-project-'));
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',site:{notFound:'404.html'},routes:{
  '/old':{redirect:{url:'https://example.com/new',status:301}},
  '/users/{id}':{parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}],redirect:{url:'https://example.com/profiles/{id}',status:308}},
 }}));
 await writeFile(join(root,'404.html'),'<h1>missing</h1>');
 const context=await buildTaskContext(root,'redirects',{projectFlag:'.'});
 assert.equal(context.task,'redirects');assert.equal(context.schema,'1');assert.match(context.urlcode,/^\d+\.\d+\.\d+/);
 assert.equal(context.project?.routes,3);
 assert.deepEqual(context.project?.redirects,[
  {path:'/old',status:301,url:'https://example.com/new'},
  {path:'/users/{id}',status:308,url:'https://example.com/profiles/{id}'},
 ]);
 assert.deepEqual(context.project?.site,['notFound']);
 assert.equal(context.commands?.audit,'urlcode audit --project . --expect-routes 3');
 assert.ok(context.shapes && context.shapes.length>=redirectShapes.length);
 assert.ok(context.shapes!.some(s=>s.support==='gap'));
 const text=renderTaskContext(context);
 assert.ok(estimateTokens(text)<1800,`redirect task context should stay bounded: ${estimateTokens(text)}`);
});
test('a directory without urlcode.yaml still returns the fixed guidance',async()=>{
 const root=await mkdtemp(join(tmpdir(),'urlcode-redirect-empty-'));
 const context=await buildTaskContext(root,'redirects');
 assert.equal(context.project,undefined);assert.ok(context.shapes?.length);
});
test('a budget drops sections in the same fixed-order style as buildContext',async()=>{
 const root=await mkdtemp(join(tmpdir(),'urlcode-redirect-budget-'));
 await writeFile(join(root,'urlcode.yaml'),stringify({version:'1',routes:{'/old':{redirect:{url:'https://example.com/new'}}}}));
 const full=await buildTaskContext(root,'redirects');assert.equal(full.omitted,undefined);
 const tight=await buildTaskContext(root,'redirects',{budget:50});
 assert.ok(estimateTokens(renderTaskContext(tight))<=50);
 assert.deepEqual(tight.omitted,['project','commands','starter','notes','shapes']);
 await assert.rejects(buildTaskContext(root,'redirects',{budget:0}));
});
test('MCP get_context accepts task alongside the existing target/budget shape',async()=>{
 let text='';const output=new Writable({write(chunk,_e,callback){text+=String(chunk);callback();}});
 const starter=fileURLToPath(new URL('../starters/default/',import.meta.url));
 const messages=[
  {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},
  {jsonrpc:'2.0',method:'notifications/initialized'},
  {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_context',arguments:{task:'redirects'}}},
 ];
 await serveMcp({project:starter,input:Readable.from([messages.map(v=>JSON.stringify(v)+'\n').join('')]),output});
 const replies=text.trim().split('\n').map(line=>JSON.parse(line) as {result:{content:{text:string}[]}});
 const body=JSON.parse(replies[1]!.result.content[0]!.text) as {task:string};
 assert.equal(body.task,'redirects');
});
test('the CLI --task redirects flag renders YAML, refuses --target and reports tighter tokens than the whole-project context',()=>{
 const run=(...args:string[])=>spawnSync(process.execPath,[cli,'context','--project','recipes/redirect',...args],{encoding:'utf8',timeout:20000,cwd:fileURLToPath(new URL('..',import.meta.url))});
 const task=run('--task','redirects','--stats');assert.equal(task.status,0,task.stderr);
 const parsed=parse(task.stdout) as {task:string;project:{routes:number}};
 assert.equal(parsed.task,'redirects');assert.equal(parsed.project.routes,2);
 const taskStats=JSON.parse(task.stderr) as {contextTokens:number};
 const whole=run('--stats');assert.equal(whole.status,0,whole.stderr);
 const wholeStats=JSON.parse(whole.stderr) as {contextTokens:number};
 assert.ok(taskStats.contextTokens<wholeStats.contextTokens+1200,`task ${taskStats.contextTokens} whole ${wholeStats.contextTokens}`);
 assert.equal(run('--task','redirects','--target','cloudflare').status,1);
 assert.equal(run('--task','made-up').status,1);
});
