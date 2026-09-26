import test from 'node:test';import assert from 'node:assert/strict';import {Readable,Writable} from 'node:stream';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {serveMcp} from '../packages/core/src/mcp.ts';import {artifactSite,project,redirect} from './helpers.ts';
import {initProject} from '../packages/core/src/authoring.ts';
import {readAddonCatalog} from '../packages/core/src/addon-manifest.ts';
import {addons} from '../scripts/workspaces.ts';
import {renderMcpConfig} from '../packages/core/src/agents-guide.ts';
import {fileURLToPath} from 'node:url';
import {inspectProject,validateProject,explainRoute,buildContext} from '../packages/core/src/tooling.ts';
import {buildManifest} from '../packages/core/src/manifest.ts';
import {loadOperatorHost} from '../packages/core/src/operator-host.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}};
interface Reply { error:{code:number;message:string};result:{protocolVersion:string;tools:unknown[];content:{text:string}[];isError?:boolean} }
const ready={jsonrpc:'2.0',method:'notifications/initialized'};
async function session(root:string,messages:unknown[],raw?:string,options:{allowAuthoring?:boolean}={}) {let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});await serveMcp({project:root,input:Readable.from([raw??messages.map(value=>JSON.stringify(value)+'\n').join('')]),output,...options});return text.trim().split('\n').filter(Boolean).map(value=>JSON.parse(value) as Reply);}
test('MCP negotiates explicit supported protocol and lists read-only implemented tools',async t=>{
 const root=await project(t,{'/a':redirect()});const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'inspect',arguments:{}}}]);
 assert.equal(replies[0]!.result.protocolVersion,'2025-11-25');assert.equal(replies[1]!.result.tools.length,35);assert.equal(JSON.parse(replies[2]!.result.content[0]!.text).routeCount,1);
 // get_context is documented as the first call an authoring agent makes; it is first in tools/list too.
 assert.equal((replies[1]!.result.tools[0] as {name:string}).name,'get_context');
});
test('MCP keeps every pre-#590 tool name working as a deprecated alias of its canonical name (#590)',async t=>{
 const root=await project(t,{'/a':redirect()});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'}]);
 const tools=replies[1]!.result.tools as {name:string;description:string}[];
 const legacy=['capabilities','import_preview','export_preview','recipes_list','recipes_show','review_project'];
 for(const name of legacy){const tool=tools.find(candidate=>candidate.name===name);assert.ok(tool,name);assert.match(tool!.description,/Deprecated alias for/);}
 // The old and the new name reach the same handler and answer the same call.
 const [,oldName,newName]=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'capabilities',arguments:{}}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_capabilities',arguments:{}}}]);
 assert.equal(oldName!.result.content[0]!.text,newName!.result.content[0]!.text);
});
test('MCP accepts the deprecated `target` deploy-target argument alongside the canonical `deployTarget` (#590)',async t=>{
 const root=await project(t,{});
 const [,byLegacy,byCanonical]=await session(root,[initialize,ready,
  {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_capabilities',arguments:{target:'cloudflare'}}},
  {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'list_capabilities',arguments:{deployTarget:'cloudflare'}}}]);
 assert.equal(byLegacy!.result.content[0]!.text,byCanonical!.result.content[0]!.text);
});
// A synthetic project whose ordinary trusted function writes a marker beside its module when it runs, and another
// when the module is imported: either file existing proves the project's code executed.
async function markerProject(t:Parameters<typeof project>[0]) {
 const fn='import {writeFileSync} from "node:fs";writeFileSync(new URL("./loaded.marker",import.meta.url),"loaded");export default () => {writeFileSync(new URL("./ran.marker",import.meta.url),"ran");return new Response("ok");};';
 const root=await project(t,{'/f':{function:{source:'functions/f.mjs'}}},{'functions/f.mjs':fn,'tests/requests.json':JSON.stringify([{path:'/f',status:200}])});
 const exists=(file:string)=>import('node:fs/promises').then(fs=>fs.access(join(root,'functions',file)).then(()=>true,()=>false));
 return {root,exists};
}
test('default MCP does not offer run_tests and refuses it with the --allow-authoring hint, running no project code (#590)',async t=>{
 const {root,exists}=await markerProject(t);
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'run_tests',arguments:{}}}]);
 assert.equal((replies[1]!.result.tools as {name:string}[]).some(tool=>tool.name==='run_tests'),false);
 assert.equal(replies[2]!.error.code,-32602);assert.match(replies[2]!.error.message,/run_tests needs the --allow-authoring option/);
 assert.equal(await exists('ran.marker'),false);assert.equal(await exists('loaded.marker'),false);
});
test('default MCP read tools never execute project code (#590)',async t=>{
 const {root,exists}=await markerProject(t);
 const replies=await session(root,[initialize,ready,...[
  {name:'get_context',arguments:{}},{name:'get_context',arguments:{task:'redirects'}},{name:'inspect',arguments:{}},{name:'validate',arguments:{}},{name:'explain',arguments:{target:'/f'}},
  {name:'get_manifest',arguments:{}},{name:'preview_export',arguments:{format:'json'}},{name:'suggest_fixtures',arguments:{}},{name:'summarize_yaml_change',arguments:{before:'version: "1"\nroutes: {}\n'}},
  {name:'plan_feature',arguments:{goal:'contact form'}},{name:'review',arguments:{}},{name:'get_extension_artifacts',arguments:{}},{name:'get_addon_agent_tooling',arguments:{}},
 ].map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}))]);
 assert.equal(replies.length,14);for(const reply of replies.slice(1))assert.ok(reply.result,JSON.stringify(reply));
 assert.equal(await exists('loaded.marker'),false);assert.equal(await exists('ran.marker'),false);
});
test('with --allow-authoring, run_tests is listed as executing, non-read-only, and runs the project\'s trusted code (#590)',async t=>{
 const {root,exists}=await markerProject(t);
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'run_tests',arguments:{}}}],undefined,{allowAuthoring:true});
 const tool=(replies[1]!.result.tools as {name:string;description:string;annotations:{readOnlyHint:boolean;destructiveHint:boolean;openWorldHint:boolean}}[]).find(candidate=>candidate.name==='run_tests');
 assert.ok(tool);assert.deepEqual({readOnly:tool!.annotations.readOnlyHint,destructive:tool!.annotations.destructiveHint,openWorld:tool!.annotations.openWorldHint},{readOnly:false,destructive:true,openWorld:true});
 assert.match(tool!.description,/EXECUTES the project's trusted function and middleware modules/);assert.match(tool!.description,/not confinement/);
 const result=JSON.parse(replies[2]!.result.content[0]!.text);
 assert.equal(result.total,1);assert.equal(result.failed,0);assert.ok(Array.isArray(result.events)&&result.events.length>=1);
 // The marker beside the module is the side effect the non-read-only annotation declares.
 assert.equal(await exists('ran.marker'),true);
});
test('MCP tools/call adds structuredContent alongside text content for object results (#590)',async t=>{
 const root=await project(t,{'/a':redirect()});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_capability',arguments:{name:'redirect'}}}]);
 const reply=replies[1]!.result as unknown as {structuredContent?:{name:string}};
 assert.equal(reply.structuredContent?.name,'redirect');
});
test('MCP list_skills inventories every shipped skill with its own SKILL.md description (#590)',async t=>{
 const root=await project(t,{});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_skills',arguments:{}}}]);
 const skills=JSON.parse(replies[1]!.result.content[0]!.text) as {name:string;description:string}[];
 assert.deepEqual(skills.map(skill=>skill.name).sort(),['urlcode','urlcode-authoring','urlcode-operations']);
 assert.match(skills.find(skill=>skill.name==='urlcode-authoring')!.description,/Author or modify a URLCode project/);
 assert.match(skills.find(skill=>skill.name==='urlcode-operations')!.description,/Deploy, verify, monitor and operate/);
});
test('MCP list_agent_catalog separates core discovery from project-installed add-on details',async t=>{
 const root=await project(t,{});
 const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'list_agent_catalog',arguments:{}}}]);
 const catalog=JSON.parse(replies[1]!.result.content[0]!.text) as {format:number;runtime:{package:string};core:{skills:{name:string}[]};addons:{kind:string;localTooling:{tool:string}}[]};
 assert.equal(catalog.format,1);assert.equal(catalog.runtime.package,'@jimhoyd/urlcode');
 assert.ok(catalog.core.skills.some(skill=>skill.name==='urlcode-authoring'));
 assert.ok(catalog.addons.every(addon=>addon.localTooling.tool=== (addon.kind==='extension'?'get_extensions':'get_extension_artifacts')));
});
test('MCP get_release_addon_catalog returns the release-wide catalog, distinct from what this project installed (#721)',async t=>{
 const root=await project(t,{});
 const replies=await session(root,[initialize,ready,...['get_release_addon_catalog','get_addon_agent_tooling'].map((name,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params:{name,arguments:{}}}))]);
 const catalog=JSON.parse(replies[1]!.result.content[0]!.text) as {scope:string;version:string;addons:{name:string;kind:string;package:string;version:string;agent?:{references:{path:string}[]}}[]};
 assert.deepEqual(catalog,await readAddonCatalog());
 assert.equal(catalog.scope,'release');
 const workspaces=await addons();
 assert.deepEqual(catalog.addons.map(addon=>addon.name),workspaces.map(addon=>addon.name).sort());
 for(const addon of catalog.addons)assert.equal(addon.kind,workspaces.find(workspace=>workspace.name===addon.name)!.kind);
 for(const addon of catalog.addons){assert.equal(addon.package,`@jimhoyd/urlcode-${addon.name}`);assert.equal(addon.version,catalog.version);}
 assert.ok(catalog.addons.some(addon=>addon.kind==='artifact'&&addon.agent?.references.length));
 // Listing the release is not evidence of installation: this project has installed nothing.
 assert.deepEqual(JSON.parse(replies[2]!.result.content[0]!.text).addons,[]);
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
test('MCP inventories and reads only installed, pinned, inert artifact data from the site around the project',async t=>{
 const {project:app}=await artifactSite(t,'sample');
 const replies=await session(app,[initialize,ready,...[
  {name:'get_extension_artifacts',arguments:{}},{name:'get_extension_artifact',arguments:{name:'sample',path:'schemas/config.json'}},{name:'get_extension_artifact',arguments:{name:'sample',path:'../package.json'}},
  {name:'get_extension_artifact',arguments:{name:'sample',path:'README.md'}},{name:'get_extension_artifact',arguments:{name:'missing',path:'urlcode.json'}}
 ].map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}))]);
 const inventory=JSON.parse(replies[1]!.result.content[0]!.text);
 assert.equal(inventory.artifacts.length,1);assert.equal(inventory.artifacts[0].name,'sample');assert.equal(inventory.artifacts[0].status,'installed');
 assert.deepEqual(inventory.artifacts[0].files,['README.md','package.json','schemas/config.json','urlcode.json']);
 assert.deepEqual(JSON.parse(replies[2]!.result.content[0]!.text).content,{type:'object'});
 assert.equal(replies[3]!.result.isError,true,'a path outside the allowlist is refused');
 assert.equal(JSON.parse(replies[4]!.result.content[0]!.text).content,'# sample\n');
 assert.equal(replies[5]!.result.isError,true,'an artifact that is not installed is refused');
 // A project that is not inside a site has no artifacts, and reading one names the site it looked in.
 const bare=await project(t,{});
 const none=await session(bare,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_extension_artifacts',arguments:{}}}]);
 assert.deepEqual(JSON.parse(none[1]!.result.content[0]!.text).artifacts,[]);
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
test('MCP echoes a supported requested protocol revision and offers the latest otherwise (#590)',async t=>{
 const root=await project(t,{});
 for(const [requested,expected] of [['2025-06-18','2025-06-18'],['2025-03-26','2025-03-26'],['2024-11-05','2024-11-05'],['2025-11-25','2025-11-25'],['1999-01-01','2025-11-25']] as const){
  const [reply]=await session(root,[{...initialize,params:{...initialize.params,protocolVersion:requested}}]);
  assert.equal(reply!.result.protocolVersion,expected,requested);
 }
});
test('MCP returns the CLI message for tool failures and names bad tools and arguments (#582)',async t=>{
 const root=await project(t,{'/a':{redirect:{url:'https://example.com/'},respond:{text:'two handlers'}}});
 const replies=await session(root,[initialize,ready,...[
  {name:'validate',arguments:{}},{name:'get_capability',arguments:{name:'nope'}},{name:'plan_feature',arguments:{text:'contact form'}},{name:'get_extensions',arguments:{}},{name:'no_such_tool',arguments:{}},{name:'inspect',arguments:{limit:0}},{name:'recipes_list',arguments:{}},
  {name:'explain_error',arguments:{error:'Function initialization failed in f.mjs:3 (export default): SyntaxError: Unexpected token'}},{name:'explain_error',arguments:{error:'Invalid configuration at /routes/~1a (required): missing required key "function"'}},{name:'explain_error',arguments:{error:'something nobody has seen'}},
 ].map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}))]);
 assert.equal(replies[1]!.result.isError,true);assert.match(replies[1]!.result.content[0]!.text,/^urlcode\.yaml:\d+:\d+: Invalid configuration at route \/a: declares 2 handlers/);
 assert.equal(replies[2]!.result.isError,true);assert.match(replies[2]!.result.content[0]!.text,/^Unknown capability; valid names: .*redirect/);
 assert.equal(replies[3]!.error.code,-32602);assert.match(replies[3]!.error.message,/^Invalid arguments for plan_feature: /);
 assert.match(replies[3]!.error.message,/unknown argument "text"/);assert.match(replies[3]!.error.message,/missing required argument "goal"/);assert.match(replies[3]!.error.message,/Accepted arguments: goal \(required\), deployTarget, target$/);
 assert.equal(replies[4]!.error.code,-32602);assert.match(replies[4]!.error.message,/^Unknown tool "get_extensions".*--host-file/);
 assert.equal(replies[5]!.error.code,-32602);assert.match(replies[5]!.error.message,/^Unknown tool "no_such_tool"; call tools\/list/);
 assert.equal(replies[6]!.error.code,-32602);assert.match(replies[6]!.error.message,/argument "limit" must be >= 1/);
 // plan_feature compiles the project, so it runs against a valid one; with no host file its next calls omit get_extensions.
 const valid=await project(t,{});const [,planned]=await session(valid,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'plan_feature',arguments:{goal:'persisted contact form'}}}]);
 const plan=JSON.parse(planned!.result.content[0]!.text);assert.equal(plan.next.includes('get_extensions'),false);assert.ok(plan.next.includes('get_context'));
 const init=JSON.parse(replies[8]!.result.content[0]!.text);assert.equal(init.matched,'function-initialization');assert.match(init.guidance,/named line/);
 const handler=JSON.parse(replies[9]!.result.content[0]!.text);assert.equal(handler.matched,'route-handler');assert.deepEqual(handler.location,['routes','/a']);assert.match(handler.guidance,/exactly one handler/);
 const unknown=JSON.parse(replies[10]!.result.content[0]!.text);assert.equal(unknown.matched,null);assert.ok(unknown.nextTools.includes('search_docs'));
});
test('MCP pre-session bootstrap: a fresh agent session sees the server before urlcode init ever runs (#542)',async t=>{
 // Simulates the exact gap #542 reports: Claude Code loads a project `.mcp.json` at
 // session start, before any agent turn runs. `urlcode mcp print-config` lets a human register that file in an
 // empty directory beforehand, so the server named there must behave usefully against a directory that has no
 // urlcode.yaml yet, not just crash or refuse to start.
 const root=await mkdtemp(join(tmpdir(),'urlcode-presession-'));t.after(()=>rm(root,{recursive:true,force:true}));
 assert.ok(renderMcpConfig('app',{local:true}).includes('"@jimhoyd/urlcode"'),'sanity: this is the file a human would have registered');
 // print-config names the site's app/ project, which does not exist until init creates it.
 const app=join(root,'app');
 // First turn, project not yet initialized: tools/list works (the server started fine against an empty directory),
 // and a project-reading tool fails closed with the same actionable message the CLI prints, not a crash.
 const before=await session(app,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_context',arguments:{}}}]);
 assert.ok((before[1]!.result.tools as {name:string}[]).some(tool=>tool.name==='get_context'));
 assert.equal(before[2]!.result.isError,true);
 assert.match(before[2]!.result.content[0]!.text,/run urlcode init .* to create the site and its app\/ project/);
 // The agent follows that guidance and initializes the project in the same directory the server is already watching.
 await initProject(root);
 // No restart: the next tool call against the same project root now succeeds.
 const after=await session(app,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_context',arguments:{}}}]);
 assert.equal(after[1]!.result.isError,undefined);
 assert.equal(JSON.parse(after[1]!.result.content[0]!.text).project.routes,0);
});
test('MCP forwards the --host-file registrations to get_context, inspect, validate, explain and get_manifest like the SDK (#755)',async t=>{
 // The demo example declares a `demo` extension (mount /demo/*, a policy requirement on /private); the host file registers it.
 const root=fileURLToPath(new URL('../examples/extensions/',import.meta.url));
 const dir=await mkdtemp(join(tmpdir(),'urlcode-mcp-host-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const registration={name:'demo',version:'1',projectSha256:await inspectExtensionRevision(root),targets:['node','aws','vercel'],
  schema:{type:'object',properties:{label:{type:'string'}},required:['label'],additionalProperties:false},
  policySchema:{type:'object',properties:{role:{const:'member'}},required:['role'],additionalProperties:false}};
 const file=join(dir,'host.mjs');
 await writeFile(file,`export default {extensions:[{...${JSON.stringify(registration)},activate(){throw new Error('inspection must not activate');}}]};`);
 const calls:[string,Record<string,unknown>][]=[['get_context',{}],['inspect',{}],['validate',{}],['explain',{target:'/private'}],['get_manifest',{}]];
 const messages=[initialize,ready,...calls.map(([name,args],index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params:{name,arguments:args}}))];
 const run=async(hostFile?:string)=>{let text='';await serveMcp({project:root,...(hostFile===undefined?{}:{hostFile}),input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output:new Writable({write(chunk,_encoding,done){text+=String(chunk);done();}})});
  return text.trim().split('\n').map(line=>JSON.parse(line) as Reply).slice(1).map(reply=>{assert.equal(reply.result.isError,undefined,reply.result.content[0]!.text);return JSON.parse(reply.result.content[0]!.text) as unknown;});};
 const [context,inspected,validated,explained,manifest]=await run(file);
 // The host-aware SDK: the same host file, its registrations passed as `extensions` (buildContext loads it by `hostFile`).
 const host=await loadOperatorHost(file,root);const extensions=host.extensions;
 const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as unknown;
 assert.deepEqual(context,json(await buildContext(root,{projectFlag:'.',hostFile:file})));
 assert.deepEqual(inspected,json(await inspectProject(root,{extensions})));
 assert.deepEqual(validated,json(await validateProject(root,{extensions})));
 assert.deepEqual(explained,json(await explainRoute(root,'/private',{extensions})));
 assert.deepEqual(manifest,json(await buildManifest(root,{extensions})));
 // The registration is visible, not just equal: the context names the host and explain names the registered provider.
 assert.deepEqual((context as {project:{host:unknown}}).project.host,{extensions:['demo'],plugins:0});
 assert.deepEqual((explained as {policies:{extensions:{demo:{provider:unknown}}}}).policies.extensions.demo.provider,{registered:true,version:'1',targets:['node','aws','vercel'],revisionMatch:true,requirementValid:true});
 // Without a host file the same tools keep their host-less answers.
 const [bareContext,,,bareExplained]=await run();
 assert.equal((bareContext as {project:{host?:unknown}}).project.host,undefined);
 assert.equal((bareExplained as {policies:{extensions:{demo:{provider?:unknown}}}}).policies.extensions.demo.provider,undefined);
});
