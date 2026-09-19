import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {explainRoute,explainProject} from '../src/tooling.ts';
import {createRuntime} from '../src/runtime.ts';
import {inspectExtensionRevision} from '../src/extensions.ts';
import type {RuntimeExtension} from '../src/extensions.ts';
import {project,redirect} from './helpers.ts';
const cookbook=fileURLToPath(new URL('../examples/cookbook/',import.meta.url));
const extensions=fileURLToPath(new URL('../examples/extensions/',import.meta.url));
const conditions=fileURLToPath(new URL('../examples/conditions/',import.meta.url));
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
const demo=async(root:string):Promise<RuntimeExtension>=>({name:'demo',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],
  schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},policySchema:{type:'object',properties:{role:{const:'member'}},required:['role'],additionalProperties:false},
  activate(){throw new Error('explain must not activate extensions');}});

test('explain describes a cookbook function route from the compiled IR',async()=>{
  const explanation=await explainRoute(cookbook,'/hello/world');
  assert.deepEqual(explanation,{
    matched:true,path:'/hello/{name}',description:'Validated input, named export, arguments, literal environment and middleware',state:'active',enabled:true,methods:['GET','HEAD'],conditional:false,
    handler:{kind:'function',source:'functions/hello.mjs',export:'hello',args:{name:{from:'path',name:'name'},excited:{from:'query',name:'excited'},greeting:{env:'GREETING'},punctuation:'!'},sandbox:false},
    middleware:[{source:'middleware/headers.mjs',export:'decorate'}],
    inputs:{parameters:[{name:'name',in:'path',required:true,schema:{type:'string',minLength:1,maxLength:80}},{name:'excited',in:'query',required:false,schema:{type:'boolean',default:false}}]},
    policies:{names:[],inventory:{},extensions:{}},
    cache:{outcome:'none',forcedNoStore:false,reason:'no cache policy or Cache-Control header is declared'},
    bindings:{env:{GREETING:{literal:true}},secrets:{}},egress:{},responseHeaders:[['x-app','cookbook']],
    capabilities:['function','middleware','parameters','methods','enabled','response.headers','bindings'],
    targets:{
      'self-hosted':{compatible:true,issues:[]},
      cloudflare:{compatible:false,issues:[{capability:'function',support:'refused',reason:'functions need the self-hosted Node lifecycle, whether trusted (in-process) or sandboxed (worker threads and the WASM engine)'},{capability:'middleware',support:'refused',reason:'middleware needs the self-hosted Node lifecycle, whether trusted (in-process) or sandboxed (worker threads and the WASM engine)'},{capability:'bindings',support:'refused',reason:'env and secret bindings would have to be baked into the artifact'}]},
      aws:{compatible:false,issues:[{capability:'function',support:'refused',reason:'functions need the self-hosted Node lifecycle, whether trusted (in-process) or sandboxed (worker threads and the WASM engine)'},{capability:'middleware',support:'refused',reason:'middleware needs the self-hosted Node lifecycle, whether trusted (in-process) or sandboxed (worker threads and the WASM engine)'}]},
      vercel:{compatible:false,issues:[{capability:'function',support:'refused',reason:'functions need the self-hosted Node lifecycle, whether trusted (in-process) or sandboxed (worker threads and the WASM engine)'},{capability:'middleware',support:'refused',reason:'middleware needs the self-hosted Node lifecycle, whether trusted (in-process) or sandboxed (worker threads and the WASM engine)'}]},
      static:{compatible:false,issues:[
        {capability:'function',support:'refused',reason:'no server, so no dynamic execution'},
        {capability:'middleware',support:'refused',reason:'no server, so no middleware execution'},
        {capability:'parameters',support:'refused',reason:'no server, so no request-time parameter validation'},
        {capability:'response.headers',support:'refused',reason:'no server, so response headers cannot be added per request; set them via S3 object metadata or a CloudFront response headers policy instead'},
        {capability:'bindings',support:'refused',reason:'no server, so env/secret bindings cannot be resolved per request'},
      ]},
    },
    note:'Derived from the compiled configuration; request conditions, parameter values and handler execution are not evaluated.',
  });
  const cached=await explainRoute(cookbook,'/cached');
  assert.ok(cached.matched);assert.deepEqual(cached.policies.names,['cache']);assert.equal(cached.cache.outcome,'public');assert.equal(cached.cache.cacheControl,'public, max-age=60');assert.equal(cached.policies.inventory.cache?.target,'native');
  const expired=await explainRoute(cookbook,'/expired');assert.ok(expired.matched);assert.equal(expired.state,'expired');assert.equal(expired.expires,'2020-01-01T00:00:00Z');
  const echo=await explainRoute(cookbook,'/echo');assert.ok(echo.matched);assert.deepEqual(echo.inputs.body,{required:true,maxBytes:4096,contentTypes:['application/json'],format:'json'});
});
test('explain reports the route\'s actual sandbox boolean, explicit either way',async()=>{
  const trusted=await explainRoute(cookbook,'/hello/world');
  assert.ok(trusted.matched);assert.equal(trusted.handler.kind,'function');assert.equal(trusted.handler.sandbox,false);
  assert.equal(trusted.handler.sandboxReason,undefined);
  const webhookReceiver=fileURLToPath(new URL('../recipes/webhook-receiver/',import.meta.url));
  const sandboxed=await explainRoute(webhookReceiver,'/webhook');
  assert.ok(sandboxed.matched);assert.equal(sandboxed.handler.kind,'function');assert.equal(sandboxed.handler.sandbox,true);
  assert.equal(sandboxed.handler.sandboxReason,'Third-party webhook payload; isolate parsing it even after body/content-type validation.');
});
test('explain describes an extension-protected route, with provider facts when a host registry is supplied',async()=>{
  const plain=await explainRoute(extensions,'/account');
  assert.ok(plain.matched);
  assert.deepEqual(plain.policies,{names:['extensions.auth'],inventory:{},extensions:{auth:{requirement:{role:'member'}}}});
  assert.deepEqual(plain.cache,{outcome:'no-store',cacheControl:'no-store',forcedNoStore:true,reason:'The runtime replaces every cache header on this extension-protected route with no-store'});
  assert.deepEqual(plain.capabilities,['policies.extensions','respond','methods','enabled']);
  // Without a resolved registration set, policies.extensions is conditional (not a false native), even on self-hosted.
  assert.equal(plain.targets.cloudflare.compatible,false);assert.equal(plain.targets['self-hosted'].compatible,false);
  assert.equal(plain.targets['self-hosted'].issues[0]?.support,'conditional');
  const registry=[await demo(extensions)];
  const withHost=await explainRoute(extensions,'/private',{extensions:registry});
  assert.ok(withHost.matched);
  assert.deepEqual(withHost.policies.extensions,{demo:{requirement:{role:'member'},provider:{registered:true,version:'1',targets:['node','aws','vercel'],revisionMatch:true,requirementValid:true}}});
  const stale=await explainRoute(extensions,'/private',{extensions:[{...registry[0]!,projectSha256:'0'.repeat(64)}]});
  assert.ok(stale.matched);assert.equal(stale.policies.extensions.demo?.provider?.revisionMatch,false);
  const account=await explainRoute(extensions,'/account',{extensions:registry});
  assert.ok(account.matched);assert.deepEqual(account.policies.extensions.auth?.provider,{registered:false});
  const mount=await explainRoute(extensions,'/demo/anything',{extensions:registry});
  assert.ok(mount.matched);assert.equal(mount.handler.kind,'extension');assert.equal(mount.handler.name,'demo');assert.equal((mount.handler.provider as {registered:boolean}).registered,true);assert.equal(mount.cache.forcedNoStore,true);
});
test('explain agrees with the runtime on methods and policies for every route',async t=>{
  for(const [root,options] of [[cookbook,{}],[conditions,{}],[extensions,{origin:'https://extensions.example.test'}]] as const){
    const registry=root===extensions?[{...await demo(root),activate(){return {handle(){return {status:200,headers:[],body:''};},authorize(){return undefined;}};}},{name:'auth',version:'1' as const,projectSha256:await inspectExtensionRevision(root),targets:['node' as const],schema:{type:'object'},policySchema:{type:'object'},activate(){return {handle(){return {status:200,headers:[],body:''};},authorize(){return undefined;}};}}]:undefined;
    const runtime=await createRuntime(root,{...options,...(registry?{extensions:registry}:{})});t.after(()=>runtime.close());
    const inventory=runtime.testPlan().inventory;
    const explained=await explainProject(root,{...(registry?{extensions:registry}:{})});
    assert.equal(explained.routes.length,inventory.length,root);
    for(const entry of inventory){
      const explanation=explained.routes.find(route=>route.path===entry.path);assert.ok(explanation,entry.path);
      assert.deepEqual(explanation.methods,entry.methods,entry.path);
      assert.deepEqual(explanation.policies.names,entry.policies,entry.path);
      assert.equal(explanation.state,entry.state,entry.path);
      assert.equal(explanation.handler.kind,entry.handler??'none',entry.path);
      assert.equal(explanation.middleware.length,entry.middleware,entry.path);
      const single=await explainRoute(root,entry.path.replace(/\/\*$/,'/probe'),{...(registry?{extensions:registry}:{})});
      assert.ok(single.matched&&single.path===entry.path,entry.path);
    }
  }
});
test('explain names nearest routes for a miss and never carries binding values',async t=>{
  const root=await project(t,{'/docs':redirect(),'/download':{...redirect(),secrets:{KEY:{secret:'NEVER_PRINT_VALUE'}},env:{A:{env:'AMBIENT'}}}},{'.env.local':'AMBIENT=leaked-value\nNEVER_PRINT_VALUE=leaked-secret\n'});
  const miss=await explainRoute(root,'/doc');
  assert.deepEqual(miss,{matched:false,nearest:['/docs','/download'],note:'No route selects this path.'});
  const hit=await explainRoute(root,'/download');assert.ok(hit.matched);
  assert.deepEqual(hit.bindings,{env:{A:{env:'AMBIENT'}},secrets:{KEY:{secret:'NEVER_PRINT_VALUE'}}});
  assert.equal(JSON.stringify(hit).includes('leaked'),false);
});
test('the explain CLI prints a project table, a route detail and exits 1 for an unknown route',()=>{
  const run=(...args:string[])=>spawnSync(process.execPath,[cli,...args,'--project',cookbook],{encoding:'utf8',timeout:60000});
  const all=run('explain');assert.equal(all.status,0);assert.match(all.stdout,/^route\s+methods\s+handler/);assert.ok(all.stdout.includes('/hello/{name}'));
  const one=run('explain','/cached');assert.equal(one.status,0);assert.ok(one.stdout.includes('cache: public (public, max-age=60)'));
  const json=run('explain','/cached','--json','--target','cloudflare');assert.equal(json.status,0);assert.equal((JSON.parse(json.stdout) as {path:string}).path,'/cached');
  const miss=run('explain','/cachd');assert.equal(miss.status,1);assert.ok(miss.stdout.includes('nearest: /cached'));
  const missJson=run('explain','/cachd','--json');assert.equal(missJson.status,1);assert.equal((JSON.parse(missJson.stdout) as {matched:boolean}).matched,false);
  assert.equal(run('explain','relative').status,1);
});
