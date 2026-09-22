import test from 'node:test';
import assert from 'node:assert/strict';
import {project,redirect} from './helpers.ts';
import {planFeature,featurePlanMaxBytes,featurePlanMaxGoalLength} from '../packages/core/src/feature-plan.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {cachePath,extractArtifact,writeLock} from '../packages/core/src/extension-artifacts.ts';

function extension(name:'ui'|'auth'|'store'|'forms',targets:RuntimeExtension['targets']=['node']):RuntimeExtension {
 return {name,version:'1',projectSha256:'0'.repeat(64),targets,schema:{type:'object'},activate(){throw new Error('planning must not activate an extension');}};
}
function tar(files:Record<string,string>):Buffer {const pieces:Buffer[]=[];for(const [path,text] of Object.entries(files)){const body=Buffer.from(text),header=Buffer.alloc(512);header.write(path);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;header.fill(32,148,156);header.write([...header].reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148);pieces.push(header,body,Buffer.alloc((512-body.length%512)%512));}pieces.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(pieces));}

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

test('feature planning reports only a verified locked artifact for a required extension',async t=>{
 const root=await project(t,{}),archive=tar({'extension.json':JSON.stringify({format:1,kind:'declarative',name:'store',version:'1.0.0'}),'schemas/config.json':JSON.stringify({type:'object'})}),sha256=createHash('sha256').update(archive).digest('hex');
 const entry={name:'store',version:'1.0.0',asset:'store-1.0.0.tgz',sha256,kind:'declarative' as const};
 await extractArtifact(archive,entry,cachePath(root,sha256));await writeLock(root,{format:1,artifacts:[{...entry,catalog:{tag:'extensions@v1.0.0',commit:'a'.repeat(40)}}]});
 const plan=await planFeature(root,'durable persisted record');
 assert.equal(plan.extensions.required.find(item=>item.name==='store')?.artifact,'cached');
});

test('feature planning bounds adversarial goal text before any output is constructed',async t=>{
 const root=await project(t,{});
 const plan=await planFeature(root,`${'contact '.repeat(60)}`);
 assert.equal(plan.goalTerms.length,1);
 assert.ok(Buffer.byteLength(JSON.stringify(plan))<=featurePlanMaxBytes);
 await assert.rejects(planFeature(root,'x'.repeat(featurePlanMaxGoalLength+1)),/Feature goal/);
});
