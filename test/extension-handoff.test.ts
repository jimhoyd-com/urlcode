// The generic reload hand-off for exclusive extension resources (RIM-EXT-HANDOFF-001, #777): a synthetic stateful
// extension holds a process-exclusive resource, the way the store holds its directory lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {stringify} from 'yaml';
import {project,request} from './helpers.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {startServer} from '../packages/core/src/server.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import type {ExtensionActivation,ExtensionInstance,RuntimeExtension} from '../packages/core/src/extensions.ts';

const origin='https://handoff.example.test';
/** Stands in for an OS-level exclusive claim (a lock file, an exclusive database handle): one holder per key. */
const claims=new Set<string>();
interface Resource {readonly key:string;readonly writes:string[];open:boolean}
interface Lease {resource:Resource;refs:number}
/**
 * A registration holding one exclusive resource. Its lease lives in the registration's closure; an activation joins
 * it only with a hand-off value this registration's own instance offered, and each instance releases only its own
 * reference. Everything else claims afresh, which a held key refuses.
 */
function vault(key:string,pin:string){
  let lease:Lease|undefined;
  const offers=new WeakMap<object,Lease>();
  const stats={handoffs:0,accepted:0,released:0,closed:0,activations:[] as ExtensionActivation[]};
  const registration:RuntimeExtension={
    name:'vault',version:'1',projectSha256:pin,targets:['node'],
    schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
    activate(config,context):ExtensionInstance{
      stats.activations.push(context);
      const offered=context.handoff?.value,joined=typeof offered==='object'&&offered!==null?offers.get(offered):undefined;
      let held:Lease;
      if(joined&&joined===lease&&joined.refs>0){joined.refs++;held=joined;stats.accepted++;}
      else{
        if(claims.has(key))throw new Error(`Resource ${key} is already held`);
        claims.add(key);held=lease={resource:{key,writes:[],open:true},refs:1};
      }
      let released=false;
      return {
        handle(incoming){
          if(!held.resource.open)return {status:500,headers:[],body:'resource closed'};
          if(incoming.method==='POST')held.resource.writes.push(`${String(config.label)}:${incoming.path}`);
          return {status:200,headers:[['content-type','application/json']],body:JSON.stringify({label:config.label,writes:held.resource.writes})};
        },
        handoff(){stats.handoffs++;if(released)return undefined;const token=Object.freeze({});offers.set(token,held);return token;},
        close(){
          stats.closed++;
          if(released)return;
          released=true;
          if(--held.refs>0)return;
          held.resource.open=false;claims.delete(key);stats.released++;
          if(lease===held)lease=undefined;
        },
      };
    },
  };
  return {registration,stats,lease:()=>lease};
}
/** Activates after the vault; throws on demand, so a reload can fail after the vault accepted its hand-off. */
function breaker(pin:string):RuntimeExtension{
  return {name:'breaker',version:'1',projectSha256:pin,targets:['node'],
    schema:{type:'object',properties:{fail:{type:'boolean'}},required:['fail'],additionalProperties:false},
    activate(config,context){
      assert.equal(context.handoff,undefined,'an instance without handoff() never offers anything');
      if(config.fail)throw new Error('breaker refused this configuration');
      return {handle(){return {status:204,headers:[]};}};
    }};
}
const document=(label:string,fail=false,text='v1')=>({version:'1',extensions:{vault:{version:'1',config:{label}},breaker:{version:'1',config:{fail}}},
  routes:{'/vault/*':{extension:'vault',methods:['GET','POST']},'/breaker/*':{extension:'breaker',methods:['GET']},'/hello':{respond:{text}}}});
async function site(t:import('node:test').TestContext,key:string){
  const initial=document('one');
  const root=await project(t,initial.routes,{},{extensions:initial.extensions});
  const pin=await inspectExtensionRevision(root);
  const store=vault(key,pin);
  const edit=(label:string,fail=false,text='v1')=>writeFile(join(root,'urlcode.yaml'),stringify(document(label,fail,text)));
  return {root,pin,store,edit,extensions:[store.registration,breaker(pin)]};
}
async function until(check:()=>boolean,what:string):Promise<void>{
  const deadline=Date.now()+10000;
  while(!check()){if(Date.now()>deadline)throw new Error(`Timed out waiting for ${what}`);await new Promise(resolve=>setTimeout(resolve,20));}
}
const writes=async(app:{address:{port:number}})=>(JSON.parse((await request(app,'/vault/x')).body) as {label:string;writes:string[]});

test('a reload hands the exclusive resource to the replacement, and the retired runtime keeps it (#777)',async t=>{
  const {root,store,edit,extensions}=await site(t,'reload-ok');
  const app=await startServer({project:root,origin,port:0,followExtensionPinOnReload:true,extensions,log:()=>{}});
  t.after(()=>app.close());
  assert.equal(store.stats.activations[0]!.handoff,undefined,'a first activation has no hand-off');
  assert.equal((await request(app,'/vault/a',{method:'POST'})).status,200);
  const before=store.lease()!.resource;
  await edit('two',false,'v2');
  assert.equal(await app.reload(),true,'the replacement joins the resource instead of failing on it');
  assert.equal(store.stats.handoffs,1);assert.equal(store.stats.accepted,1);
  assert.notEqual(store.stats.activations[1]!.handoff,undefined);
  assert.equal((await request(app,'/hello')).body,'v2');
  // The retired runtime closes on its own once idle: that close releases only its own reference.
  await until(()=>store.stats.closed===1,'the retired runtime to close');
  assert.equal(store.stats.released,0,'closing the old runtime did not release the handed-off resource');
  assert.equal(store.lease()!.resource,before,'the same resource, not a fresh one');
  assert.ok(before.open&&claims.has('reload-ok'));
  assert.equal((await request(app,'/vault/b',{method:'POST'})).status,200,'writes after the reload reach the same resource');
  assert.deepEqual(await writes(app),{label:'two',writes:['one:/vault/a','two:/vault/b']});
  // A second reload hands off again, from the runtime that is now serving.
  await edit('three',false,'v3');
  assert.equal(await app.reload(),true);
  await until(()=>store.stats.closed===2,'the second retired runtime to close');
  assert.equal(store.stats.released,0);
  await app.close();
  assert.equal(store.stats.released,1,'the last reference releases the resource');
  assert.ok(!before.open&&!claims.has('reload-ok'));
});

test('a reload that fails after the hand-off leaves the serving runtime and its resource intact (#777)',async t=>{
  const {root,store,edit,extensions}=await site(t,'reload-fails');
  const events:Record<string,unknown>[]=[],diagnostics:string[]=[];
  const app=await startServer({project:root,origin,port:0,followExtensionPinOnReload:true,extensions,log:event=>{events.push(event as Record<string,unknown>);},debugErrors:true,diagnostics:line=>{diagnostics.push(line);}});
  t.after(()=>app.close());
  assert.equal((await request(app,'/vault/a',{method:'POST'})).status,200);
  const resource=store.lease()!.resource;
  // The vault activates first and accepts the hand-off; the breaker, activated after it, then throws.
  await edit('two',true,'v2');
  assert.equal(await app.reload(),false);
  assert.equal(events.filter(event=>event.event==='reload').at(-1)?.status,'rejected');
  assert.match(JSON.parse(diagnostics.at(-1)!).message,/Extension "breaker" failed to activate: breaker refused this configuration/);
  assert.equal(store.stats.accepted,1,'the vault did accept the hand-off before the breaker failed');
  assert.equal(store.stats.closed,1,'core closed the replacement vault it had activated');
  assert.equal(store.stats.released,0,'that close released only the replacement reference');
  assert.equal(store.lease()!.refs,1);
  assert.ok(resource.open&&claims.has('reload-fails'));
  assert.equal((await request(app,'/hello')).body,'v1','the last-good snapshot keeps serving');
  assert.equal((await request(app,'/vault/b',{method:'POST'})).status,200,'and its resource is still usable');
  assert.deepEqual(await writes(app),{label:'one',writes:['one:/vault/a','one:/vault/b']});
  // Fixed, the next reload hands off from the runtime that kept serving.
  await edit('three',false,'v3');
  assert.equal(await app.reload(),true);
  assert.deepEqual(await writes(app),{label:'three',writes:['one:/vault/a','one:/vault/b']});
});

test('only a reload shares the resource: a second owner, a fresh start and a closed runtime are refused (#777)',async t=>{
  const {root,pin,store,extensions}=await site(t,'second-owner');
  const app=await startServer({project:root,origin,port:0,followExtensionPinOnReload:true,extensions,log:()=>{}});
  t.after(()=>app.close());
  // Another registration of the same extension (another host, another operator process stand-in) never joins.
  const other=vault('second-owner',pin);
  await assert.rejects(createRuntime(root,{origin,extensions:[other.registration,breaker(pin)]}),/Extension "vault" failed to activate: Resource second-owner is already held/);
  // The same registration without a reload is a second, independent activation: refused exactly as before.
  await assert.rejects(createRuntime(root,{origin,extensions}),/Resource second-owner is already held/);
  // A runtime that is not serving offers nothing.
  const lone=await project(t,{'/hello':{respond:{text:'x'}}});
  const closed=await createRuntime(lone,{origin});await closed.close();
  await assert.rejects(createRuntime(root,{origin,extensions,replacing:closed}),/replaces only a serving runtime/);
  // A startServer caller cannot name the runtime a reload replaces.
  await assert.rejects(startServer({project:root,origin,port:0,extensions,log:()=>{},...{replacing:closed}}),/set only by the server reload/);
  assert.equal(store.stats.handoffs,0);
  assert.ok(store.lease()!.resource.open,'every refusal left the serving resource alone');
  assert.equal((await request(app,'/vault/a',{method:'POST'})).status,200);
});

test('a hand-off crosses only the same registration object, and createRuntime can replace directly (#777)',async t=>{
  const {root,pin,store,extensions}=await site(t,'same-registration');
  const serving=await createRuntime(root,{origin,extensions});
  t.after(()=>serving.close());
  // Another registration object under the same name is never offered the serving instance's hand-off.
  const stranger=vault('same-registration',pin);
  await assert.rejects(createRuntime(root,{origin,extensions:[stranger.registration,breaker(pin)],replacing:serving}),/already held/);
  assert.equal(store.stats.handoffs,0);
  assert.equal(stranger.stats.activations[0]!.handoff,undefined);
  // The same registration is: the replacement joins, and closing the replaced runtime keeps the resource.
  const next=await createRuntime(root,{origin,extensions,replacing:serving});
  assert.equal(store.stats.accepted,1);
  await serving.close();
  assert.equal(store.stats.released,0);
  assert.ok(store.lease()!.resource.open);
  await next.close();
  assert.equal(store.stats.released,1);
});

test('a throwing hand-off rejects the reload and the serving runtime keeps its resource (#777)',async t=>{
  const {root,store,edit,extensions}=await site(t,'handoff-throws');
  const diagnostics:string[]=[];
  const app=await startServer({project:root,origin,port:0,followExtensionPinOnReload:true,extensions,log:()=>{},debugErrors:true,diagnostics:line=>{diagnostics.push(line);}});
  t.after(()=>app.close());
  const original=store.registration.activate;
  store.registration.activate=async(config,context)=>{const instance=await original.call(store.registration,config,context);instance.handoff=()=>{throw new Error('cannot offer now');};return instance;};
  await edit('two');
  assert.equal(await app.reload(),true,'the first runtime was activated before handoff() started throwing');
  await edit('three');
  assert.equal(await app.reload(),false);
  assert.match(JSON.parse(diagnostics.at(-1)!).message,/Extension "vault" failed to hand off for a reload: cannot offer now/);
  assert.equal((await writes(app)).label,'two');
  assert.ok(store.lease()!.resource.open);
});
