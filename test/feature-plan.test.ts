import test from 'node:test';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {artifactSite,project,redirect} from './helpers.ts';
import {planFeature,featurePlanMaxBytes,featurePlanMaxGoalLength} from '../packages/core/src/feature-plan.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';

function extension(name:'ui'|'auth'|'store'|'forms',targets:RuntimeExtension['targets']=['node']):RuntimeExtension {
 return {name,version:'1',projectSha256:'0'.repeat(64),targets,schema:{type:'object'},activate(){throw new Error('planning must not activate an extension');}};
}

test('feature planning is a bounded read-only projection of current contracts',async t=>{
 const root=await project(t,{'/old':redirect()},{'f.mjs':'throw new Error("guest code must not run")'},{extensions:{ui:{version:'1',config:{}},auth:{version:'1',config:{}},store:{version:'1',config:{}}}});
 const plan=await planFeature(root,'authenticated contact form with persisted submissions',{extensions:[extension('ui'),extension('auth'),extension('store')]});
 assert.deepEqual(plan.extensions.required.map(item=>item.name),['auth','store','ui']);
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

test('feature planning discovers forms only from an already-loaded registration',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,'multi-step contact form workflow',{extensions:[extension('forms')]});
 assert.ok(plan.extensions.required.some(item=>item.name==='forms'&&item.registered));
 assert.ok(!plan.unsupported.some(item=>item.requirement==='Declarative form flow'));
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

test('feature planning steers a simple JSON endpoint to respond plus request.body.schema, with matched terms and an outline (#587)',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,'POST /signup validates email and name and returns 202');
 assert.equal(plan.applicable.recipes[0]?.name,'json-endpoint');
 assert.ok(plan.applicable.recipes.every(recipe=>recipe.matched.length>0),'every listed recipe says which goal terms it answers');
 assert.ok(!plan.applicable.capabilities.some(item=>item.name==='function'),'no recipe steers this goal to function code');
 assert.ok(plan.applicable.capabilities.some(item=>item.name==='respond')&&plan.applicable.capabilities.some(item=>item.name==='request.body'));
 assert.equal(plan.outline.length,plan.applicable.recipes.length);
 assert.match(plan.outline[0]!.note,/request\.body\.schema/);assert.match(plan.outline[0]!.note,/respond/);
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
