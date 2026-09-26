// A reload hands each extension over with at most one live activation, and keeps the last-good one on a refusal
// (#777, RIM-EXT-HANDOFF-001). The real stateful composition is covered in packages/form-records/test/reload.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {stringify} from 'yaml';
import {project,request} from './helpers.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {startServer} from '../packages/core/src/server.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';

const origin='https://handoff.example.test';
const routes=(text:string)=>({'/x/*':{extension:'excl',methods:['GET']},'/hello':{respond:{text}}});
const declaration=(label:string)=>({excl:{version:'1',config:{label}}});
const edit=(root:string,text:string,label:string)=>writeFile(join(root,'urlcode.yaml'),stringify({version:'1',extensions:declaration(label),routes:routes(text)}));

/**
 * An extension holding an exclusive resource, the way store holds its directory lock: a second live activation is
 * refused, `label: refuse` refuses to activate, and `hold()` keeps the next request running until released.
 */
function exclusive(pin:string){
  const state={live:0,maxLive:0,activations:0,closes:0,refuseEverything:false,gate:undefined as Promise<void>|undefined,entered:undefined as (()=>void)|undefined};
  const registration:RuntimeExtension={name:'excl',version:'1',projectSha256:pin,targets:['node'],
    schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
    activate(config){
      if(state.live)throw new Error('Resource is already locked by this process');
      if(state.refuseEverything||config.label==='refuse')throw new Error(`refusing ${String(config.label)}`);
      state.live++;state.maxLive=Math.max(state.maxLive,state.live);state.activations++;
      let open=true;
      return {
        async handle(){
          const gate=state.gate;state.gate=undefined;
          if(gate){state.entered?.();await gate;}
          assert.ok(open,'a request ran on a closed activation');
          return {status:200,headers:[['content-type','text/plain']],body:String(config.label)};
        },
        close(){open=false;state.live--;state.closes++;},
      };
    }};
  const hold=()=>{let release!:()=>void;state.gate=new Promise<void>(resolve=>{release=resolve;});const entered=new Promise<void>(resolve=>{state.entered=resolve;});return {release,entered};};
  return {registration,state,hold};
}
async function started(t:import('node:test').TestContext,options:{closeTimeoutMs?:number}={}){
  const root=await project(t,routes('v1'),{},{extensions:declaration('one')});
  const extension=exclusive(await inspectExtensionRevision(root));
  const events:Record<string,unknown>[]=[],diagnostics:Record<string,unknown>[]=[];
  const app=await startServer({project:root,origin,port:0,followExtensionPinOnReload:true,extensions:[extension.registration],debugErrors:true,
    log:event=>{events.push(event as Record<string,unknown>);},diagnostics:line=>{diagnostics.push(JSON.parse(line) as Record<string,unknown>);},...options});
  t.after(()=>app.close());
  return {root,app,events,diagnostics,...extension};
}

test('a reload closes the serving activation before the replacement activates (#777)',async t=>{
  const {root,app,state,events}=await started(t);
  assert.equal((await request(app,'/x/a')).body,'one');
  await edit(root,'v2','two');
  assert.equal(await app.reload(),true);
  assert.equal((await request(app,'/x/a')).body,'two');
  assert.equal((await request(app,'/hello')).body,'v2');
  assert.deepEqual({live:state.live,maxLive:state.maxLive,activations:state.activations,closes:state.closes},{live:1,maxLive:1,activations:2,closes:1});
  assert.deepEqual(events.filter(event=>event.event==='reload').map(event=>event.status),['ok']);
  await app.close();
  assert.equal(state.live,0,'close releases the live activation once');
});

test('a refused replacement restores the last-good activation and keeps serving it (#777)',async t=>{
  const {root,app,state,events,diagnostics}=await started(t);
  await edit(root,'v2','refuse');
  assert.equal(await app.reload(),false);
  assert.match(String(diagnostics.at(-1)?.message),/Extension "excl" failed to activate: refusing refuse/);
  assert.equal(diagnostics.at(-1)?.extensions,undefined,'the last-good extensions are back');
  assert.equal((await request(app,'/x/a')).body,'one');
  assert.equal((await request(app,'/hello')).body,'v1');
  assert.equal((await request(app,'/_urlcode/ready')).status,200);
  assert.deepEqual({live:state.live,maxLive:state.maxLive,activations:state.activations,closes:state.closes},{live:1,maxLive:1,activations:2,closes:1});
  assert.ok(!events.some(event=>event.event==='extension_pin_followed'),'a rejected reload never reports a followed pin');
  // The next good edit still hands over.
  await edit(root,'v3','three');
  assert.equal(await app.reload(),true);
  assert.equal((await request(app,'/x/a')).body,'three');
  assert.equal(state.maxLive,1);
});

test('a failed restore answers 503 and reports it until a later reload succeeds (#777)',async t=>{
  const {root,app,state,diagnostics}=await started(t);
  state.refuseEverything=true;
  await edit(root,'v2','two');
  assert.equal(await app.reload(),false);
  assert.match(String(diagnostics.at(-1)?.message),/refusing two; restoring the last-good extensions also failed: .*refusing one/);
  assert.equal(diagnostics.at(-1)?.extensions,'unavailable');
  assert.equal(state.live,0);
  assert.equal((await request(app,'/x/a')).status,503);
  assert.equal((await request(app,'/hello')).status,503,'no route of a snapshot without its extensions is served');
  assert.equal((await request(app,'/_urlcode/ready')).status,503);
  assert.equal((await request(app,'/_urlcode/health')).status,200);
  state.refuseEverything=false;
  await edit(root,'v3','three');
  assert.equal(await app.reload(),true);
  assert.equal((await request(app,'/x/a')).body,'three');
  assert.equal((await request(app,'/_urlcode/ready')).status,200);
});

test('a reload waits for requests in flight and holds new ones until the handoff ends (#777)',async t=>{
  const {root,app,state,hold}=await started(t);
  const held=hold();
  const first=request(app,'/x/slow');
  await held.entered;
  await edit(root,'v2','two');
  const reloading=app.reload();
  // The replacement is built while the serving snapshot answers; once the handoff starts, a new request is held
  // (it no longer answers promptly) and is then answered by the replacement snapshot.
  let second:ReturnType<typeof request>|undefined;
  for(let attempt=0;attempt<400&&!second;attempt++){
    await new Promise(resolve=>setTimeout(resolve,25));
    const probe=request(app,'/hello');
    const answered=await Promise.race([probe,new Promise<undefined>(resolve=>setTimeout(()=>resolve(undefined),150))]);
    if(answered===undefined)second=probe;else assert.equal(answered.body,'v1');
  }
  assert.ok(second,'the handoff started');
  const third=request(app,'/x/next');
  await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(state.closes,0,'the serving activation stays open while a request runs in it');
  held.release();
  assert.equal((await first).body,'one');
  assert.equal(await reloading,true);
  assert.equal((await second).body,'v2');
  assert.equal((await third).body,'two');
  assert.equal(state.maxLive,1);
});

test('a reload whose serving requests do not settle in time is rejected and keeps the serving activation (#777)',async t=>{
  const {root,app,state,hold,diagnostics}=await started(t,{closeTimeoutMs:100});
  const held=hold();
  const first=request(app,'/x/slow');
  await held.entered;
  await edit(root,'v2','two');
  assert.equal(await app.reload(),false);
  assert.match(String(diagnostics.at(-1)?.message),/requests were still running on the serving snapshot after 100 ms/);
  assert.deepEqual({live:state.live,activations:state.activations,closes:state.closes},{live:1,activations:1,closes:0});
  held.release();
  assert.equal((await first).body,'one');
  assert.equal((await request(app,'/x/b')).body,'one');
  assert.equal(await app.reload(),true,'the edit applies on the next reload');
  assert.equal((await request(app,'/x/b')).body,'two');
});

test('a deferred runtime refuses requests until its extensions activate, and activates again after a release (#777)',async t=>{
  const root=await project(t,routes('v1'),{},{extensions:declaration('one')});
  const {registration,state}=exclusive(await inspectExtensionRevision(root));
  const runtime=await createRuntime(root,{origin,extensions:[registration],deferExtensions:true});
  t.after(()=>runtime.close());
  assert.deepEqual({declared:runtime.extensions.declared,active:runtime.extensions.active,healthy:runtime.healthy},{declared:true,active:false,healthy:false});
  await assert.rejects(runtime.handle({target:'/hello'}),/Runtime unavailable/);
  await runtime.extensions.activate();
  assert.equal(runtime.healthy,true);
  assert.equal(String((await runtime.handle({target:'/x/a'})).body),'one');
  assert.equal(await runtime.extensions.release(1000),true);
  assert.equal(state.live,0);
  await runtime.extensions.activate();
  assert.equal(String((await runtime.handle({target:'/x/a'})).body),'one');
  assert.deepEqual({activations:state.activations,closes:state.closes,maxLive:state.maxLive},{activations:2,closes:1,maxLive:1});
  const plain=await createRuntime(await project(t,{'/hello':{respond:{text:'v1'}}}),{deferExtensions:true});
  t.after(()=>plain.close());
  assert.deepEqual({declared:plain.extensions.declared,active:plain.extensions.active},{declared:false,active:true});
  assert.equal(String((await plain.handle({target:'/hello'})).body),'v1');
});

test('startServer refuses a caller-supplied deferExtensions (#777)',async t=>{
  const root=await project(t,routes('v1'));
  await assert.rejects(startServer({project:root,port:0,log:()=>{},...{deferExtensions:true}}),/set only by the server reload/);
});
