import test from 'node:test';import assert from 'node:assert/strict';import {Readable,Writable} from 'node:stream';
import {serveMcp} from '../packages/core/src/mcp.ts';import {reportedWithoutVerbose} from '../packages/core/src/fixture-run.ts';import {project,redirect,byReplyId} from './helpers.ts';

// #1095: run_tests (in-process) and run_test (the `urlcode test` child) share one fixture-execution core, so one fixture
// outcome is one result: the same summary, the same failing case and the same local review, whichever tool reports it.
test('run_tests and run_test report the same fixture outcome from the one fixture core (#1095)',async t=>{
 const root=await project(t,{'/a':redirect()},{'tests/requests.json':JSON.stringify([{path:'/a',status:302},{path:'/a',status:200}])});
 const call=(id:number,name:string)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{}}});
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},call(2,'run_tests'),call(3,'run_test')];
 let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
 await serveMcp({project:root,input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output,allowAuthoring:true});
 const replies=text.trim().split('\n').map(line=>JSON.parse(line) as {id:number;result:{content:{text:string}[]}}).sort(byReplyId);
 const payload=(id:number)=>JSON.parse(replies.find(reply=>reply.id===id)!.result.content[0]!.text) as Record<string,unknown>;
 const inProcess=payload(2) as {total:number;failed:number;localReview?:unknown;events:Record<string,unknown>[]};
 const child=payload(3) as {exitCode:number;stdout:string;stderr:string;truncated:boolean};
 const lines=(value:string)=>value.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line) as Record<string,unknown>);
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
