import test from 'node:test';import assert from 'node:assert/strict';import {Readable,Writable} from 'node:stream';
import {cp,mkdtemp,rm,readFile,writeFile,symlink,lstat,mkdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {serveMcp} from '../packages/core/src/mcp.ts';import {confinedPath} from '../packages/core/src/mcp-authoring.ts';import {project,redirect} from './helpers.ts';
import {scaffoldProject} from '../packages/core/src/scaffold.ts';import {buildContext} from '../packages/core/src/context.ts';import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}};
const ready={jsonrpc:'2.0',method:'notifications/initialized'};
interface Reply { error?:{code:number;message:string};result:{tools:{name:string;annotations:{readOnlyHint:boolean}}[];content:{text:string}[];isError?:boolean} }
const authoringNames=['create_route','add_recipe','scaffold_feature','run_validate','run_test','run_audit','run_tests'];
async function session(root:string,messages:unknown[],allowAuthoring?:boolean) {
 let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
 await serveMcp({project:root,input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output,...(allowAuthoring?{allowAuthoring:true}:{})});
 return text.trim().split('\n').filter(Boolean).map(value=>JSON.parse(value) as Reply);
}
const calls=(list:{name:string;arguments?:unknown}[])=>list.map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}));
const payload=(reply:Reply)=>JSON.parse(reply.result.content[0]!.text) as Record<string,unknown>;
async function starter(t:{after(fn:()=>Promise<void>):void}):Promise<string> {
 const root=await mkdtemp(join(tmpdir(),'urlcode-authoring-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await cp(fileURLToPath(new URL('../starters/default/app/',import.meta.url)),root,{recursive:true});return root;
}

test('authoring tools are absent without the flag and cannot be enabled by arguments or environment',async t=>{
 const root=await project(t,{'/a':redirect()});
 process.env.URLCODE_ALLOW_AUTHORING='1';t.after(()=>{delete process.env.URLCODE_ALLOW_AUTHORING;});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'},...calls([{name:'create_route',arguments:{path:'/x',handler:'https://example.com/',allowAuthoring:true}},{name:'run_validate',arguments:{}}]).map((call,i)=>({...call,id:i+3}))]);
 const names=replies[1]!.result.tools.map(tool=>tool.name);
 assert.equal(names.length,35);for(const name of authoringNames)assert.equal(names.includes(name),false);
 assert.equal(replies[2]!.error!.code,-32602);assert.equal(replies[3]!.error!.code,-32602);
 assert.equal((await readFile(join(root,'urlcode.yaml'),'utf8')).includes('/x'),false);
});
test('the flag lists the authoring tools as non-read-only alongside the read tools',async t=>{
 const root=await project(t,{'/a':redirect()});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'}],true);
 const tools=replies[1]!.result.tools;assert.equal(tools.length,42);
 for(const name of authoringNames){const tool=tools.find(tool=>tool.name===name);assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,false);}
 assert.equal(tools.find(tool=>tool.name==='inspect')!.annotations.readOnlyHint,true);
});
test('runners that execute trusted project code are annotated destructive, open-world and non-idempotent (#590)',async t=>{
 const root=await project(t,{'/a':redirect()});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'}],true);
 const tools=replies[1]!.result.tools as unknown as {name:string;description:string;annotations:Record<string,boolean>}[];
 for(const name of ['run_validate','run_test','run_audit','run_tests']){
  const tool=tools.find(candidate=>candidate.name===name)!;
  assert.deepEqual(tool.annotations,{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true},name);
  assert.match(tool.description,/trusted function and middleware modules/,name);assert.match(tool.description,/not confinement/,name);
 }
 // The file-writing tools stay project-confined writes: not destructive, not open-world.
 for(const name of ['create_route','add_recipe','scaffold_feature'])
  assert.deepEqual(tools.find(candidate=>candidate.name===name)!.annotations,{readOnlyHint:false,destructiveHint:false,openWorldHint:false},name);
});
test('path confinement refuses absolute, parent, symlinked, dotenv, git and operator paths',async t=>{
 const root=await project(t,{'/a':redirect()},{'safe/keep.txt':'x','policy.json':'{}','host.mjs':'','links.sqlite':''});
 await symlink(tmpdir(),join(root,'escape'));await symlink('urlcode.yaml',join(root,'alias.yaml'));
 for(const path of ['/etc/passwd',join(root,'x.yaml'),'../outside.yaml','a/../../outside','escape/x.yaml','escape','alias.yaml','.env','.env.local','sub/.env.production','.git/config','.git','policy.json','operator-policy.json','compliance-rules.json','host.mjs','host-file.mjs','links.sqlite','links.sqlite-wal','store.db','urlcode.yaml.lock','node_modules/x','private.pem','C:\\x','a\\b',''])
  await assert.rejects(confinedPath(root,path),Error,path);
 assert.equal(await confinedPath(root,'safe/keep.txt'),join(root,'safe/keep.txt'));assert.equal(await confinedPath(root,'new/dir/file.yaml'),join(root,'new/dir/file.yaml'));
 const replies=await session(root,[initialize,ready,...calls([{name:'add_recipe',arguments:{name:'redirect',destination:'../outside'}},{name:'add_recipe',arguments:{name:'redirect',destination:'escape/recipe'}},{name:'add_recipe',arguments:{name:'redirect',destination:'.env.local'}},{name:'create_route',arguments:{path:'/x',handler:'https://example.com/',file:'../outside.yaml'}},{name:'create_route',arguments:{path:'/x',handler:'https://example.com/',file:'alias.yaml'}},{name:'create_route',arguments:{path:'/x',handler:'https://example.com/',file:'host.mjs'}}])],true);
 for(const reply of replies.slice(1))assert.equal(reply.result.isError,true);
 await assert.rejects(lstat(join(root,'recipe')),{code:'ENOENT'});await assert.rejects(lstat(join(tmpdir(),'recipe')),{code:'ENOENT'});
 assert.equal((await readFile(join(root,'urlcode.yaml'),'utf8')).includes('/x'),false);
});
test('create_route then run_validate on a copy of the default starter',async t=>{
 const root=await starter(t);
 const replies=await session(root,[initialize,ready,...calls([
  {name:'create_route',arguments:{path:'/docs',handler:'https://example.com/docs'}},
  {name:'create_route',arguments:{path:'/greet/{who}',handler:'functions/hello.mjs',middleware:['middleware/headers.mjs']}},
  {name:'create_route',arguments:{path:'/docs',handler:'https://example.com/again'}},
  {name:'create_route',arguments:{path:'/bad',handler:{redirect:{url:'not a url'}}}},
  {name:'scaffold_feature',arguments:{}},
  {name:'run_validate',arguments:{}},
])],true);
 const created=payload(replies[1]!);assert.equal(created.created,true);assert.equal(created.file,'urlcode.yaml');assert.equal((created.validation as {valid:boolean}).valid,true);
 const include=payload(replies[2]!);assert.equal(include.file,'urlcode.yaml');assert.deepEqual(include.missingSources,['middleware/headers.mjs','functions/hello.mjs']);
 assert.deepEqual((include.route as {function:{args:unknown}}).function.args,{who:{from:'path',name:'who'}});
 assert.equal(replies[3]!.result.isError,true);assert.equal(replies[4]!.result.isError,true);
 const scaffolded=payload(replies[5]!);assert.deepEqual(scaffolded.created,['middleware/headers.mjs','functions/hello.mjs']);
 const run=payload(replies[6]!);assert.equal(run.exitCode,0);assert.equal(run.command,'validate');
 const report=JSON.parse(String(run.stdout));assert.equal(report.event,'valid');assert.equal(report.routes,2);
 const entry=await readFile(join(root,'urlcode.yaml'),'utf8');assert.ok(entry.includes('/docs:'));assert.equal(entry.includes('/bad'),false);assert.equal(entry.includes('again'),false);
 assert.ok((await readFile(join(root,'urlcode.yaml'),'utf8')).includes('/greet/{who}:'));
 await assert.rejects(lstat(join(root,'urlcode.yaml.lock')),{code:'ENOENT'});
});
test('run_test and run_audit spawn the CLI with bounded output and report the exit code',async t=>{
 const root=await project(t,{'/a':redirect()},{'tests/requests.json':JSON.stringify([{path:'/a',status:302}])});
 const replies=await session(root,[initialize,ready,...calls([{name:'run_test',arguments:{}},{name:'run_audit',arguments:{}}])],true);
 const tested=payload(replies[1]!);assert.equal(tested.exitCode,0,JSON.stringify(tested));assert.equal(tested.truncated,false);
 const audited=payload(replies[2]!);assert.equal(audited.command,'audit');assert.equal(typeof audited.exitCode,'number');assert.ok(String(audited.stdout).length<=32768);
});
test('add_recipe dry run writes nothing; the real run publishes inside the project only',async t=>{
 const root=await project(t,{'/a':redirect()});
 const add=(dryRun:boolean)=>session(root,[initialize,ready,...calls([{name:'add_recipe',arguments:{name:'redirect',destination:'features/go',dryRun}}])],true);
 assert.equal((await add(false))[1]!.result.isError,true,'parent directory does not exist yet');await assert.rejects(lstat(join(root,'features')),{code:'ENOENT'});
 await mkdir(join(root,'features'));
 const dry=payload((await add(true))[1]!);assert.equal(dry.dryRun,true);assert.equal(dry.output,'features/go');await assert.rejects(lstat(join(root,'features/go')),{code:'ENOENT'});
 const real=payload((await add(false))[1]!);assert.equal(real.dryRun,false);assert.equal((real.validation as {valid:boolean}).valid,true);assert.ok((await lstat(join(root,'features/go/urlcode.yaml'))).isFile());
 assert.equal((await add(false))[1]!.result.isError,true,'existing destination is never merged into');
});
test('scaffold_feature creates placeholders for a created route and refuses to overwrite',async t=>{
 const root=await project(t,{'/a':redirect()});
 const replies=await session(root,[initialize,ready,...calls([{name:'create_route',arguments:{path:'/api/{id}',handler:'functions/item.mjs',middleware:['middleware/guard.mjs']}},{name:'scaffold_feature',arguments:{dryRun:true}}])],true);
 const created=payload(replies[1]!);assert.deepEqual(created.missingSources,['middleware/guard.mjs','functions/item.mjs']);assert.equal((created.validation as {valid:boolean}).valid,false);
 const dry=payload(replies[2]!);assert.equal(dry.dryRun,true);assert.deepEqual(dry.created,['middleware/guard.mjs','functions/item.mjs']);await assert.rejects(lstat(join(root,'functions')),{code:'ENOENT'});
 const done=payload((await session(root,[initialize,ready,...calls([{name:'scaffold_feature',arguments:{}}])],true))[1]!);assert.deepEqual(done.created,['middleware/guard.mjs','functions/item.mjs']);assert.equal((done.validation as {valid:boolean}).valid,true);
 await writeFile(join(root,'functions/item.mjs'),'// mine');
 const again=await session(root,[initialize,ready,...calls([{name:'scaffold_feature',arguments:{}}])],true);
 assert.deepEqual(payload(again[1]!).created,[]);assert.equal(await readFile(join(root,'functions/item.mjs'),'utf8'),'// mine');
});
// #778: a project whose `widget` extension is registered only by an external operator host file, pinned to the
// project's revision. The runners and get_context's commands must carry that host file (and the operator's origin).
const widgetYaml='version: "1"\nextensions:\n  widget:\n    version: "1"\n    config: {}\nroutes:\n  /widget/*:\n    extension: widget\n    methods: [GET, HEAD]\n';
// `extraRoutes` adds YAML under routes; `pinned` names the directory whose revision the registration pins (default:
// root); `policySchema` is the registration's route-requirement schema.
async function widgetProject(t:{after(fn:()=>Promise<void>):void},{extraRoutes='',pinned,policySchema}:{extraRoutes?:string;pinned?:(root:string)=>Promise<string>;policySchema?:object}={}) {
 const root=await mkdtemp(join(tmpdir(),'urlcode-widget-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'urlcode.yaml'),widgetYaml+extraRoutes);
 await mkdir(join(root,'tests'));await writeFile(join(root,'tests/requests.json'),JSON.stringify([{path:'/widget/',status:200,expectBody:'ok'}]));
 const dir=await mkdtemp(join(tmpdir(),'urlcode-widget-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const registration={name:'widget',version:'1',projectSha256:await inspectExtensionRevision(pinned?await pinned(root):root),targets:['node'],schema:{type:'object',additionalProperties:false},...(policySchema?{policySchema}:{})};
 const hostFile=join(dir,'host.mjs');
 await writeFile(hostFile,`export default {extensions:[{...${JSON.stringify(registration)},activate(){return {handle(){return {status:200,headers:[['content-type','text/plain']],body:'ok'};}};}}]};`);
 return {root,hostFile};
}
const widgetOrigin='https://widget.example.test';
async function hostSession(root:string,messages:unknown[],options:{hostFile?:string;origin?:string}) {
 let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
 await serveMcp({project:root,input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output,allowAuthoring:true,...options});
 return text.trim().split('\n').filter(Boolean).map(value=>JSON.parse(value) as Reply);
}
test('buildContext commands repeat the operator host file and origin and name what the operator has not supplied (#778)',async t=>{
 const {root,hostFile}=await widgetProject(t);
 const withHost=await buildContext(root,{projectFlag:'.',hostFile});
 for(const command of ['validate','test','audit','routes'])assert.ok(withHost.commands![command]!.endsWith(` --host-file ${hostFile}`),command);
 assert.equal(withHost.commands!.capabilities!.includes('--host-file'),false);
 // No origin was supplied: the commands carry none and the missing flag is named, not guessed.
 assert.equal(withHost.commands!.validate!.includes('--origin'),false);
 assert.deepEqual(withHost.prerequisites?.map(item=>item.flag),['--origin']);
 const complete=await buildContext(root,{projectFlag:'.',hostFile,origin:widgetOrigin});
 assert.equal(complete.commands!.test,`urlcode test --project . --host-file ${hostFile} --origin ${widgetOrigin}`);
 assert.equal(complete.prerequisites,undefined);
 // Without a host file the commands stay host-less and both operator flags are named.
 const bare=await buildContext(root,{projectFlag:'.'});
 assert.equal(bare.commands!.validate,'urlcode validate --local --project .');
 assert.deepEqual(bare.prerequisites?.map(item=>item.flag),['--host-file','--origin']);
 // A host path that is not a plain shell word is quoted rather than split (an already-loaded host skips the load).
 const spaced=await buildContext(root,{projectFlag:'.',hostFile:'/srv/op host/host.mjs',host:{}});
 assert.equal(spaced.commands!.validate,`urlcode validate --local --project . --host-file '/srv/op host/host.mjs'`);
});
test('with the operator host file the runners validate and test the widget route like run_tests, and get_context carries it (#778)',async t=>{
 const {root,hostFile}=await widgetProject(t);
 const messages=[initialize,ready,...calls([{name:'run_validate',arguments:{}},{name:'run_test',arguments:{}},{name:'run_tests',arguments:{}},{name:'get_context',arguments:{}}])];
 const replies=await hostSession(root,messages,{hostFile,origin:widgetOrigin});
 const validated=payload(replies[1]!),tested=payload(replies[2]!),inProcess=payload(replies[3]!),context=payload(replies[4]!) as {commands:Record<string,string>;prerequisites?:unknown};
 assert.equal(validated.exitCode,0,JSON.stringify(validated));
 assert.equal(tested.exitCode,0,JSON.stringify(tested));assert.match(String(tested.stdout),/"failed":0/);
 assert.equal(inProcess.total,1);assert.equal(inProcess.failed,0);
 assert.equal(context.commands.test,`urlcode test --project . --host-file ${hostFile} --origin ${widgetOrigin}`);
 assert.equal(context.prerequisites,undefined);
 // Without the host file the runners behave as before: the extension has no provider, so validation fails.
 const bare=await hostSession(root,[initialize,ready,...calls([{name:'run_validate',arguments:{}},{name:'get_context',arguments:{}}])],{origin:widgetOrigin});
 assert.notEqual(payload(bare[1]!).exitCode,0);
 const bareContext=payload(bare[2]!) as {commands:Record<string,string>;prerequisites:{flag:string}[]};
 assert.equal(bareContext.commands.validate,`urlcode validate --local --project . --origin ${widgetOrigin}`);
 assert.deepEqual(bareContext.prerequisites.map(item=>item.flag),['--host-file']);
});
test('authoring verdicts use the operator host file registrations: a scaffolded route under the widget extension validates (#778)',async t=>{
 // The scaffolded route carries a widget requirement, checked against the registration's policy schema. Scaffolding adds
 // a placeholder module, which changes the revision; the operator pins the reviewed post-scaffold revision (computed on
 // a scaffolded copy).
 const policySchema={type:'object',properties:{role:{const:'member'}},required:['role'],additionalProperties:false};
 const route=(role:string)=>`  /hello:\n    function:\n      source: functions/hello.mjs\n    policies:\n      extensions:\n        widget:\n          role: ${role}\n`;
 const pinned=async(root:string)=>{
  const copy=await mkdtemp(join(tmpdir(),'urlcode-widget-pin-'));t.after(()=>rm(copy,{recursive:true,force:true}));
  await cp(root,copy,{recursive:true});await scaffoldProject(copy);return copy;
 };
 const scaffold=[initialize,ready,...calls([{name:'scaffold_feature',arguments:{}}])];
 const verdictOf=async(role:string,withHost:boolean)=>{
  const {root,hostFile}=await widgetProject(t,{extraRoutes:route(role),pinned,policySchema});
  const reply=payload((await hostSession(root,scaffold,{...(withHost?{hostFile}:{}),origin:widgetOrigin}))[1]!);
  assert.deepEqual(reply.created,['functions/hello.mjs']);
  return reply.validation as {valid:boolean;note?:string};
 };
 // With the host file: a requirement the registration accepts validates, one it refuses does not.
 assert.equal((await verdictOf('member',true)).valid,true);
 assert.equal((await verdictOf('admin',true)).valid,false);
 // Without it the verdict is what it was before #778: no registration to check against, so both pass.
 assert.equal((await verdictOf('member',false)).valid,true);
 assert.equal((await verdictOf('admin',false)).valid,true);
});
