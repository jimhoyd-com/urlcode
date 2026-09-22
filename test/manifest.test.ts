import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable,Writable} from 'node:stream';
import {buildManifest,renderManifest} from '../packages/core/src/manifest.ts';
import {buildCloudflare} from '../packages/core/src/build-cloudflare.ts';
import {inspectProject} from '../packages/core/src/tooling.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import {serveMcp} from '../packages/core/src/mcp.ts';
import {project,redirect} from './helpers.ts';
const cookbook=fileURLToPath(new URL('../examples/cookbook/',import.meta.url));
const extensions=fileURLToPath(new URL('../examples/extensions/',import.meta.url));
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
const version=(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;

test('the manifest is deterministic and its revision is the extension revision digest',async()=>{
  const first=await buildManifest(cookbook),second=await buildManifest(cookbook);
  assert.equal(renderManifest(first),renderManifest(second));
  assert.equal(first.revision,await inspectExtensionRevision(cookbook));
  assert.equal(first.schemaVersion,3);assert.equal(first.urlcode,version);assert.equal(first.entry,'urlcode.yaml');
  assert.deepEqual(first.files,['urlcode.yaml','routes/code.yaml','routes/redirects.yaml','routes/responses.yaml','routes/files.yaml','routes/policies.yaml','routes/middleware.yaml']);
  const inspected=await inspectProject(cookbook);
  assert.equal(first.routeCount,inspected.routeCount);assert.equal(first.revision,inspected.projectSha256);
  assert.deepEqual(first.routes.map(route=>route.path),[...first.routes.map(route=>route.path)].sort());
  for(const route of inspected.routes){const entry=first.routes.find(item=>item.path===route.path);assert.ok(entry,route.path);assert.deepEqual(entry.methods,route.methods);assert.deepEqual(entry.capabilities,route.capabilities);assert.equal(entry.enabled,route.enabled);}
  assert.ok(first.functions.some(item=>item.source==='functions/hello.mjs'&&item.export==='hello'&&item.routes.includes('/hello/{name}')));
  assert.ok(first.middleware.some(item=>item.source==='middleware/auth.mjs'&&item.export==='bearer'&&item.routes.includes('/api/private')));
  assert.equal(first.targets['self-hosted'].compatible,true);assert.equal(first.targets.cloudflare.compatible,false);
  assert.deepEqual(first.recipes,[]);assert.deepEqual(first.external.egress,{proxy:[],signals:[]});
  const protectedProject=await buildManifest(extensions);
  assert.deepEqual(protectedProject.extensions,{auth:{version:'1',configKeys:[],mounts:[],protectedRoutes:['/account']},demo:{version:'1',configKeys:['label'],mounts:['/demo/*'],protectedRoutes:['/private']}});
  assert.deepEqual(protectedProject.external.extensions,['auth','demo']);
  assert.deepEqual(protectedProject.routes.find(route=>route.path==='/account')?.extensions,{auth:{role:'member'}});
});
test('the manifest lists external requirements by name and recipe provenance from recipe.yaml, never values',async t=>{
  const root=await project(t,{'/p':{proxy:{url:'https://api.example.test/v1'},secrets:{TOKEN:{secret:'API_TOKEN'}},env:{REGION:{env:'REGION'}}},'/s':{...redirect(),signals:[{url:'https://hooks.example.test/a'}]}},{'recipe.yaml':'id: webhook-relay\ndescription: Relay\nextra: ignored\n','.env.local':'API_TOKEN=leaked\n'});
  const manifest=await buildManifest(root);
  assert.deepEqual(manifest.external,{env:['REGION'],secrets:['API_TOKEN'],egress:{proxy:['https://api.example.test'],signals:['https://hooks.example.test']},extensions:[]});
  assert.deepEqual(manifest.recipes,[{id:'webhook-relay',description:'Relay'}]);
  assert.equal(renderManifest(manifest).includes('leaked'),false);
  await writeFile(join(root,'recipe.yaml'),'id: "../bad"\n');assert.deepEqual((await buildManifest(root)).recipes,[]);
});
// #199: the manifest records the execution mode per route, not inside the
// `function` handler record, so a native handler with middleware carries it too
// and flipping `sandbox` changes the route's bytes.
test('the manifest records each route\'s execution mode at route level',async t=>{
  const files={'mw.mjs':'export default (request, context, next) => next();\n','fn.mjs':'export const handle = () => new Response("ok");\n'};
  const routes={'/native':{middleware:[{source:'mw.mjs'}],respond:{text:'ok'}},'/fn':{function:{source:'fn.mjs',export:'handle'}},'/plain':redirect()};
  const sandbox=(extra:object)=>Object.fromEntries(Object.entries(routes).map(([path,route])=>[path,path==='/plain'?route:{...route,...extra}]));
  const sandboxed=await buildManifest(await project(t,sandbox({sandbox:true,sandboxReason:'Untrusted payload; isolate it.'}),files));
  const trusted=await buildManifest(await project(t,sandbox({sandbox:false,sandboxReason:'Untrusted payload; isolate it.'}),files));
  const route=(manifest:Awaited<ReturnType<typeof buildManifest>>,path:string)=>manifest.routes.find(item=>item.path===path)!;
  for(const path of ['/native','/fn']){
    assert.equal(route(sandboxed,path).sandbox,true,path);
    assert.equal(route(sandboxed,path).sandboxReason,'Untrusted payload; isolate it.',path);
    assert.equal(route(trusted,path).sandbox,false,path);
    // The flip alone has to change the route record, not only the project digest.
    assert.notEqual(JSON.stringify(route(sandboxed,path)),JSON.stringify(route(trusted,path)),path);
  }
  // Reported for every route, including one that runs no project code, and never on the handler.
  assert.equal(route(trusted,'/plain').sandbox,false);
  assert.equal(route(trusted,'/plain').sandboxReason,undefined);
  assert.equal(route(trusted,'/fn').handler.sandbox,undefined);
});
test('build writes manifest.json beside the artifact and the CLI prints the same bytes',async t=>{
  const root=await project(t,{'/go':redirect(),'/moved':{redirect:{url:'https://example.com/new',status:308}}});
  const out=await mkdtemp(join(tmpdir(),'urlcode-manifest-'));t.after(()=>rm(out,{recursive:true,force:true}));
  const report=await buildCloudflare(root,{out});
  assert.equal(report.manifest,join(out,'manifest.json'));
  const written=await readFile(join(out,'manifest.json'),'utf8');
  assert.equal(written,renderManifest(await buildManifest(root)));
  const printed=spawnSync(process.execPath,[cli,'manifest','--project',root,'--json'],{encoding:'utf8',timeout:60000});
  assert.equal(printed.status,0);assert.equal(printed.stdout,written);
  const summary=spawnSync(process.execPath,[cli,'manifest','--project',root],{encoding:'utf8',timeout:60000});
  assert.equal(summary.status,0);assert.ok(summary.stdout.startsWith(`revision: ${(JSON.parse(written) as {revision:string}).revision}`));
});
test('MCP offers get_manifest as a read-only tool',async t=>{
  const root=await project(t,{'/a':redirect()});let text='';
  const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
  const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_manifest',arguments:{}}}];
  await serveMcp({project:root,input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output});
  const replies=text.trim().split('\n').map(line=>JSON.parse(line) as {result:{tools?:{name:string;annotations:{readOnlyHint:boolean}}[];content?:{text:string}[]}});
  const tool=replies[1]!.result.tools!.find(item=>item.name==='get_manifest');assert.ok(tool);assert.equal(tool.annotations.readOnlyHint,true);
  const manifest=JSON.parse(replies[2]!.result.content![0]!.text) as {revision:string;routes:{path:string}[]};
  assert.equal(manifest.revision,await inspectExtensionRevision(root));assert.deepEqual(manifest.routes.map(route=>route.path),['/a']);
});
