// `urlcode dev`'s hot reload carries the extension revision pin forward to the edited project (#777, RIM-EXT-PIN-001).
import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stringify} from 'yaml';
import {project,request} from './helpers.ts';
import {createRuntime} from '../packages/core/src/runtime.ts';
import {startServer} from '../packages/core/src/server.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';

const origin='https://pin.example.test';
const mount={extension:'demo',methods:['GET']};
const declaration=(config:Record<string,unknown>={label:'hello'},version='1')=>({demo:{version,config}});
const routes=(text:string)=>({'/demo/*':mount,'/hello':{respond:{text}}});
// The mount answers with the revision it was activated for, so a test can see which revision the pin now names.
async function registration(root:string,pin?:string):Promise<RuntimeExtension>{return {
  name:'demo',version:'1',projectSha256:pin??await inspectExtensionRevision(root),targets:['node'],
  schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
  activate(_config,context){return {handle(){return {status:200,headers:[['content-type','text/plain']],body:context.projectSha256};}};},
};}
const edit=(root:string,text:string,extensions:Record<string,unknown>=declaration())=>writeFile(join(root,'urlcode.yaml'),stringify({version:'1',extensions,routes:routes(text)}));
async function until(check:()=>boolean|Promise<boolean>,what:string,ms=15000):Promise<void>{
  const deadline=Date.now()+ms;
  while(!await check()){if(Date.now()>deadline)throw new Error(`Timed out waiting for ${what}`);await new Promise(resolve=>setTimeout(resolve,50));}
}

test('a dev reload follows the startup pin to the edited revision and says so once (#777)',async t=>{
  const root=await project(t,routes('v1'),{},{extensions:declaration()});
  const started=await inspectExtensionRevision(root);
  const events:Record<string,unknown>[]=[];
  const app=await startServer({project:root,origin,port:0,watch:true,followExtensionPinOnReload:true,extensions:[await registration(root)],log:event=>{events.push(event as Record<string,unknown>);}});
  t.after(()=>app.close());
  assert.equal((await request(app,'/demo/x')).body,started);
  assert.ok(!events.some(event=>event.event==='extension_pin_followed'),'the first runtime matched its pin and follows nothing');
  await edit(root,'v2');
  const edited=await inspectExtensionRevision(root);assert.notEqual(edited,started);
  await until(()=>events.some(event=>event.event==='reload'),'the watcher reload');
  assert.deepEqual(events.filter(event=>event.event==='reload').map(event=>event.status),['ok']);
  assert.deepEqual(events.filter(event=>event.event==='extension_pin_followed'),[{event:'extension_pin_followed',extensions:['demo'],from:started,to:edited}]);
  assert.equal((await request(app,'/hello')).body,'v2');
  assert.equal((await request(app,'/demo/x')).body,edited,'the extension is activated for the edited live revision');
  // A second edit still follows from the revision the server started from, not from the previous reload.
  await edit(root,'v3');
  const third=await inspectExtensionRevision(root);
  await until(()=>events.filter(event=>event.event==='reload').length===2,'the second watcher reload');
  assert.deepEqual(events.filter(event=>event.event==='extension_pin_followed').at(-1),{event:'extension_pin_followed',extensions:['demo'],from:started,to:third});
  assert.equal((await request(app,'/hello')).body,'v3');
  // Editing back to the reviewed revision matches the pin exactly again: nothing to follow.
  await edit(root,'v1');
  await until(()=>events.filter(event=>event.event==='reload').length===3,'the third watcher reload');
  assert.equal(events.filter(event=>event.event==='extension_pin_followed').length,2);
  assert.equal((await request(app,'/demo/x')).body,started);
});

test('without the dev option a reload, serve and createRuntime keep refusing the stale pin (#777)',async t=>{
  const root=await project(t,routes('v1'),{},{extensions:declaration()});
  const extension=await registration(root);
  const events:Record<string,unknown>[]=[],diagnostics:string[]=[];
  const app=await startServer({project:root,origin,port:0,extensions:[extension],log:event=>{events.push(event as Record<string,unknown>);},debugErrors:true,diagnostics:line=>{diagnostics.push(line);}});
  t.after(()=>app.close());
  await edit(root,'v2');
  assert.equal(await app.reload(),false);
  assert.equal(events.filter(event=>event.event==='reload').at(-1)?.status,'rejected');
  assert.equal(JSON.parse(diagnostics.at(-1)!).message,'Extension revision pin mismatch: demo');
  assert.ok(!events.some(event=>event.event==='extension_pin_followed'));
  assert.equal((await request(app,'/hello')).body,'v1','the last-good snapshot keeps serving');
  await assert.rejects(createRuntime(root,{origin,extensions:[extension]}),/Extension revision pin mismatch: demo/);
  // The runtime option is derived by the dev server itself; a startServer caller cannot hand one in.
  await assert.rejects(startServer({project:root,origin,port:0,extensions:[extension],log:()=>{},...{acceptedExtensionPin:{from:extension.projectSha256}}}),/set only by the dev server reload/);
  // Following accepts only the exact startup revision, never any other pin.
  await assert.rejects(createRuntime(root,{origin,extensions:[extension],acceptedExtensionPin:{from:'0'.repeat(64)}}),/Extension revision pin mismatch: demo/);
});

test('a dev reload still runs every other extension check (#777)',async t=>{
  const root=await project(t,routes('v1'),{},{extensions:declaration()});
  const events:Record<string,unknown>[]=[],diagnostics:string[]=[];
  const app=await startServer({project:root,origin,port:0,followExtensionPinOnReload:true,extensions:[await registration(root)],log:event=>{events.push(event as Record<string,unknown>);},debugErrors:true,diagnostics:line=>{diagnostics.push(line);}});
  t.after(()=>app.close());
  const rejected=async(extensions:Record<string,unknown>,message:RegExp)=>{
    await edit(root,'v2',extensions);
    assert.equal(await app.reload(),false);
    assert.match(JSON.parse(diagnostics.at(-1)!).message,message);
    assert.equal((await request(app,'/hello')).body,'v1');
  };
  await rejected(declaration({label:7}),/Invalid extension configuration at \/extensions\/demo\/config\/label \(type\)/);
  await rejected(declaration({label:'x',extra:true}),/Invalid extension configuration at \/extensions\/demo\/config \(additionalProperties\)/);
  // A changed contract version is refused by the project schema before the extension checks run.
  await rejected(declaration({label:'x'},'2'),/Invalid configuration at \/extensions\/demo\/version \(const\): must be "1"$/);
  assert.ok(!events.some(event=>event.event==='extension_pin_followed'),'a rejected reload never reports a followed pin');
  // The target check still applies to a followed pin (createRuntime is what the dev reload calls).
  await edit(root,'v2');
  const extension=await registration(root,await inspectExtensionRevision(root));
  await assert.rejects(createRuntime(root,{origin,target:'aws',extensions:[{...extension,projectSha256:'a'.repeat(64)}],acceptedExtensionPin:{from:'a'.repeat(64)}}),/Cannot activate\/build project for aws/);
  await edit(root,'v2');
  assert.equal(await app.reload(),true);
  assert.equal(events.filter(event=>event.event==='extension_pin_followed').length,1);
});

test('the first dev runtime keeps the strict pin check (#777)',async t=>{
  const root=await project(t,routes('v1'),{},{extensions:declaration()});
  await assert.rejects(startServer({project:root,origin,port:0,followExtensionPinOnReload:true,extensions:[await registration(root,'0'.repeat(64))],log:()=>{}}),/Extension revision pin mismatch: demo/);
});

test('urlcode dev --host-file hot reloads an edit; serve never enables following (#777)',async t=>{
  const root=await project(t,routes('v1'),{},{extensions:declaration()});
  const dir=await mkdtemp(join(tmpdir(),'urlcode-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const host=join(dir,'host.mjs');
  await writeFile(host,`export default {extensions:[{name:'demo',version:'1',projectSha256:process.env.PROJECT_SHA256,targets:['node'],
  schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
  activate(_config,context){return {handle(){return {status:200,headers:[['content-type','text/plain']],body:context.projectSha256};}};}}]};\n`);
  const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const started=await inspectExtensionRevision(root);
  const run=(command:string,pin:string)=>{
    const child=spawn(process.execPath,['--conditions=development',cli,command,'--project',root,'--origin',origin,'--port','0','--host-file',host],{env:{...process.env,PROJECT_SHA256:pin},stdio:['ignore','pipe','pipe']});
    const lines:Record<string,unknown>[]=[];let buffered='',stderr='';
    child.stdout.setEncoding('utf8').on('data',(chunk:string)=>{buffered+=chunk;const parts=buffered.split('\n');buffered=parts.pop()!;for(const part of parts)if(part.trim())lines.push(JSON.parse(part) as Record<string,unknown>);});
    child.stderr.setEncoding('utf8').on('data',(chunk:string)=>{stderr+=chunk;});
    const exited=new Promise<number|null>(resolve=>child.once('exit',code=>resolve(code)));
    t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await exited;}});
    return {child,lines,exited,stderr:()=>stderr};
  };
  // The first dev start refuses a stale pin exactly as before.
  const stale=run('dev','0'.repeat(64));
  assert.equal(await stale.exited,1);assert.match(stale.stderr(),/Extension revision pin mismatch: demo/);
  const dev=run('dev',started);
  await until(()=>dev.lines.some(line=>line.event==='listening'),'dev to listen');
  const port=dev.lines.find(line=>line.event==='listening')!.port as number;
  await edit(root,'v2');
  const edited=await inspectExtensionRevision(root);
  await until(()=>dev.lines.some(line=>line.event==='reload'),'the dev reload');
  assert.equal(dev.lines.find(line=>line.event==='reload')!.status,'ok',dev.stderr());
  assert.deepEqual(dev.lines.find(line=>line.event==='extension_pin_followed'),{event:'extension_pin_followed',extensions:['demo'],from:started,to:edited});
  assert.equal((await request({address:{port}},'/hello')).body,'v2');
  assert.equal((await request({address:{port}},'/demo/x')).body,edited);
  // serve starts only from the reviewed revision: the edited project with the old pin is refused.
  const serve=run('serve',started);
  assert.equal(await serve.exited,1);assert.match(serve.stderr(),/Extension revision pin mismatch: demo/);
});
