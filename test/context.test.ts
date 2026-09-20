import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Readable,Writable} from 'node:stream';
import {parse} from 'yaml';
import {buildContext,renderContext,estimateTokens} from '../src/context.ts';
import {serveMcp} from '../src/mcp.ts';
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
const cookbook=fileURLToPath(new URL('../examples/cookbook/',import.meta.url)),starter=fileURLToPath(new URL('../starters/default/',import.meta.url));
const webhookReceiver=fileURLToPath(new URL('../recipes/webhook-receiver/',import.meta.url));
test('context summarizes the cookbook from the compiled project and the capability catalog',async()=>{
 const context=await buildContext(cookbook,{projectFlag:'examples/cookbook'});
 assert.deepEqual(Object.keys(context),['urlcode','schema','project','routes','constraints','targets','commands']);
 assert.equal(context.schema,'1');assert.match(context.urlcode,/^\d+\.\d+\.\d+/);
 assert.equal(context.project.routes,40);assert.equal(context.routes?.length,40);
 assert.deepEqual(context.project.handlers,{redirect:8,respond:16,page:3,static:1,download:2,function:10});
 assert.deepEqual(context.project.policies,{project:[],routes:{agents:1,cache:1,security:1,throttle:1}});
 assert.deepEqual(context.project.site,['favicon','llms','robots','securityTxt']);
 assert.equal(context.project.files?.functions.length,10);assert.ok(context.project.files?.functions.includes('functions/hello.mjs'));
 assert.ok(context.project.files?.middleware.includes('middleware/headers.mjs'));
 assert.equal(context.project.files?.includes.length,6);
 assert.deepEqual(Object.keys(context.targets!),['self-hosted','cloudflare','aws','vercel','static']);
 assert.deepEqual(context.targets!['self-hosted']!.refused,[]);
 assert.ok(context.targets!.cloudflare!.refused.includes('function'));assert.ok(context.targets!.aws!.conditional.includes('policies.throttle'));
 assert.ok(context.targets!.static!.refused.includes('function'));
 assert.equal(context.commands?.audit,'urlcode audit --project examples/cookbook --expect-routes 40');
 assert.equal(Object.keys(context.constraints).length,9);assert.deepEqual(context.constraints.guestNetwork,{value:true,note:(context.constraints.guestNetwork as {note:string}).note});
 const one=await buildContext(cookbook,{target:'cloudflare'});assert.deepEqual(Object.keys(one.targets!),['cloudflare']);assert.equal(one.commands?.capabilities,'urlcode capabilities --target cloudflare');
});
test('context surfaces sandboxReason alongside sandbox per route, only when declared',async()=>{
 const cookbookContext=await buildContext(cookbook,{projectFlag:'examples/cookbook'});
 const trusted=cookbookContext.routes?.find(r=>r.path==='/hello/{name}');
 assert.ok(trusted);assert.equal(trusted.sandbox,false);assert.equal(trusted.sandboxReason,undefined);
 const webhookContext=await buildContext(webhookReceiver);
 const webhook=webhookContext.routes?.find(r=>r.path==='/webhook');
 assert.ok(webhook);assert.equal(webhook.sandbox,true);
 assert.equal(webhook.sandboxReason,'Third-party webhook payload; isolate parsing it even after body/content-type validation.');
});
test('context summarizes the starter and is byte-identical across runs',async()=>{
 const context=await buildContext(starter);
 assert.equal(context.project.routes,2);assert.deepEqual(context.project.handlers,{redirect:1,function:1});
 assert.deepEqual(context.project.files,{includes:['routes/functions.yaml','routes/marketing/links.yaml'],functions:['functions/hello.mjs'],middleware:['middleware/headers.mjs']});
 assert.deepEqual(context.project.bindings,{env:[],secrets:[]});
 const first=renderContext(context),second=renderContext(await buildContext(starter));
 assert.equal(first,second);assert.equal(first.includes('&'),false,'no YAML anchors');
 assert.deepEqual(parse(first),JSON.parse(JSON.stringify(context)));
});
test('a budget drops sections in a fixed order and the estimate is never exceeded',async()=>{
 assert.equal(estimateTokens('abcde'),2);
 for(const budget of [200,500,1000]) {
  const context=await buildContext(cookbook,{budget});const text=renderContext(context);
  assert.ok(estimateTokens(text)<=budget,`budget ${budget}: ${estimateTokens(text)}`);
  const omitted=context.omitted??[];
  assert.deepEqual(omitted,['routes','targets','constraintNotes','files','commands','summary'].slice(0,omitted.length));
 }
 const tight=await buildContext(cookbook,{budget:200});assert.equal(tight.routes,undefined);assert.equal(tight.targets,undefined);assert.equal(tight.constraints.guestNetwork,true);
 const full=await buildContext(cookbook,{budget:100000});assert.equal(full.omitted,undefined);
 await assert.rejects(buildContext(cookbook,{budget:0}));await assert.rejects(buildContext(cookbook,{budget:10}));
});
test('MCP get_context returns the same object read-only',async()=>{
 let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},
  {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_context',arguments:{budget:500}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_context',arguments:{hostFile:'/etc/passwd'}}}];
 await serveMcp({project:starter,input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output});
 const replies=text.trim().split('\n').map(line=>JSON.parse(line) as {result:{content:{text:string}[]};error?:{code:number}});
 assert.deepEqual(JSON.parse(replies[1]!.result.content[0]!.text),JSON.parse(JSON.stringify(await buildContext(starter,{budget:500,projectFlag:'.'}))));
 assert.equal(replies[2]!.error?.code,-32602);
});
test('the CLI emits YAML by default, JSON on request and estimates on stderr',()=>{
 const run=(...args:string[])=>spawnSync(process.execPath,[cli,'context','--project','starters/default',...args],{encoding:'utf8',timeout:20000,cwd:fileURLToPath(new URL('..',import.meta.url))});
 const yaml=run();assert.equal(yaml.status,0,yaml.stderr);const parsed=parse(yaml.stdout) as {project:{routes:number};commands:{audit:string}};
 assert.equal(parsed.project.routes,2);assert.equal(parsed.commands.audit,'urlcode audit --project starters/default --expect-routes 2');
 const json=run('--json','--stats','--budget','300');assert.equal(json.status,0,json.stderr);
 const object=JSON.parse(json.stdout) as {omitted:string[]};assert.ok(object.omitted.includes('targets'));
 const stats=JSON.parse(json.stderr) as {event:string;estimate:string;documentationTokens:number;contextTokens:number};
 assert.equal(stats.event,'stats');assert.equal(stats.estimate,'characters/4');assert.ok(stats.documentationTokens>stats.contextTokens);
 assert.equal(run('--budget','abc').status,1);assert.equal(run('extra').status,1);
});
