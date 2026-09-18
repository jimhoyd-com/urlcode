import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';
import {inspectProject,validateProject,explainRoute,previewImport,previewExport,listRecipes,showRecipe,searchRecipes,searchExamples} from '../src/tooling.ts';
import {project,redirect,param} from './helpers.ts';
test('tooling validates without executing function bodies or reading credential values',async t=>{
 const root=await project(t,{'/f':{function:{source:'f.mjs'},secrets:{KEY:{secret:'NEVER_READ_THIS_BINDING'}}},'/go':redirect()},{'f.mjs':'while(true){}; export default () => new Response("never");','.env.local':'broken dotenv secret-content'});
 const report=await inspectProject(root);assert.equal(report.routeCount,2);assert.equal(JSON.stringify(report).includes('NEVER_READ'),false);assert.equal(JSON.stringify(report).includes('secret-content'),false);assert.equal((await validateProject(root)).valid,true);
});
test('tooling uses semantic compiler and explains without activation',async t=>{
 const root=await project(t,{'/item/{id}':{...redirect(),parameters:[param('id')]},'/item/a':redirect()});
 const exact=await explainRoute(root,'/item/a'),dynamic=await explainRoute(root,'/item/b');assert.ok(exact.matched&&exact.path==='/item/a');assert.ok(dynamic.matched&&dynamic.path==='/item/{id}');assert.equal((await explainRoute(root,'/missing')).matched,false);
 const bad=await project(t,{'/{id}':redirect()});await assert.rejects(validateProject(bad));await assert.rejects(inspectProject(root,{limit:1001}));
});
test('tooling exposes conversion previews and fixed local recipe catalog',async t=>{
 const root=await project(t,{'/a':redirect('https://example.com')});assert.equal((await previewExport(root,'json')).ok,true);assert.equal((await previewImport({format:'json',text:'[{"path":"/a","url":"https://example.com"}]'})).ok,true);
 assert.ok((await listRecipes()).length);assert.equal((await showRecipe('redirect')).name,'redirect');await assert.rejects(showRecipe('../outside'));
 assert.equal((await searchRecipes('redirect')).results[0]!.id,'redirect');assert.equal((await searchExamples('lambda')).best!.id,'aws');
});
test('export previews flatten includes without discarding project behavior',async t=>{
 const included='version: "1"\nroutes:\n  /included:\n    redirect: {url: "https://example.test/included"}\n';
 const root=await project(t,{'/root':redirect('https://example.test/root')},{'routes.yaml':included},{includes:['routes.yaml']});
 const report=await previewExport(root,'json');assert.equal(report.ok,true);assert.equal(report.routeCount,2);assert.ok(report.output?.includes('/included'));
 const governed=await project(t,{'/root':redirect('https://example.test/root')},{'routes.yaml':included},{includes:['routes.yaml'],policies:{cache:{strategy:'no-store'}}});
 const refused=await previewExport(governed,'json');assert.equal(refused.ok,false);assert.equal(refused.output,undefined);
});

test('read-only inspection compiles egress declarations and example without grants or networking',async t=>{
 const root=await project(t,{'/':{proxy:{url:'https://example.com'},signals:[{url:'https://example.com/hook'}]}});
 assert.equal((await inspectProject(root)).routeCount,1);
 const example=fileURLToPath(new URL('../examples/egress/',import.meta.url));assert.equal((await inspectProject(example)).routeCount,2);
});
test('large inspection pages bound compatibility output while retaining global verdict and counts',async t=>{
 const routes={...Object.fromEntries(Array.from({length:1500},(_,i)=>[`/redirect-${i}`,redirect()])),...Object.fromEntries(Array.from({length:1500},(_,i)=>[`/proxy-${i}`,{proxy:{url:'https://example.com'}}]))};
 const root=await project(t,routes);
 const first=await inspectProject(root,{target:'cloudflare',limit:1});
 assert.equal(first.routeCount,3000);assert.equal(first.routes[0]?.path,'/redirect-0');assert.equal(first.compatibility.compatible,false);assert.equal(first.compatibility.issueCount,1500);assert.ok(first.compatibility.requirementCount>=9000);assert.equal(first.compatibility.issues[0]?.path,'/proxy-0');assert.equal(first.compatibility.hasMore,true);assert.equal(Object.hasOwn(first.compatibility,'requirements'),false);assert.ok(Buffer.byteLength(JSON.stringify(first))<4096);
 const beyond=await inspectProject(root,{target:'cloudflare',offset:1500,limit:1});assert.equal(beyond.routes[0]?.path,'/proxy-0');assert.deepEqual(beyond.compatibility.issues,[]);assert.equal(beyond.compatibility.compatible,false);assert.equal(beyond.compatibility.issueCount,1500);assert.equal(beyond.compatibility.hasMore,false);assert.ok(Buffer.byteLength(JSON.stringify(beyond))<4096);
 const verdict=await validateProject(root,{target:'cloudflare',offset:1500,limit:1000});assert.equal(verdict.compatibility.firstIssue?.path,'/proxy-0');assert.equal(verdict.compatibility.compatible,false);assert.equal(verdict.compatibility.issueCount,1500);assert.equal(Object.hasOwn(verdict.compatibility,'issues'),false);assert.ok(Buffer.byteLength(JSON.stringify(verdict))<4096);
});
