import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {buildContext} from '../packages/core/src/context.ts';
import {getCapability} from '../packages/core/src/capability-query.ts';
import {getSchemaFragment} from '../packages/core/src/schema-query.ts';
import {mcpToolInventory} from '../packages/core/src/mcp.ts';
import {storeAuthoring} from '../packages/store/src/store.ts';
const script=fileURLToPath(new URL('../scripts/check-agent-facts.ts',import.meta.url));
const starter=fileURLToPath(new URL('../starters/default/',import.meta.url));

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

test('get_context, capabilities and the schema state the real wildcard rule (#585)',async()=>{
 const {constraints}=await buildContext(starter,{});
 const pathShape=constraints.pathShape as {note:string},mounts=constraints.wildcardMounts as {note:string};
 for(const note of [pathShape.note,mounts.note]){assert.match(note,/`\/\*\*`/);assert.match(note,/static/);assert.match(note,/`\/\*`/);}
 assert.match(pathShape.note,/No greedy captures or general-purpose wildcards anywhere else/);
 assert.ok(getCapability('static').constraints.some(line=>/must end in a terminal `\/\*`/.test(line)));
 assert.ok(getCapability('redirect').constraints.some(line=>/may end in `\/\*\*`/.test(line)));
 assert.match(JSON.stringify(getSchemaFragment('static')),/must end in a terminal \/\*/);
});
