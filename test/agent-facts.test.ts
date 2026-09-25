import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {buildContext} from '../packages/core/src/context.ts';
import {getCapability} from '../packages/core/src/capability-query.ts';
import {getSchemaFragment} from '../packages/core/src/schema-query.ts';
import {mcpToolInventory} from '../packages/core/src/mcp.ts';
import {storeAuthoring} from '../packages/store/src/authoring.ts';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const script=fileURLToPath(new URL('../scripts/check-agent-facts.ts',import.meta.url));
const starter=fileURLToPath(new URL('../starters/default/app/',import.meta.url));

test('the agent-facts inventory is derived from the implementation and the prose agrees with it (#541)',()=>{
 const inventory=spawnSync(process.execPath,[script,'--inventory'],{encoding:'utf8',timeout:30000});
 assert.equal(inventory.status,0,inventory.stderr);
 const facts=JSON.parse(inventory.stdout) as {extensionBundles:string[];kitAdopters:string[];scaffoldWithUnordered:boolean;mcpTools:{read:number;hostFile:number;authoring:number};storeShortLinks:boolean};
 assert.deepEqual(facts.mcpTools,{read:mcpToolInventory.read.length,hostFile:1,authoring:mcpToolInventory.authoring.length});
 assert.ok(facts.extensionBundles.includes('forms'));
 assert.equal(facts.storeShortLinks,storeAuthoring.surfaces.some(surface=>surface.name==='shortLinks'));
 const check=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:30000});
 assert.equal(check.status,0,check.stderr);
});

test('the retired hosted AI token and hosted LLM-tool claims cannot reappear in agent-visible prose (#756)',async t=>{
 const inventory=spawnSync(process.execPath,[script,'--inventory'],{encoding:'utf8',timeout:30000});
 assert.equal(inventory.status,0,inventory.stderr);
 assert.deepEqual(JSON.parse(inventory.stdout).hostedAi,{endpoint:'https://urlcode.ai/mcp',authentication:'none',hostedModelTools:false,retiredCredentials:['URLCODE_AI_TOKEN']});
 const dir=await mkdtemp(join(tmpdir(),'urlcode-agent-facts-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const scan=async(text:string)=>{const file=join(dir,'SKILL.md');await writeFile(file,text);return spawnSync(process.execPath,[script,'--files',file],{encoding:'utf8',timeout:30000});};
 for(const [text,fact] of [
  ['Send `Authorization: Bearer <URLCODE_AI_TOKEN>` to the server.\n','hostedAi.retiredCredentials'],
  ['[URLCode AI](https://urlcode.ai/) is a hosted service for shared skills and LLM tooling.\n','hostedAi.hostedModelTools'],
  ['Keep the URLCode AI bearer token in the client secret facility.\n','hostedAi.authentication'],
 ] as const){
  const result=await scan(text);
  assert.equal(result.status,1,`${fact} should reject: ${text}`);
  assert.ok(result.stderr.includes(`[${fact}`),result.stderr);
 }
 // The shipped wording, and bearer tokens that belong to the auth extension, stay clean.
 const clean=await scan('[URLCode AI](https://urlcode.ai/) is an optional hosted service for version-pinned reference and shared skills; its anonymous remote MCP runs no model of its own.\n\nThe auth extension checks a bearer token on `/api/*`.\n');
 assert.equal(clean.status,0,clean.stderr);
});

test('MCP tool counts in prose follow run_tests into the --allow-authoring set (#590)',async t=>{
 // run_tests executes project code, so it left the read tools for the authoring-gated set.
 assert.equal(mcpToolInventory.read.includes('run_tests'),false);assert.equal(mcpToolInventory.authoring.includes('run_tests'),true);
 const dir=await mkdtemp(join(tmpdir(),'urlcode-agent-facts-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const scan=async(text:string)=>{const file=join(dir,'TOOLS.md');await writeFile(file,text);return spawnSync(process.execPath,[script,'--files',file],{encoding:'utf8',timeout:30000});};
 const stale=await scan('`urlcode mcp --allow-authoring --project DIR` adds six tools to the thirty-six read tools above.\n');
 assert.equal(stale.status,1,stale.stderr);assert.match(stale.stderr,/counts (?:36 read|6 authoring) tools/);
 const current=await scan(`\`urlcode mcp --allow-authoring --project DIR\` adds ${mcpToolInventory.authoring.length} tools to the ${mcpToolInventory.read.length} read tools above.\n`);
 assert.equal(current.status,0,current.stderr);
});
test('get_context, capabilities and the schema state the real wildcard rule (#585)',async()=>{
 const {constraints}=await buildContext(starter,{});
 const pathShape=constraints.pathShape as {note:string},mounts=constraints.wildcardMounts as {note:string};
 for(const note of [pathShape.note,mounts.note]){assert.match(note,/`\/\*\*`/);assert.match(note,/static/);assert.match(note,/`\/\*`/);}
 assert.match(pathShape.note,/No greedy captures or general-purpose wildcards anywhere else/);
 assert.ok(getCapability('static').constraints.some(line=>/must end in a terminal `\/\*`/.test(line)));
 assert.ok(getCapability('redirect').constraints.some(line=>/may end in `\/\*\*`/.test(line)));
 assert.match(JSON.stringify(getSchemaFragment('static')),/must end in a terminal \/\*/);
});
