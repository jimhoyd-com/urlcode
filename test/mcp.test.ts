import test from 'node:test';import assert from 'node:assert/strict';import {Readable,Writable} from 'node:stream';
import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
import {serveMcp} from '../src/mcp.ts';import {project,redirect} from './helpers.ts';
import {cachePath,extractArtifact,writeLock} from '../src/extension-artifacts.ts';
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}};
interface Reply { error:{code:number;message:string};result:{protocolVersion:string;tools:unknown[];content:{text:string}[];isError?:boolean} }
const ready={jsonrpc:'2.0',method:'notifications/initialized'};
async function session(root:string,messages:unknown[],raw?:string) {let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});await serveMcp({project:root,input:Readable.from([raw??messages.map(value=>JSON.stringify(value)+'\n').join('')]),output});return text.trim().split('\n').filter(Boolean).map(value=>JSON.parse(value) as Reply);}
function tar(files:Record<string,string>):Buffer {const pieces:Buffer[]=[];for(const [path,text] of Object.entries(files)){const body=Buffer.from(text),header=Buffer.alloc(512);header.write(path);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header[156]=48;header.fill(32,148,156);header.write([...header].reduce((sum,byte)=>sum+byte,0).toString(8).padStart(6,'0')+'\0 ',148);pieces.push(header,body,Buffer.alloc((512-body.length%512)%512));}pieces.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(pieces));}
test('MCP negotiates explicit supported protocol and lists read-only implemented tools',async t=>{
 const root=await project(t,{'/a':redirect()});const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'inspect',arguments:{}}}]);
 assert.equal(replies[0]!.result.protocolVersion,'2025-11-25');assert.equal(replies[1]!.result.tools.length,24);assert.equal(JSON.parse(replies[2]!.result.content[0]!.text).routeCount,1);
});
test('MCP plans a feature without adding execution or authoring authority',async t=>{
 const root=await project(t,{});const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'plan_feature',arguments:{goal:'persisted contact form'}}}]);
 const plan=JSON.parse(replies[1]!.result.content[0]!.text);assert.equal(plan.format,1);assert.ok(plan.applicable.recipes.some((recipe:{name:string})=>recipe.name==='store-crud'));
});
test('MCP reviews a project\'s own function source without executing it',async t=>{
 const root=await project(t,{'/submit':{methods:['POST'],function:{source:'f.mjs'}}},{'f.mjs':'export default function(request){const body=JSON.parse(request.body);if(typeof body.email!=="string")throw new Error("email is required");return {status:200};}'});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'review_project',arguments:{}}}]);
 const review=JSON.parse(replies[1]!.result.content[0]!.text);
 assert.equal(review.format,1);
 assert.ok(review.observations.some((item:{category:string;signal:string})=>item.category==='native-alternative'&&item.signal==='manual-body-validation'));
});
test('MCP progressively discloses packaged skills, docs and examples without project file access',async t=>{
 const root=await project(t,{});const replies=await session(root,[initialize,ready,...[
  {name:'list_skills',arguments:{}},{name:'get_skill',arguments:{name:'urlcode'}},{name:'search_docs',arguments:{text:'redirect schema'}},{name:'get_example',arguments:{name:'aws'}},{name:'validate_yaml',arguments:{yaml:'version: "1"\nroutes: {}\n'}},{name:'validate_yaml',arguments:{yaml:'version: "1"\nroutes:\n  /: {unknown: true}\n'}},{name:'explain_error',arguments:{error:'Invalid configuration at /routes'}}
 ].map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}))]);
 const skills=JSON.parse(replies[1]!.result.content[0]!.text);assert.equal(skills[0].name,'urlcode');
 assert.match(JSON.parse(replies[2]!.result.content[0]!.text).content,/Declarative-first/);
 assert.ok(JSON.parse(replies[3]!.result.content[0]!.text).results.length>0);
 assert.match(JSON.parse(replies[4]!.result.content[0]!.text).content['urlcode.yaml'],/version:/);
 assert.equal(JSON.parse(replies[5]!.result.content[0]!.text).valid,true);
 assert.equal(JSON.parse(replies[6]!.result.content[0]!.text).valid,false);
 assert.match(JSON.parse(replies[7]!.result.content[0]!.text).guidance,/get_schema/);
});
test('MCP inventories and reads only verified locked extension artifact data',async t=>{
 const root=await project(t,{}),archive=tar({'extension.json':JSON.stringify({format:1,kind:'declarative',name:'sample',version:'1.0.0'}),'schemas/config.json':JSON.stringify({type:'object'}),'README.md':'# Sample\n'}),sha256=createHash('sha256').update(archive).digest('hex');
 const entry={name:'sample',version:'1.0.0',asset:'sample-1.0.0.tgz',sha256,kind:'declarative' as const};
 await extractArtifact(archive,entry,cachePath(root,sha256));await writeLock(root,{format:1,artifacts:[{...entry,catalog:{tag:'extensions@v1.0.0',commit:'a'.repeat(40)}}]});
 const replies=await session(root,[initialize,ready,...[
  {name:'get_extension_artifacts',arguments:{}},{name:'get_extension_artifact',arguments:{name:'sample',path:'schemas/config.json'}},{name:'get_extension_artifact',arguments:{name:'sample',path:'../package.json'}}
 ].map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}))]);
 const inventory=JSON.parse(replies[1]!.result.content[0]!.text);assert.equal(inventory.artifacts[0].status,'cached');assert.deepEqual(inventory.artifacts[0].files,['README.md','extension.json','schemas/config.json']);
 const schema=JSON.parse(replies[2]!.result.content[0]!.text);assert.equal(schema.mediaType,'application/json');assert.equal(schema.content.type,'object');
 assert.equal(replies[3]!.result.isError,true);
});
test('MCP validates lifecycle, tool schema, method and root confinement',async t=>{
 const root=await project(t,{});const replies=await session(root,[{jsonrpc:'2.0',id:0,method:'tools/list'},initialize,ready,...[
 {name:'inspect',arguments:{project:'../../outside'}},{name:'inspect',arguments:{limit:1001}},{name:'shell',arguments:{command:'echo nope'}},{name:'recipes_show',arguments:{name:'../outside'}}
 ].map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params})),{jsonrpc:'2.0',id:8,method:'unknown'}]);
 assert.equal(replies[0]!.error.code,-32002);for(const reply of replies.slice(2,5))assert.equal(reply.error.code,-32602);assert.equal(replies[5]!.result.isError,true);assert.equal(replies[6]!.error.code,-32601);
});
test('MCP rejects malformed, batched, truncated and oversized frames',async t=>{
 const root=await project(t,{});
 for(const raw of ['{oops}\n','[]\n','{}'])assert.ok((await session(root,[],raw))[0]!.error);
 const large=await session(root,[],'x'.repeat(1048577));assert.equal(large[0]!.error.message,'Message exceeds input limit');
});
test('MCP never activates guest code or emits credential/error source content',async t=>{
 const root=await project(t,{'/':{function:{source:'f.mjs'},secrets:{KEY:{secret:'AMBIENT_NAME'}}}},{'f.mjs':'while(true){}; export default ()=>new Response("no");','.env.local':'not-valid=secret-content'});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'validate',arguments:{}}}]);assert.equal(JSON.parse(replies[1]!.result.content[0]!.text).valid,true);assert.equal(JSON.stringify(replies).includes('AMBIENT_NAME'),false);
});
test('MCP fails closed on project source traversal without revealing source details',async t=>{
 const root=await project(t,{'/':{function:{source:'../private-credential.mjs'}}});const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'validate'}}]);assert.equal(replies[1]!.result.isError,true);assert.equal(JSON.stringify(replies).includes('private-credential'),false);
});
test('MCP accepts split UTF-8 frames and rejects invalid UTF-8',async t=>{
 const root=await project(t,{});let result='';const bytes=Buffer.from(JSON.stringify({...initialize,params:{...initialize.params,clientInfo:{name:'測試',version:'1'}}})+'\n');
 await serveMcp({project:root,input:Readable.from(Array.from(bytes,byte=>Buffer.from([byte]))),output:new Writable({write(chunk,_encoding,done){result+=String(chunk);done();}})});assert.equal(JSON.parse(result).result.protocolVersion,'2025-11-25');
 result='';await serveMcp({project:root,input:Readable.from([Buffer.from([0xff,10])]),output:new Writable({write(chunk,_encoding,done){result+=String(chunk);done();}})});assert.equal(JSON.parse(result).error.code,-32700);
});
test('MCP get_capability and get_schema answer from bundled data and reject unknown names',async t=>{
 const root=await project(t,{});
 const replies=await session(root,[initialize,ready,...[
 {name:'get_capability',arguments:{name:'redirect'}},{name:'get_schema',arguments:{path:'policies.cache'}},{name:'get_capability',arguments:{name:'shell'}},{name:'get_schema',arguments:{path:'../etc/passwd'}},{name:'get_schema',arguments:{}}
 ].map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}))]);
 const entry=JSON.parse(replies[1]!.result.content[0]!.text);assert.equal(entry.name,'redirect');assert.equal(entry.kind,'handler');assert.equal(entry.schemaFragments[0].pointer,'#/$defs/route/properties/redirect');assert.ok(entry.recipes.length);
 const fragment=JSON.parse(replies[2]!.result.content[0]!.text);assert.equal(fragment.pointer,'#/properties/policies/properties/cache');assert.equal(JSON.stringify(fragment).includes('$ref'),false);
 assert.equal(replies[3]!.result.isError,true);assert.equal(replies[4]!.result.isError,true);assert.equal(replies[5]!.error.code,-32602);
});
