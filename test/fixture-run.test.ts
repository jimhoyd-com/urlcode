import test from 'node:test';import assert from 'node:assert/strict';import {Readable,Writable} from 'node:stream';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {serveMcp} from '../packages/core/src/mcp.ts';import {reportedWithoutVerbose} from '../packages/core/src/fixture-run.ts';import {project,redirect,byReplyId} from './helpers.ts';

interface InProcess {total:number;failed:number;localReview?:unknown;events:Record<string,unknown>[]}
interface Child {exitCode:number;stdout:string;stderr:string;truncated:boolean}
/** One MCP session that calls run_tests (in-process) and then run_test (the `urlcode test` child) on the same project. */
async function bothRunners(root:string,hostFile?:string):Promise<{inProcess:InProcess;child:Child}> {
 const call=(id:number,name:string)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{}}});
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},call(2,'run_tests'),call(3,'run_test')];
 let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
 await serveMcp({project:root,...(hostFile===undefined?{}:{hostFile}),input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output,allowAuthoring:true});
 const replies=text.trim().split('\n').map(line=>JSON.parse(line) as {id:number;result:{content:{text:string}[]}}).sort(byReplyId);
 const payload=(id:number)=>JSON.parse(replies.find(reply=>reply.id===id)!.result.content[0]!.text) as unknown;
 return {inProcess:payload(2) as InProcess,child:payload(3) as Child};
}
const lines=(value:string)=>value.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);

// #1095: run_tests (in-process) and run_test (the `urlcode test` child) share one fixture-execution core, so one fixture
// outcome is one result: the same summary, the same failing case and the same local review, whichever tool reports it.
test('run_tests and run_test report the same fixture outcome from the one fixture core (#1095)',async t=>{
 const root=await project(t,{'/a':redirect()},{'tests/requests.json':JSON.stringify([{path:'/a',status:302},{path:'/a',status:200}])});
 const {inProcess,child}=await bothRunners(root);
 assert.deepEqual({total:inProcess.total,failed:inProcess.failed},{total:2,failed:1});
 assert.equal(child.exitCode,1,child.stderr);assert.equal(child.truncated,false);
 const printed=lines(child.stdout);
 // The CLI adapter prints the failing events and then the summary; run_tests returns every event, and the same filter
 // over them gives exactly what the child printed: the one failing case, byte for byte.
 assert.deepEqual(printed.at(-1),{total:2,failed:1});
 const failing=inProcess.events.filter(event=>event.event==='test'&&event.pass===false);
 assert.equal(failing.length,1);assert.equal(failing[0]!.case,2);
 assert.deepEqual(printed.slice(0,-1),inProcess.events.filter(event=>event.event!=='local_review'&&reportedWithoutVerbose(event)));
 assert.deepEqual(printed.slice(0,-1),failing);
 // With no operator pin both are one local review of the same revision, announced by the same event.
 const review=inProcess.events.find(event=>event.event==='local_review');
 assert.ok(review);assert.deepEqual(inProcess.localReview,{revision:review.revision,origin:'http://localhost'});
 assert.deepEqual(lines(child.stderr).find(event=>event.event==='local_review'),review);
});

// #1112: the operator host's plugins reach every fixture run through the shared core. A fixture that depends on one (a
// response header an onResponse hook adds) passes under run_tests exactly as under run_test, and so `urlcode test`;
// before the fix run_tests ran without the host's plugins and failed this case while run_test passed it.
test('run_tests and run_test both run the fixtures behind the operator host\'s plugins (#1112)',async t=>{
 const root=await project(t,{'/a':redirect()},{'tests/requests.json':JSON.stringify([{path:'/a',status:302,expectHeaders:{'x-operator-plugin':'on'}}])});
 const operator=await mkdtemp(join(tmpdir(),'urlcode-host-'));t.after(()=>rm(operator,{recursive:true,force:true}));
 const hostFile=join(operator,'host.mjs');
 await writeFile(hostFile,'export default {plugins:[{name:"stamp",version:"1",targets:["node"],onResponse(_request,result){return {...result,headers:[...result.headers,["x-operator-plugin","on"]]};}}]};\n');
 const {inProcess,child}=await bothRunners(root,hostFile);
 assert.equal(child.exitCode,0,child.stdout+child.stderr);
 assert.deepEqual(lines(child.stdout),[{total:1,failed:0}]);
 assert.deepEqual({total:inProcess.total,failed:inProcess.failed},{total:1,failed:0},JSON.stringify(inProcess.events));
 assert.deepEqual(inProcess.events.filter(event=>event.event==='test').map(event=>event.pass),[true]);
});
