import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {artifactSite,project,redirect} from './helpers.ts';
import {planFeature,featurePlanMaxBytes,featurePlanMaxGoalLength} from '../packages/core/src/feature-plan.ts';
import {shellWord} from '../packages/core/src/context.ts';
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
 // #1052 S6: the sign-in hint names the installed provider, not Better Auth, and the storage hint names the native path.
 const protectedNote=plan.outline.find(item=>item.kind==='protected endpoint')!.note;
 assert.match(protectedNote,/installed sign-in provider \(the bundled auth extension by default\)/);
 assert.doesNotMatch(protectedNote,/Better Auth/);
 assert.match(plan.outline.find(item=>item.kind==='durable collection')!.note,/trusted \(non-sandbox\) function that imports an ordinary npm database library/);
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
 assert.match(plan.outline.find(item=>item.kind==='store readers')!.note,/readers: \{<name>: \{mount, members/);
 assert.equal(plan.applicable.recipes[0]?.name,'store-approval');
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

// #932: one incidental goal word is not a requirement. "Notify the team" named the store's membership surface through
// "team" and made the store required; a surface needs two goal words, or its extension a stronger reason.
test('feature planning does not require an extension for one incidental word, and still plans booking and credits goals (#932)',async t=>{
 const root=await project(t,{});
 for(const goal of ['Notify the team','send the team a welcome email','move the old page to a new address','update the homepage copy']){
  const plan=await planFeature(root,goal);
  assert.ok(!plan.extensions.required.some(item=>item.name==='store'),`${goal}: ${JSON.stringify(plan.extensions.required)}`);
  assert.ok(!plan.extensions.surfaces.some(item=>item.extension==='store'),`${goal}: ${JSON.stringify(plan.extensions.surfaces)}`);
 }
 // A word that only happens to be a goal word still counts once the goal is about the extension.
 const booking=await planFeature(root,'Let users book a room');
 assert.equal(booking.applicable.recipes[0]?.name,'store-booking');
 assert.ok(booking.extensions.required.some(item=>item.name==='store'));
 assert.ok(booking.extensions.surfaces.some(item=>item.extension==='store'&&item.surface==='intervals'));
 assert.match(booking.outline.find(item=>item.kind==='declarative booking')!.note,/interval_conflict/);
 // #1014: the next step adds the extensions the project lacks, then merges the recipe into this project.
 assert.deepEqual(booking.commands,['urlcode extensions add auth store',`urlcode recipes add store-booking --project ${shellWord(root)}`]);
 assert.deepEqual((await planFeature(root,'Let users book a room',{projectFlag:'app'})).commands.at(-1),'urlcode recipes add store-booking --project app');
 assert.deepEqual((await planFeature(undefined,'Let users book a room')).commands,['urlcode init <directory> --with auth,store','urlcode recipes add store-booking --project <directory>/app']);
 assert.deepEqual((await planFeature(root,'update the homepage copy')).commands,[]);
 // The credits plan names the issuer pattern: a negative min with members.
 const credits=await planFeature(root,'Users hold credits in wallets and pay each other');
 assert.equal(credits.applicable.recipes[0]?.name,'store-credits');
 assert.ok(credits.extensions.required.some(item=>item.name==='store'));
 const note=credits.outline.find(item=>item.kind==='declarative credits')!.note;
 for(const phrase of [/issuer/,/negative min/,/members: <membership collection>/,/readOnlyProperties/])assert.match(note,phrase);
 assert.match(credits.outline.find(item=>item.kind==='store transfers')!.note,/issuer: a transfer with a negative `min`/);
 assert.deepEqual(credits.applicationCode,[]);
});

// #957: an approval goal shares "own", "submit", "approve" or "reviewers" with the store and auth surfaces, and every
// recipe built on those extensions inherits them. The workflow words are the store-approval recipe's own terms, so an
// approval goal gets that recipe, never the booking or credits recipe, which are offered only on their own terms.
test('feature planning offers the approval recipe for an approval goal, and booking and credits only on their own terms (#957)',async t=>{
 const root=await project(t,{});
 for(const goal of ['employees submit requests; reviewers approve or reject them; requesters see only their own','Owners submit requests; reviewers approve or reject pending requests']){
  const plan=await planFeature(root,goal,{extensions:[extension('store'),extension('auth')]});
  assert.deepEqual(plan.applicable.recipes.map(recipe=>recipe.name),['store-approval'],`${goal}: ${JSON.stringify(plan.applicable.recipes)}`);
  assert.ok(!plan.outline.some(item=>item.kind==='declarative booking'||item.kind==='declarative credits'),goal);
  const note=plan.outline.find(item=>item.kind==='declarative approval')!.note;
  for(const phrase of [/by: others/,/members: reviewers/,/editable: \{status: draft\}/,/record_locked/,/showOwner: true/])assert.match(note,phrase,goal);
  assert.deepEqual(plan.applicationCode,[],goal);
  assert.deepEqual(plan.extensions.required.map(item=>item.name),['auth','store'],goal);
  assert.ok(plan.extensions.surfaces.some(item=>item.surface==='transitions'),goal);
 }
 // Without the registrations too: the recipe's own terms select it, not the extensions' surfaces.
 for(const goal of ['a manager approves expense claims','submit a document for review']){
  assert.equal((await planFeature(root,goal)).applicable.recipes[0]?.name,'store-approval',goal);
 }
 for(const [goal,recipe] of [['Let users reserve a time slot','store-booking'],['schedule appointments without overlapping intervals','store-booking'],['Transfer a balance between wallets','store-credits'],['issue credits to users','store-credits']] as const){
  const plan=await planFeature(root,goal);
  assert.equal(plan.applicable.recipes[0]?.name,recipe,`${goal}: ${JSON.stringify(plan.applicable.recipes)}`);
 }
 // Tags shared across the catalog ("store", "auth", "extension") are not a tag match on their own.
 assert.ok(!(await planFeature(root,'a store auth extension')).applicable.recipes.some(recipe=>['store-booking','store-credits','store-approval'].includes(recipe.name)));
});

test('a goal that writes several stored records at once names the missing capability and the declarative and owner-choice paths (#1086)',async t=>{
 const root=await project(t,{});
 const gap=(plan:Awaited<ReturnType<typeof planFeature>>)=>plan.unsupported.find(item=>item.requirement==='Multi-record store write from application code');
 for(const goal of ['add a bulk action for the signed-in user to mark every one of their own todos as done in one request','update all of my stored records at once','batch archive items in the store']){
  const plan=await planFeature(root,goal),found=gap(plan);
  assert.ok(found,`${goal}: ${JSON.stringify(plan.unsupported)}`);
  assert.match(found.reason,/no request-bound capability for its collections \(https:\/\/github\.com\/jimhoyd-com\/urlcode\/blob\/v[^/]+\/docs\/EXTENSIONS\.md#request-bound-capabilities\)/);
  assert.match(found.reason,/transition \(POST <mount>\/<id>\/<name>\) changes one record per call/);
  assert.match(found.reason,/transfer \(POST <mount>\/transfers\/<name>\) moves an amount between two records/);
  assert.match(found.reason,/owner's choice: a trusted \(non-sandbox\) function over an independently owned database[^)]*\(reference: URLCode's proofs\/native-storage\)/);
  assert.ok(Buffer.byteLength(JSON.stringify(plan))<=featurePlanMaxBytes);
 }
 // Reading many records, or one record's write, is not a multi-record write.
 for(const goal of ['list all of my own todos newest first','let the owner mark a todo as done','durable persisted record'])assert.equal(gap(await planFeature(root,goal)),undefined,goal);
});

test('feature planning names the mcp extension for an MCP goal, and its mount states the authorization it does not provide (#1137)',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,'remote MCP server over HTTP with OAuth bearer authorization for agent clients');
 assert.deepEqual(plan.extensions.required.map(item=>item.name),['mcp']);
 assert.deepEqual(plan.extensions.surfaces.map(item=>`${item.extension}/${item.surface}`),['mcp/servers','mcp/mount']);
 const mount=plan.outline.find(item=>item.kind==='mcp mount')!.note;
 assert.match(mount,/non-browser MCP client \(no Origin header, or a bearer token\) is refused 403/);
 assert.match(mount,/receives the caller's verified principal as `context\.principal`/);
 assert.match(mount,/\(OAuth, bearer tokens\) is not implemented/);
 assert.deepEqual((await planFeature(root,'expose MCP tools')).extensions.required.map(item=>item.name),['mcp']);
 // "agents" and "server" are also words of a crawler policy goal: one shared word never requires the extension.
 for(const goal of ['block AI agents and crawlers on the server','give the team a status page'])assert.deepEqual((await planFeature(root,goal)).extensions.required,[],goal);
 // An accounts goal is told what the auth mount leaves out, and a storage goal what the bundled store is.
 const accounts=await planFeature(root,'user accounts with password login, sessions and logout');
 assert.match(accounts.outline.find(item=>item.kind==='auth mount')!.note,/owner's own Better Auth database, such as a Postgres pool.*No admin console, API keys, OAuth\/OIDC sign-in or email flows/);
 assert.match(accounts.outline.find(item=>item.kind==='auth route protection')!.note,/no bearer-token or API-key mode/);
 const storage=await planFeature(root,'durable database records');
 assert.match(storage.outline.find(item=>item.kind==='durable collection')!.note,/flat scalar records in one SQLite database served by one process/);
});
