import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn,spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {project,request} from './helpers.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {startServer} from '../packages/core/src/server.ts';
import {createLambdaHandler} from '../packages/core/src/aws.ts';
import {activationWarnings,inspectExtensionRevision,maxExtensionWarnings} from '../packages/core/src/extensions.ts';
import type {ExtensionActivation,RuntimeExtension} from '../packages/core/src/extensions.ts';

// RIM-EXT-WARN-001: an extension's activation-time warn() reaches the operator log only.
const origin='https://warnings.example.test';
const declarations={demo:{version:'1',config:{}}};
const routes={'/demo/*':{extension:'demo',methods:['GET']}};
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
async function registration(root:string,activate:RuntimeExtension['activate']):Promise<RuntimeExtension>{
  return {name:'demo',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],schema:{type:'object',additionalProperties:false},activate};
}
const warnings=(events:Record<string,unknown>[])=>events.filter(event=>event.event==='extension_warning');

test('warn() during activation is logged as one bounded extension_warning record per call, capped per activation',async t=>{
  const root=await project(t,routes,{},{extensions:declarations});
  const events:Record<string,unknown>[]=[];
  let late:ExtensionActivation['warn'];
  const demo=await registration(root,async(_config,context)=>{
    assert.equal(typeof context.warn,'function');
    context.warn!('3 records need attention');
    context.warn!(`first line\nsecond\u0007line ${'x'.repeat(2000)}`);
    await Promise.resolve();
    context.warn!('');
    for(let i=0;i<40;i++)context.warn!(`repeated ${i}`);
    late=context.warn;
    return {handle(){late!('request-time warning');return {status:200,headers:[['content-type','text/plain']],body:'ok'};}};
  });
  const runtime=await createRuntime(root,{origin,extensions:[demo],log:event=>{events.push(event);}});t.after(()=>runtime.close());
  const logged=warnings(events);
  assert.equal(logged.length,maxExtensionWarnings+1);
  assert.deepEqual(logged[0],{event:'extension_warning',extension:'demo',message:'3 records need attention'});
  const bounded=String(logged[1]!.message);
  assert.ok(bounded.startsWith('first line second line x'));assert.ok(bounded.endsWith('...'));assert.equal(bounded.length,503);
  assert.equal(logged[2]!.message,'warning with no message');
  assert.equal(logged.at(-2)!.message,`repeated ${maxExtensionWarnings-4}`);
  assert.deepEqual(logged.at(-1),{event:'extension_warning',extension:'demo',message:`further warnings suppressed after ${maxExtensionWarnings} in this activation`});
  for(const record of logged)assert.deepEqual(Object.keys(record).sort(),['event','extension','message']);
  // A call after activate() settled is ignored, and nothing reaches the response.
  const answer=await runtime.handle({target:'/demo/x',method:'GET'});
  assert.equal(answer.status,200);assert.equal(Buffer.from(answer.body??'').toString(),'ok');
  assert.ok(!JSON.stringify(answer.headers).includes('warning'));
  assert.equal(warnings(events).length,maxExtensionWarnings+1);
});

test('the warn channel is closed when activation throws, and a throwing log never fails activation',async()=>{
  const channel=activationWarnings('demo',()=>{throw new Error('log sink failed');});
  channel.warn('ignored failure');channel.close();
  const seen:unknown[]=[];const closed=activationWarnings('demo',event=>{seen.push(event);});closed.close();closed.warn('after close');
  assert.deepEqual(seen,[]);
  const unset=activationWarnings('demo',undefined);unset.warn('no log');
});

test('startServer logs activation warnings to its log; HTTP responses never carry them',async t=>{
  const root=await project(t,routes,{},{extensions:declarations});
  const events:Record<string,unknown>[]=[];
  const demo=await registration(root,(_config,context)=>{context.warn!('2 stored records use an old setting; see the docs');return {handle(){return {status:200,headers:[['content-type','text/plain']],body:'ok'};}};});
  const app=await startServer({project:root,origin,port:0,extensions:[demo],log:event=>{events.push(event as Record<string,unknown>);}});t.after(()=>app.close());
  assert.deepEqual(warnings(events),[{event:'extension_warning',extension:'demo',message:'2 stored records use an old setting; see the docs'}]);
  const response=await request(app,'/demo/x');
  assert.equal(response.status,200);assert.equal(response.body,'ok');
  assert.ok(!response.body.includes('old setting'));assert.ok(!JSON.stringify(response.headers).includes('old setting'));
  assert.equal(warnings(events).length,1);
});

test('hosted adapters write activation warnings to the function log only',async t=>{
  const root=await project(t,routes,{},{extensions:declarations});
  const demo=await registration(root,(_config,context)=>{context.warn!('hosted warning');return {handle(){return {status:200,headers:[['content-type','text/plain']],body:'ok'};}};});
  const logged:unknown[]=[];const consoleWarn=console.warn;console.warn=(...args:unknown[])=>{logged.push(...args);};t.after(()=>{console.warn=consoleWarn;});
  const handler=createLambdaHandler({project:root,origin,extensions:[demo],environment:{}});
  const result=await handler({version:'2.0',rawPath:'/demo/x',rawQueryString:'',headers:{},requestContext:{http:{method:'GET'}}});
  console.warn=consoleWarn;
  assert.equal(result.statusCode,200);assert.ok(!Buffer.from(result.body,'base64').toString().includes('hosted warning'));
  assert.deepEqual(logged.map(entry=>JSON.parse(String(entry))),[{event:'extension_warning',extension:'demo',message:'hosted warning'}]);
});

test('validate, test and dev print an extension activation warning',async t=>{
  const root=await project(t,routes,{'tests/requests.json':JSON.stringify([{path:'/demo/x',status:200}])},{extensions:declarations});
  const dir=await mkdtemp(join(tmpdir(),'urlcode-warn-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const {activate:_activate,...data}=await registration(root,()=>({handle:()=>({status:200,headers:[]})}));
  const host=join(dir,'host.mjs');
  await writeFile(host,`export default {extensions:[{...${JSON.stringify(data)},activate(config,context){context.warn('4 stored items use a retired setting');return {handle(){context.warn('request time');return {status:200,headers:[['content-type','text/plain']],body:'ok'};}};}}]};`);
  const expected={event:'extension_warning',extension:'demo',message:'4 stored items use a retired setting'};
  const lines=(text:string)=>text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
  for(const command of ['validate','test'])await t.test(command,()=>{
    const out=spawnSync(process.execPath,[cli,command,'--project',root,'--origin',origin,'--host-file',host],{encoding:'utf8',timeout:20000});
    assert.equal(out.status,0,out.stderr);
    const printed=lines(out.stdout);
    assert.deepEqual(warnings(printed),[expected]);
    assert.ok(!out.stdout.includes('request time'));
    if(command==='validate')assert.equal(printed.at(-1)!.event,'valid');else assert.equal(printed.at(-1)!.failed,0);
  });
  await t.test('dev',async()=>{
    const child=spawn(process.execPath,[cli,'dev','--project',root,'--origin',origin,'--host-file',host,'--port','0'],{stdio:['ignore','pipe','pipe']});
    t.after(()=>child.kill());
    let stdout='';
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`dev did not start: ${stdout}`)),20000);
      child.stdout.on('data',(chunk:Buffer)=>{stdout+=chunk.toString();if(stdout.includes('"event":"listening"')){clearTimeout(timer);resolve();}});
      child.on('exit',code=>{clearTimeout(timer);reject(new Error(`dev exited ${code}: ${stdout}`));});
    });
    child.kill();
    assert.deepEqual(warnings(lines(stdout)),[expected]);
  });
});
