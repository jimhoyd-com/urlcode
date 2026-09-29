import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {artifactSite,project,redirect} from './helpers.ts';
import {planFeature,featurePlanMaxBytes,featurePlanMaxGoalLength} from '../packages/core/src/feature-plan.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';
import {isAuthoringGoals} from '../packages/core/src/addon-manifest.ts';

function extension(name:'auth'|'store',targets:RuntimeExtension['targets']=['node']):RuntimeExtension {
 return {name,version:'1',projectSha256:'0'.repeat(64),targets,schema:{type:'object'},activate(){throw new Error('planning must not activate an extension');}};
}

test('feature planning is a bounded read-only projection of current contracts',async t=>{
 const root=await project(t,{'/old':redirect()},{'f.mjs':'throw new Error("guest code must not run")'},{extensions:{auth:{version:'1',config:{}},store:{version:'1',config:{}}}});
 const plan=await planFeature(root,'authenticated contact form with persisted submissions',{extensions:[extension('auth'),extension('store')]});
 assert.deepEqual(plan.extensions.required.map(item=>item.name),['auth','store']);
 assert.ok(plan.extensions.required.every(item=>item.registered));
 assert.ok(plan.applicable.recipes.some(recipe=>recipe.name==='contact-form'));
 assert.ok(plan.applicable.recipes.some(recipe=>recipe.name==='authenticated-json-api'));
 assert.ok(plan.applicable.recipes.some(recipe=>recipe.name==='store-crud'));
 assert.match(plan.extensions.ordering.note,/operator/i);
 assert.ok(Buffer.byteLength(JSON.stringify(plan))<=featurePlanMaxBytes);
});

test('feature planning marks unavailable targets and unsupported workflow requirements without inventing a capability',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,'multi-step idempotent persisted form workflow',{target:'cloudflare',extensions:[extension('store')]});
 assert.ok(plan.unsupported.some(item=>item.requirement==='Declarative form flow'));
 assert.ok(plan.unsupported.some(item=>item.requirement==='Idempotent mutation'));
 assert.ok(plan.unsupported.some(item=>/store extension on cloudflare/.test(item.requirement)));
 assert.ok(plan.extensions.required.find(item=>item.name==='store')?.target==='refused');
});

test('without a host file, feature planning refuses a target the extension\'s release descriptor does not declare (#859)',async t=>{
 const root=await project(t,{});
 const aws=await planFeature(root,'durable persisted record',{target:'aws'});
 const store=aws.extensions.required.find(item=>item.name==='store')!;
 assert.deepEqual([store.registered,store.target],[false,'refused'],'the store declares only node');
 assert.ok(aws.unsupported.some(item=>item.requirement==='store extension on aws'&&/release descriptor/.test(item.reason)));
 assert.ok(aws.applicable.recipes.some(recipe=>recipe.name==='store-crud'));
 // The descriptor can refuse but never confirm: on node the answer still waits for the pinned registration.
 const node=await planFeature(root,'durable persisted record');
 assert.equal(node.extensions.required.find(item=>item.name==='store')!.target,'unknown');
});

test('feature planning reports an artifact installed in the site around the project, and only a pinned one as installed',async t=>{
 const {site,project:app}=await artifactSite(t,'store');
 assert.equal((await planFeature(app,'durable persisted record')).extensions.required.find(item=>item.name==='store')?.artifact,'installed');
 // Drift from the core pin is reported, never trusted.
 await writeFile(join(site,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));
 assert.equal((await planFeature(app,'durable persisted record')).extensions.required.find(item=>item.name==='store')?.artifact,'unpinned');
 // A project outside any site has none.
 assert.equal((await planFeature(await project(t,{}),'durable persisted record')).extensions.required.find(item=>item.name==='store')?.artifact,'none');
});

test('feature planning steers a simple JSON endpoint to respond plus request.body.POST.schema, with matched terms and an outline (#587)',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,'POST /signup validates email and name and returns 202');
 assert.equal(plan.applicable.recipes[0]?.name,'json-endpoint');
 assert.ok(plan.applicable.recipes.every(recipe=>recipe.matched.length>0),'every listed recipe says which goal terms it answers');
 assert.ok(!plan.applicable.capabilities.some(item=>item.name==='function'),'no recipe steers this goal to function code');
 assert.ok(plan.applicable.capabilities.some(item=>item.name==='respond')&&plan.applicable.capabilities.some(item=>item.name==='request.body'));
 assert.equal(plan.outline.length,plan.applicable.recipes.length);
 assert.match(plan.outline[0]!.note,/request\.body\.POST\.schema/);assert.match(plan.outline[0]!.note,/respond/);
 assert.ok(!plan.extensions.required.some(item=>item.name==='auth'));
});

test('feature planning for a signed webhook names secret bindings and trusted node:crypto, never the sandbox or auth (#586)',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,'verify an HMAC-signed webhook');
 assert.equal(plan.applicable.recipes[0]?.name,'webhook-receiver');
 assert.ok(plan.applicable.recipes[0]!.matched.includes('hmac')&&plan.applicable.recipes[0]!.matched.includes('webhook'));
 const signature=plan.applicationCode.find(item=>item.requirement==='Signature verification');
 assert.ok(signature);assert.match(signature!.reason,/node:crypto/);assert.match(signature!.reason,/secret/);assert.match(signature!.reason,/trusted/);
 assert.ok(!plan.extensions.required.some(item=>item.name==='auth'),'signed is not sign-in');
 assert.ok(!plan.applicable.recipes.some(recipe=>recipe.name==='authenticated-json-api'));
});

test('feature planning bounds adversarial goal text before any output is constructed',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,`${'contact '.repeat(60)}`);
 assert.equal(plan.goalTerms.length,1);
 assert.ok(Buffer.byteLength(JSON.stringify(plan))<=featurePlanMaxBytes);
 await assert.rejects(planFeature(root,'x'.repeat(featurePlanMaxGoalLength+1)),/Feature goal/);
});

test('feature planning maps list, filter, sort and paging goals to store filterable/sortable and query parameters, not a tag match on one word (#834)',async t=>{
 const root=await project(t,{});
 for(const goal of ['let an owner filter their request list by status','sort requests by date','paginate the orders list']){
  const plan=await planFeature(root,goal);
  assert.deepEqual(plan.applicable.recipes.map(recipe=>recipe.name),['store-crud'],goal);
  assert.ok(plan.applicable.capabilities.some(item=>item.name==='parameters'),goal);
  assert.ok(plan.extensions.required.some(item=>item.name==='store'),goal);
  const query=plan.outline.find(item=>item.kind==='declarative list query');
  assert.ok(query,goal);
  for(const word of ['filterable','sortable','cursor','parameters'])assert.match(query!.note,new RegExp(word),`${goal}: ${word}`);
  assert.deepEqual(plan.applicationCode,[],`${goal}: a declared list query needs no application code`);
 }
 // An owner's own list is per-principal ownership, so it needs the principal-providing auth extension too.
 assert.deepEqual((await planFeature(root,'let an owner filter their request list by status')).extensions.required.map(item=>item.name),['auth','store']);
 // The tag fallback needs more than one shared word: "status" alone is not a health goal, a real health goal still is.
 assert.deepEqual((await planFeature(root,'show the service status')).applicable.recipes,[]);
 assert.equal((await planFeature(root,'health status page')).applicable.recipes[0]?.name,'health-page');
});

// #913: planning reads the authoring surfaces extensions publish, from the catalog before anything is installed.
test('feature planning names the store ownership and auth surfaces for a signed-in user\'s own records (#913)',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,'Let signed-in users create, list, edit and delete their own private notes via a JSON API');
 assert.deepEqual(plan.extensions.required.map(item=>item.name),['auth','store']);
 const surfaces=plan.extensions.surfaces.map(item=>`${item.extension}/${item.surface}`);
 for(const surface of ['auth/route protection','store/collections','store/ownership'])assert.ok(surfaces.includes(surface),surface);
 assert.ok(plan.extensions.surfaces.every(item=>item.source==='catalog'&&item.matched.length>0));
 assert.ok(plan.extensions.surfaces.find(item=>item.surface==='ownership')!.matched.includes('own'));
 assert.equal(plan.applicable.recipes[0]?.name,'store-crud');
 assert.match(plan.outline.find(item=>item.kind==='store ownership')!.note,/ownership: owner/);
 assert.deepEqual(plan.applicationCode,[]);
});

test('feature planning maps an approval goal to store transitions, membership and readers behind auth (#913)',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,'Owners submit requests; reviewers approve or reject pending requests',{extensions:[extension('store'),extension('auth')]});
 assert.deepEqual(plan.extensions.required.map(item=>item.name),['auth','store']);
 const surfaces=plan.extensions.surfaces.map(item=>`${item.extension}/${item.surface}`);
 for(const surface of ['auth/route protection','store/ownership','store/transitions','store/membership','store/readers'])assert.ok(surfaces.includes(surface),surface);
 assert.ok(plan.extensions.surfaces.find(item=>item.surface==='transitions')!.matched.includes('approve'));
 assert.match(plan.outline.find(item=>item.kind==='store transitions')!.note,/by: others/);
 assert.match(plan.outline.find(item=>item.kind==='store readers')!.note,/readers: \{mount, members/);
 assert.equal(plan.applicable.recipes[0]?.name,'store-crud');
 assert.ok(!plan.applicable.recipes.some(recipe=>recipe.name==='contact-form'),'one generic word is not a contact form');
});

test('a registered extension\'s own authoring goals take precedence over the catalog, and malformed goals are refused (#913)',async t=>{
 const root=await project(t,{});
 const store:RuntimeExtension={...extension('store'),authoring:{description:'Custom store.',surfaces:[{kind:'configuration',name:'ledger',description:'A ledger surface.',goals:['ledger']}]}};
 const plan=await planFeature(root,'keep a ledger of payments',{extensions:[store]});
 assert.deepEqual(plan.extensions.surfaces,[{extension:'store',surface:'ledger',kind:'configuration',source:'registered',matched:['ledger']}]);
 assert.ok(plan.extensions.required.some(item=>item.name==='store'&&item.registered));
 assert.equal(isAuthoringGoals(['approve','per-user']),true);
 for(const bad of [['Approve'],['two words'],['x'.repeat(33)],['a','a'],Array.from({length:33},(_,index)=>`g${index}`),'approve'])assert.equal(isAuthoringGoals(bad),false,JSON.stringify(bad));
});
