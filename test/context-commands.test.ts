import test from 'node:test';import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable,Writable} from 'node:stream';
import {buildContext,buildTaskContext,shellWord} from '../packages/core/src/context.ts';
import {planFeature} from '../packages/core/src/feature-plan.ts';
import {serveMcp} from '../packages/core/src/mcp.ts';
import {byReplyId,spawnAsync} from './helpers.ts';

// #791: the operator's --origin reaches site expansion in context, task context and feature planning (CLI, SDK and MCP).
// #790: every emitted project argument is shell-quoted and names the project from the caller's working directory.
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
const origin='https://example.test';
const sitemapYaml='version: "1"\nsite: {sitemap: true}\nroutes:\n  /hello: {respond: {text: hello}}\n';
const helloYaml='version: "1"\nroutes:\n  /hello: {respond: {text: hello}}\n';
async function directory(t:TestContext):Promise<string> {const dir=await mkdtemp(join(tmpdir(),'urlcode-context-commands-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function projectAt(root:string,yaml:string):Promise<string> {await mkdir(root,{recursive:true});await writeFile(join(root,'urlcode.yaml'),yaml);return root;}
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}};
const ready={jsonrpc:'2.0',method:'notifications/initialized'};
interface Reply {result:{content:{text:string}[];isError?:boolean}}
async function mcp(options:{project:string;origin?:string;hostFile?:string},calls:{name:string;arguments:Record<string,unknown>}[]):Promise<Reply[]> {
 let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
 const messages=[initialize,ready,...calls.map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}))];
 await serveMcp({...options,input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output});
 return text.trim().split('\n').map(line=>JSON.parse(line) as Reply).sort(byReplyId).slice(1);
}
/** Runs an emitted `urlcode ...` command through a POSIX shell from `cwd`, with this checkout's CLI standing in for `urlcode`. */
function runEmitted(command:string,cwd:string) {
 assert.ok(command.startsWith('urlcode '),command);
 return spawnAsync('/bin/sh',['-c',`${shellWord(process.execPath)} --conditions=development ${shellWord(cli)} ${command.slice('urlcode '.length)}`],{cwd,encoding:'utf8'});
}

test('context, task context and feature planning compile a sitemap project with the supplied origin (#791)',async t=>{
 const root=await projectAt(join(await directory(t),'app'),sitemapYaml);
 const context=await buildContext(root,{origin});
 assert.equal(context.project.routes,2);
 assert.ok(context.routes!.some(route=>route.path==='/sitemap.xml'));
 assert.ok(context.commands!.validate!.endsWith(` --origin ${origin} --local-review`));
 assert.equal((await buildTaskContext(root,'redirects',{origin})).project?.routes,2);
 assert.equal((await planFeature(root,'redirect',{origin})).project?.routes,2);
 // No origin supplied: the prerequisite is named, not guessed.
 for(const attempt of [()=>buildContext(root),()=>buildTaskContext(root,'redirects'),()=>planFeature(root,'redirect')])await assert.rejects(attempt(),/--origin https:\/\/your\.host/);
});

test('the CLI context, context --task and plan-feature forward --origin (#791)',async t=>{
 const root=await projectAt(join(await directory(t),'app'),sitemapYaml);
 // Six independent CLI runs, started together.
 await Promise.all([['context','--json'],['context','--task','redirects','--json'],['plan-feature','redirect','--json']].map(async args=>{
  const [run,bare]=await Promise.all([spawnAsync(process.execPath,['--conditions=development',cli,...args,'--project',root,'--origin',origin],{encoding:'utf8'}),spawnAsync(process.execPath,['--conditions=development',cli,...args,'--project',root],{encoding:'utf8'})]);
  assert.equal(run.status,0,`${args.join(' ')}: ${run.stderr}`);
  assert.notEqual(bare.status,0,args.join(' '));assert.match(bare.stderr,/--origin/);
 }));
});

test('plan-feature plans before init: with no project it answers from the catalogs and says what it skipped (#1000)',async t=>{
 const dir=await directory(t),goal='room booking with one-hour slots, only members can book, owners can cancel';
 const plan=await planFeature(undefined,goal);
 assert.equal(plan.project,null);
 assert.ok(plan.applicable.recipes.some(recipe=>recipe.name==='store-booking'),JSON.stringify(plan.applicable.recipes));
 assert.deepEqual(plan.extensions.required.map(item=>[item.name,item.declared,item.artifact]),[['auth',false,'none'],['store',false,'none']]);
 assert.match(plan.withoutProject??'',/^No project yet: .*`urlcode init <directory> --with auth,store`/);
 // From a directory that is not a project, the CLI plans the same way; a --project that names nothing is still an error.
 await projectAt(join(dir,'site'),helloYaml);
 // The three CLI runs are independent: started together, checked in order.
 const [run,named,insideRun]=await Promise.all([spawnAsync(process.execPath,['--conditions=development',cli,'plan-feature',goal,'--json'],{cwd:dir,encoding:'utf8'}),
  spawnAsync(process.execPath,['--conditions=development',cli,'plan-feature',goal,'--project',join(dir,'missing'),'--json'],{cwd:dir,encoding:'utf8'}),
  spawnAsync(process.execPath,['--conditions=development',cli,'plan-feature','redirect','--json'],{cwd:join(dir,'site'),encoding:'utf8'})]);
 assert.equal(run.status,0,run.stderr);
 const printed=JSON.parse(run.stdout) as {project:unknown;withoutProject?:string};
 assert.equal(printed.project,null);assert.match(printed.withoutProject??'',/--with auth,store/);
 assert.notEqual(named.status,0);assert.match(named.stderr,/no-project/);
 // Inside a project nothing changes: the plan reads it.
 const inside=JSON.parse(insideRun.stdout) as {project:{routes:number};withoutProject?:string};
 assert.equal(inside.project.routes,1);assert.equal(inside.withoutProject,undefined);
});

test('MCP get_context and plan_feature compile with the server origin and name it when it is missing (#791)',async t=>{
 const root=await projectAt(join(await directory(t),'app'),sitemapYaml);
 const calls=[{name:'get_context',arguments:{}},{name:'get_context',arguments:{task:'redirects'}},{name:'plan_feature',arguments:{goal:'redirect'}}];
 const replies=await mcp({project:root,origin},calls);
 for(const reply of replies)assert.equal(reply.result.isError,undefined,reply.result.content[0]!.text);
 assert.equal((JSON.parse(replies[0]!.result.content[0]!.text) as {project:{routes:number}}).project.routes,2);
 assert.equal((JSON.parse(replies[2]!.result.content[0]!.text) as {project:{routes:number}}).project.routes,2);
 for(const reply of await mcp({project:root},calls)) {assert.equal(reply.result.isError,true);assert.match(reply.result.content[0]!.text,/--origin/);}
});

test('emitted commands quote a project path with spaces or an apostrophe and run as returned (#790)',{skip:process.platform==='win32'&&'POSIX shell execution'},async t=>{
 const site=await directory(t);
 for(const name of ['app with spaces',"o'brien app"]) {
  const root=await projectAt(join(site,name),helloYaml);
  const context=await buildContext(root),task=await buildTaskContext(root,'redirects');
  const quoted=shellWord(root);assert.notEqual(quoted,root);
  for(const command of [context.commands!.validate!,context.commands!.test!,context.commands!.audit!,context.commands!.routes!,task.commands!.validate!,task.commands!.audit!])assert.ok(command.includes(`--project ${quoted}`),command);
  // A projectFlag override is quoted the same way.
  const relative=await buildContext(root,{projectFlag:name});
  assert.equal(relative.commands!.validate,`urlcode validate --local --project ${shellWord(name)} --local-review`);
  // The three emitted commands are independent runs: started together, checked in order.
  const emitted=[context.commands!.validate!,task.commands!.validate!],[first,second,run]=await Promise.all([...emitted,relative.commands!.validate!].map(command=>runEmitted(command,site)));
  for(const [index,result] of [first!,second!].entries())assert.equal(result.status,0,`${emitted[index]}\n${result.stderr}`);
  assert.equal(run!.status,0,run!.stderr);
  assert.equal((await buildTaskContext(root,'redirects',{projectFlag:name})).commands!.validate,`urlcode validate --local --project ${shellWord(name)} --local-review`);
 }
});

test('MCP get_context started from the site root with --project app --host-file host.mjs returns commands that run from the site root (#790)',{skip:process.platform==='win32'&&'POSIX shell execution'},async t=>{
 const site=await directory(t),app=await projectAt(join(site,'app'),helloYaml),hostFile=join(site,'host.mjs');
 await writeFile(hostFile,'export default {};\n');
 const replies=await mcp({project:app,hostFile},[{name:'get_context',arguments:{}},{name:'get_context',arguments:{task:'redirects'}}]);
 for(const reply of replies) {
  assert.equal(reply.result.isError,undefined,reply.result.content[0]!.text);
  const {commands}=JSON.parse(reply.result.content[0]!.text) as {commands:Record<string,string>};
  assert.equal(commands.validate,`urlcode validate --local --project ${shellWord(resolve(app))} --host-file ${shellWord(hostFile)} --local-review`);
  // The client's working directory is the site root, where the host file lives beside app/.
  const run=await runEmitted(commands.validate!,site);assert.equal(run.status,0,`${commands.validate}\n${run.stderr}`);
 }
});
