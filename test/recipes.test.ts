import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,lstat,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {listRecipes,searchRecipes,showRecipe,addRecipe,recipeNames} from '../packages/core/src/recipes.ts';
import {listExamples,searchExamples,buildRouteIndex,readRouteIndex,addExample} from '../packages/core/src/examples.ts';
import {getExample} from '../packages/core/src/agent-context.ts';
import {searchMetadata,deriveMetadata,derivedDifferences,commandProblems} from '../packages/core/src/catalog.ts';
import {buildTypeScriptProject} from '../packages/core/src/typescript-authoring.ts';
import {startServer} from '../packages/core/src/server.ts';
import {runProjectTests} from '../packages/core/src/project-tests.ts';
import {auditProject} from '../packages/core/src/readiness.ts';
import {loadDocument} from '../packages/core/src/config.ts';
import {prepareFunctionSnapshot,requestedPermissions} from '../packages/core/src/policy.ts';
import {project,request} from './helpers.ts';
import {readmeHost} from './spa-shell-host.ts';
import {declaredExtensionTargets,parseAddonCatalog} from '../packages/core/src/addon-manifest.ts';
import {capabilityTargets} from '../packages/core/src/capabilities.ts';
import {addonCatalog} from '../scripts/build-addon-manifest.ts';
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
// Every extension's declared targets, read from the committed urlcode.json descriptors as `npm run check` reads them.
const declared=declaredExtensionTargets(parseAddonCatalog(JSON.parse(await addonCatalog()),'committed add-on descriptors'));

test('local recipe catalog is defensive and rejects arbitrary paths',async()=>{
  const catalog=await listRecipes();assert.equal(catalog.length,recipeNames.length);catalog[0]!.files.push('mutated');
  assert.ok(!(await listRecipes())[0]!.files.includes('mutated'));
  for(const name of ['../redirect','unknown','https://example.com/recipe','recipe.yaml'])await assert.rejects(showRecipe(name),/Unknown/);
  for(const recipe of catalog){assert.equal(recipe.name,recipe.id);assert.ok(recipe.files.includes('urlcode.yaml'));assert.ok(recipe.behavior!.length);assert.ok(recipe.tests!.commands.length);}
});

test('the typescript recipe states the optional compiler install before its first build, as the runtime prints it (#785)',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {devDependencies:{typescript:string};peerDependenciesMeta:{typescript:{optional:boolean}}};
  const install=`npm install --save-dev --save-exact typescript@${manifest.devDependencies.typescript}`;
  assert.equal(manifest.peerDependenciesMeta.typescript.optional,true);
  const diagnostic=await readFile(new URL('../packages/core/src/typescript-authoring.ts',import.meta.url),'utf8');
  assert.ok(diagnostic.includes(`(${install})`),'the missing-compiler diagnostic prints the same install command');
  const commands=(await showRecipe('typescript')).tests!.commands;
  assert.equal(commands[0],install);
  assert.ok(commands.findIndex(command=>command.includes('build-typescript'))>0);
  const readme=await readFile(new URL('../recipes/typescript/README.md',import.meta.url),'utf8');
  assert.ok(readme.includes(install)&&readme.indexOf(install)<readme.indexOf('urlcode build-typescript --project'));
});

test('recipe metadata is what the capability preflight derives, not a hand-written claim',async()=>{
  for(const recipe of await listRecipes()){
    const root=fileURLToPath(new URL('../recipes/'+recipe.id+'/',import.meta.url));
    assert.deepEqual(derivedDifferences(recipe,await deriveMetadata(root,declared)),[],recipe.id);
  }
  // A drifted target verdict or capability list is named, so the check script can point at it.
  const health=(await listRecipes()).find(recipe=>recipe.id==='health-page')!;
  const drifted={...health,capabilities:['function'],targets:{...health.targets!,cloudflare:'refused' as const},routes:3};
  const problems=derivedDifferences(drifted,await deriveMetadata(fileURLToPath(new URL('../recipes/health-page/',import.meta.url)),declared));
  assert.equal(problems.length,3);assert.match(problems[1]!,/targets.cloudflare should be compatible/);
});

test('no recipe claims a target that one of its extensions refuses (#859)',async()=>{
  const runtimeTarget=(target:string)=>target==='self-hosted'?'node':target;
  let checked=0;
  for(const recipe of await listRecipes()){
    const {document}=await loadDocument(fileURLToPath(new URL('../recipes/'+recipe.id+'/',import.meta.url)));
    const used=new Set([...Object.keys(document.extensions??{}),...Object.values(document.routes??{}).flatMap(route=>route.extension?[route.extension]:[])]);
    for(const name of used){
      const targets=declared.get(name);
      assert.ok(targets,`${recipe.id} uses ${name}, which no committed descriptor declares`);
      for(const target of capabilityTargets)if(!targets.includes(runtimeTarget(target) as never)){
        assert.equal(recipe.targets![target],'refused',`${recipe.id} claims ${target}: ${recipe.targets![target]}, but ${name} declares only ${targets.join(', ')}`);checked++;
      }
    }
  }
  assert.ok(checked>0,'at least one recipe uses an extension');
  // The preflight is what makes this so: the store's declared ['node'] refuses aws and vercel, and a wider declaration would not.
  const root=fileURLToPath(new URL('../recipes/store-crud/',import.meta.url));
  const store=await deriveMetadata(root,declared);
  assert.deepEqual([store.targets.aws,store.targets.vercel,store.targets['self-hosted']],['refused','refused','conditional']);
  const wider=await deriveMetadata(root,new Map([['store',['node','aws','vercel']]]));
  assert.deepEqual([wider.targets.aws,wider.targets.vercel],['conditional','conditional']);
});

test('every recipe is found first by the words someone would search for',async()=>{
  const queries: Record<typeof recipeNames[number],string>={
    redirect:'permanent redirect',                 'json-api':'echo json body',
    'json-endpoint':'json endpoint schema',
    typescript:'typescript',                       middleware:'tracing etag maintenance',
    'health-page':'health uptime probe',  'static-page':'hello world html page',
         'static-plus-api':'static site with api',
    'cors-api':'cors preflight',                   'webhook-receiver':'webhook',
    'contact-form':'contact form',                 'authenticated-json-api':'signed-in json api',
    'protected-download':'protected download attachment','store-crud':'crud store persist',
    'store-booking':'booking',                     'store-credits':'credits',
    'store-approval':'approval',
    'streaming-progress':'stream progress lines',
    'spa-shell':'single-page app deep link',
  };
  for(const [name,text] of Object.entries(queries)){
    const found=await searchRecipes(text);
    assert.equal(found.results[0]?.id,name,`${JSON.stringify(text)} should find ${name} first, found ${found.results.map(r=>r.id).join(',')}`);
    assert.deepEqual(found.results[0]!.matched.length,text.split(' ').filter(word=>word!=='with').length);
  }
  // Capabilities are searchable, every term must match, and the search is bounded.
  assert.ok((await searchRecipes('policies.extensions')).results.every(recipe=>recipe.capabilities!.includes('policies.extensions')));
  assert.equal((await searchRecipes('signals')).results.map(r=>r.id).join(),'contact-form');
  // Declarative first (#587): a recipe that runs no project code outranks an equal-scoring one that does.
  const json=(await searchRecipes('json endpoint')).results;
  assert.equal(json[0]!.id,'json-endpoint');
  const code=(recipe:{capabilities?:string[]})=>(recipe.capabilities??[]).some(name=>name==='function'||name==='middleware');
  for(const [index,hit] of json.entries())if(index>0&&hit.score===json[index-1]!.score)assert.ok(!code(json[index-1]!)||code(hit),`${hit.id} ranks after an equal-scoring code recipe`);
  assert.ok(!code((await searchRecipes('json')).results[0]!));
  assert.equal((await searchRecipes('redirect nonexistentword')).count,0);
  await assert.rejects(searchRecipes(''),/search words/);await assert.rejects(searchRecipes('x'.repeat(257)),/256/);
  assert.equal(searchMetadata([],'anything').length,0);
});

test('search and show run through the CLI with metadata before file contents',()=>{
  const run=(...args: string[])=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:20000});
  const search=run('recipes','search','webhook','--json');assert.equal(search.status,0);
  assert.equal((JSON.parse(search.stdout) as {results:{id:string}[]}).results[0]!.id,'webhook-receiver');
  const text=run('recipes','search','contact form');assert.equal(text.status,0);assert.match(text.stdout,/^contact-form/);
  const show=run('recipes','show','health-page');assert.equal(show.status,0);
  assert.ok(show.stdout.indexOf('targets:')<show.stdout.indexOf('--- urlcode.yaml'));assert.match(show.stdout,/grants|inputs:/);
  const shown=JSON.parse(run('recipes','show','health-page','--json').stdout) as {id:string;content:Record<string,string>};
  assert.equal(shown.id,'health-page');assert.ok(shown.content['urlcode.yaml']);
  assert.equal(run('recipes','search').status,1);assert.equal(run('recipes','frobnicate').status,1);
  const examples=run('examples','search','lambda','--json');assert.equal(examples.status,0);
  assert.equal((JSON.parse(examples.stdout) as {best:{id:string}}).best.id,'aws');
});

test('docs search returns bounded excerpts like MCP search_docs',()=>{
  const run=(...args: string[])=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:20000});
  const found=run('docs','search','function args','--json');assert.equal(found.status,0);
  const parsed=JSON.parse(found.stdout) as {results:{excerpt:string}[]};
  assert.ok(parsed.results.length>0&&parsed.results.length<=3);assert.ok(parsed.results.every(r=>r.excerpt.length<=1800));
  assert.match(run('docs','search','function args').stdout,/matched:/);
  assert.equal(run('docs','search').status,1);assert.equal(run('docs','frobnicate').status,1);
});

test('recipe add previews, creates ordinary files and refuses existing destinations',async t=>{
  const root=await project(t,{}),out=join(root,'recipe');
  const preview=await addRecipe('redirect',out,{dryRun:true});await assert.rejects(lstat(out),{code:'ENOENT'});
  const added=await addRecipe('redirect',out);assert.deepEqual(added.files,preview.files);
  const original=await readFile(join(out,'urlcode.yaml'),'utf8');await assert.rejects(addRecipe('json-api',out),/already exists/);
  assert.equal(await readFile(join(out,'urlcode.yaml'),'utf8'),original);
  const app=await startServer({project:out,port:0,log:()=>{}});t.after(()=>app.close());
  const reply=await request(app,'/docs?campaign=launch&private=ignored');assert.equal(reply.status,301);assert.equal(reply.headers.location,'https://example.com/documentation?campaign=launch');
});

test('every executable recipe works through the real runtime',async t=>{
  const root=await project(t,{});
  await addRecipe('json-api',join(root,'json'));const json=await startServer({project:join(root,'json'),port:0,log:()=>{}});t.after(()=>json.close());
  const reply=await request(json,'/echo',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"hello":"world"}'});
  assert.equal(reply.status,200);assert.deepEqual(JSON.parse(reply.body),{received:{hello:'world'}});
  assert.equal((await request(json,'/echo')).status,405);
  await addRecipe('typescript',join(root,'ts'));await buildTypeScriptProject(join(root,'ts'),join(root,'built'));
  const compiled=await startServer({project:join(root,'built'),port:0,log:()=>{}});t.after(()=>compiled.close());
  assert.equal((await request(compiled,'/hello')).status,200);
});

test('the middleware recipe serves every pattern and mirrors the cookbook modules',async t=>{
  const root=await project(t,{});await addRecipe('middleware',join(root,'mw'));
  const app=await startServer({project:join(root,'mw'),port:0,log:()=>{}});t.after(()=>app.close());
  assert.equal((await request(app,'/api/private')).status,401);
  assert.equal((await request(app,'/api/private',{headers:{authorization:'Bearer cookbook-token'}})).body,'{"private":true}');
  assert.equal((await request(app,'/admin/panel',{headers:{authorization:'Basic '+Buffer.from('admin:cookbook-password').toString('base64')}})).body,'Admin panel');
  const preflight=await request(app,'/cors/data',{method:'OPTIONS',headers:{origin:'https://app.example.com'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers['access-control-allow-origin'],'https://app.example.com');
  assert.equal((await request(app,'/traced',{headers:{'x-correlation-id':'abc'}})).headers['x-correlation-id'],'abc');
  assert.equal((await request(app,'/maintenance')).status,503);
  assert.deepEqual(JSON.parse((await request(app,'/fragile?fail=true',{headers:{'x-correlation-id':'r-9'}})).body),{error:'Temporarily unavailable',correlationId:'r-9'});
  assert.equal(JSON.parse((await request(app,'/api/items')).body).meta.count,2);
  assert.equal((await request(app,'/negotiated',{headers:{accept:'image/png'}})).status,406);
  assert.deepEqual(JSON.parse((await request(app,'/resource',{method:'POST',headers:{'x-http-method-override':'PATCH'}})).body),{method:'PATCH',tunneled:true});
  const versioned=await request(app,'/versioned');assert.match(versioned.headers.etag!,/^W\/"[0-9a-f]{8}"$/);
  assert.equal((await request(app,'/versioned',{headers:{'if-none-match':versioned.headers.etag!}})).status,304);
  assert.equal((await request(app,'/experiment',{headers:{cookie:'bucket=b'}})).headers.location,'https://example.com/landing-b');
  assert.equal((await request(app,'/welcome',{headers:{'accept-language':'de'}})).headers.location,'https://example.com/de/welcome');
  assert.equal((await request(app,'/downloads/report')).status,403);
  assert.equal((await request(app,'/profile',{method:'POST',headers:{'content-type':'application/json'},body:'{"name":""}'})).status,422);
  assert.equal((await request(app,'/inspect',{headers:{'x-debug':'1'}})).headers['content-type'],'application/json');
  // The recipe's modules are generated from the runnable cookbook (npm run docs:cookbook-index); they must not drift apart.
  const recipe=await showRecipe('middleware'),cookbook=fileURLToPath(new URL('../examples/cookbook/',import.meta.url));
  for(const file of recipe.files.filter(f=>f.startsWith('middleware/')||f.startsWith('functions/')))assert.equal(recipe.content[file],await readFile(join(cookbook,file),'utf8'),file);
});

async function policyFor(root: string) {const loaded=await loadDocument(root);return requestedPermissions(loaded,await prepareFunctionSnapshot(loaded));}

test('every recipe validates, passes its fixtures and audits with its declared route count',async t=>{
  const root=await project(t,{});
  // webhook-receiver's fixtures are signed with this key, supplied the way its README says: from the process.
  const previousSecret=process.env.WEBHOOK_SIGNING_SECRET;process.env.WEBHOOK_SIGNING_SECRET='recipe-test-secret';
  t.after(()=>{if(previousSecret===undefined)delete process.env.WEBHOOK_SIGNING_SECRET;else process.env.WEBHOOK_SIGNING_SECRET=previousSecret;});
  for(const recipe of await listRecipes()){
    // The auth and store recipes need the operator-installed @jimhoyd/urlcode-auth and -store; core cannot import them,
    // so packages/auth/test/recipes.test.ts and packages/store/test/recipes.test.ts run their fixtures, signed in
    // through the real auth extension (#1001).
    if(recipe.services?.some(service=>service.name==='store extension'||service.name==='auth extension'))continue;
    let out=join(root,recipe.id);await addRecipe(recipe.id,out);
    if(recipe.id==='typescript'){await buildTypeScriptProject(out,join(root,'typescript-built'));out=join(root,'typescript-built');}
    const options: Parameters<typeof runProjectTests>[1]={};
    if(recipe.capabilities!.includes('signals')||recipe.grants?.some(grant=>grant.kind==='secret'))options.permissions=await policyFor(out);
    // spa-shell's client routes need the operator plugin from its README host file (test/spa-shell-recipe.test.ts).
    if(recipe.id==='spa-shell')options.plugins=(await readmeHost(join(root,'spa-operator'))).default.plugins;
    assert.ok(recipe.services?.length?recipe.grants?.length:true,`${recipe.id} names a service, so it must name the grant that admits it`);
    const tested=await runProjectTests(out,options);
    if(recipe.tests?.fixtures)assert.ok(tested.total>0,`${recipe.id} declares fixtures`);
    assert.equal(tested.failed,0,`${recipe.id}: ${tested.failed} of ${tested.total} fixtures failed`);
    const app=await startServer({project:out,port:0,local:true,log:()=>{},...options});
    try{const report=await auditProject(app,{expectRoutes:recipe.routes});assert.equal(report.ready,true,`${recipe.id} audit: ${JSON.stringify({counts:report.counts,uncovered:report.uncovered,failed:report.failed})}`);}
    finally{await app.close();}
  }
});

test('the webhook recipe verifies an HMAC signature on a trusted route with a granted secret, never by sandboxing it (#586)',async t=>{
  const root=await project(t,{}),out=join(root,'hook');await addRecipe('webhook-receiver',out);
  const yaml=await readFile(join(out,'urlcode.yaml'),'utf8');
  assert.doesNotMatch(yaml,/^\s+sandbox: true/m);assert.match(yaml,/sandboxReason:/);assert.match(yaml,/\{secret: WEBHOOK_SIGNING_SECRET\}/);
  assert.match(await readFile(join(out,'functions/receive.mjs'),'utf8'),/from 'node:crypto'/);
  const permissions=await policyFor(out);
  assert.deepEqual(permissions.routes['/webhook']?.secrets,['WEBHOOK_SIGNING_SECRET']);
  await assert.rejects(startServer({project:out,port:0,log:()=>{},environment:{}}));
  const app=await startServer({project:out,port:0,log:()=>{},permissions,environment:{WEBHOOK_SIGNING_SECRET:'another-key'}});t.after(()=>app.close());
  const body='{"id":"evt_9"}',sign=(key:string)=>'sha256='+createHmac('sha256',key).update(body).digest('hex');
  const send=(signature:string)=>request(app,'/webhook',{method:'POST',headers:{'content-type':'application/json','x-webhook-event':'order.paid','x-webhook-signature':signature},body});
  const accepted=await send(sign('another-key'));assert.equal(accepted.status,202);assert.deepEqual(JSON.parse(accepted.body),{received:true,event:'order.paid',id:'evt_9'});
  assert.equal((await send(sign('recipe-test-secret'))).status,401);
});

test('examples carry the same metadata shape and search returns the smallest runnable match with its route',async t=>{
  const examples=await listExamples();assert.equal(examples.length,20);
  for(const example of examples){
    const root=fileURLToPath(new URL('../examples/'+example.id+'/',import.meta.url));
    if(example.runnable===false){assert.equal(example.capabilities,undefined);await assert.rejects(lstat(join(root,'urlcode.yaml')),{code:'ENOENT'});continue;}
    assert.deepEqual(derivedDifferences(example,await deriveMetadata(root,declared)),[],example.id);
  }
  const etag=await searchExamples('etag');assert.equal(etag.best!.id,'cookbook');assert.equal(etag.best!.route!.path,'/versioned');assert.equal(etag.best!.route!.file,'routes/middleware.yaml');
  const redirect=await searchExamples('redirect');assert.ok(redirect.count>1);
  assert.ok(redirect.results.every((result,index)=>index===0||result.runnable===false||(result.routes!>=redirect.results[index-1]!.routes!)),'smallest runnable example first');
  assert.equal(redirect.best!.id,redirect.results[0]!.id);
  const rules=await searchExamples('compliance rules');assert.equal(rules.results[0]!.id,'compliance');assert.equal(rules.best,null);
  assert.equal((await searchExamples('nothing-matches-this')).count,0);
  // The generated route index is derived from the loaded cookbook, one entry per route, and the committed file is current.
  const cookbook=fileURLToPath(new URL('../examples/cookbook',import.meta.url)),built=await buildRouteIndex(cookbook,'examples/cookbook');
  assert.equal(built.routes,40);assert.deepEqual(built,await readRouteIndex('cookbook'));
  assert.ok(built.entries.every(entry=>entry.tags.includes(entry.handler)));
  assert.ok(built.entries.filter(entry=>entry.file==='site').length===4);
  const small=await project(t,{'/a':{redirect:{url:'https://example.com/'},description:'Moved'},'/f':{function:{source:'f.mjs'},middleware:[{source:'m/trace.mjs'}]}});
  await mkdir(join(small,'m'));await writeFile(join(small,'f.mjs'),'export default ()=>new Response("x")');await writeFile(join(small,'m','trace.mjs'),'export default (r,c,n)=>n()');
  const index=await buildRouteIndex(small,'small');
  assert.deepEqual(index.entries.map(entry=>[entry.path,entry.file,entry.handler,entry.tags]),[['/a','urlcode.yaml','redirect',['redirect','get','head']],['/f','urlcode.yaml','function',['function','get','head','middleware','trace']]]);
});

test('example add copies a whole runnable example whose listed commands run from the copy (#789)',async t=>{
  const root=await project(t,{}),out=join(root,'assets');
  const preview=await addExample('assets',out,{dryRun:true});await assert.rejects(lstat(out),{code:'ENOENT'});
  const added=await addExample('assets',out);assert.deepEqual(added.files,preview.files);
  for(const file of ['urlcode.yaml','functions/hello.mjs','public/assets/example.txt','tests/requests.json','README.md','Makefile'])assert.ok(added.files.includes(file),file);
  assert.ok(!added.files.includes('example.yaml'));
  assert.deepEqual(added.omitted,['.env.example','.gitattributes','.gitignore']);
  await assert.rejects(addExample('assets',out),/already exists/);
  const tested=await runProjectTests(out,{});assert.ok(tested.total>0);assert.equal(tested.failed,0);
  const cookbook=await addExample('cookbook',join(root,'cookbook'));
  assert.ok(!cookbook.files.includes('route-index.json'));assert.ok(cookbook.files.includes('middleware/etag.mjs'));
  await assert.rejects(addExample('monitoring',join(root,'monitoring')),/not a runnable project/);
  await assert.rejects(addExample('../recipes/redirect',join(root,'escape')),/Unknown bundled example/);
});

test('every catalog command is written for the added directory, never the source checkout (#789)',async()=>{
  for(const entry of [...await listRecipes(),...await listExamples()])assert.deepEqual(commandProblems(entry),[],entry.id);
  const checkout={id:'x',description:'x',tags:['x'],complexity:'starter' as const,files:['urlcode.yaml']};
  for(const command of ['node packages/core/src/cli.ts test --project examples/x','urlcode test --project examples/x','DATA_DIR=./examples/x/data urlcode test --project .','urlcode audit --compliance-rules "$PWD/rules.mjs"','make test'])
    assert.equal(commandProblems({...checkout,tests:{commands:[command]}}).length>0,true,command);
  assert.deepEqual(commandProblems({...checkout,tests:{commands:['DATA_DIR=./data urlcode test --project . --policy /operator/p.json','node prerender.mjs . /operator/out','urlcode test --project ../hello-built','PROJECT_SHA256=<reviewed revision> urlcode test --project .']}}),[]);
  const example=await getExample('body-validation');assert.equal(example.add,'urlcode examples add body-validation --out body-validation');
  assert.deepEqual(Object.keys(example.content).sort(),['README.md','urlcode.yaml']);
  const monitoring=await getExample('monitoring');assert.equal('add' in monitoring,false);assert.equal(Object.keys(monitoring.content).length,4);
});
