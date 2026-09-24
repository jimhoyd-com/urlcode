import test from 'node:test';
import assert from 'node:assert/strict';
import {project,redirect} from './helpers.ts';
import {canonicalMcpToolNames,mcpToolInventory} from '../packages/core/src/mcp.ts';
import {errorRules} from '../packages/core/src/explain-error-rules.ts';
import {explainError,listAgentCatalog} from '../packages/core/src/agent-context.ts';
import {planFeature} from '../packages/core/src/feature-plan.ts';

// Tool names this package tells an agent to call next must be canonical tools that core's
// `urlcode mcp` defines, never a pre-#590 legacy alias that disappears when aliases are removed (#681).
const canonical=new Set(canonicalMcpToolNames);
const legacy=new Set(mcpToolInventory.read.filter(name=>!canonical.has(name)));

function assertCanonical(names:readonly string[],where:string):void {
 for(const name of names){
  assert.ok(!legacy.has(name),`${where} suggests legacy alias ${JSON.stringify(name)}`);
  assert.ok(canonical.has(name),`${where} suggests ${JSON.stringify(name)}, which is not a canonical urlcode mcp tool`);
 }
}

test('the canonical tool list excludes every legacy alias and includes the host-file tool',()=>{
 assert.ok(legacy.has('capabilities'));
 assert.ok(canonical.has('list_capabilities'));
 assert.ok(canonical.has('get_extensions'));
});

test('every explain_error nextTools entry is a canonical MCP tool name',()=>{
 for(const rule of errorRules)assertCanonical(rule.nextTools,`explainError rule ${rule.id}`);
 assertCanonical(explainError('something nobody has seen').nextTools,'explainError fallback');
 assert.deepEqual(explainError('Unknown capability "nope"').nextTools,['list_capabilities','get_schema']);
});

test('explain_error locates an extension configuration error and sends the author to the extension schema',()=>{
 const explained=explainError('Invalid extension configuration at /extensions/mcp/config/servers/docs/tools/search/annotations (additionalProperties): unknown key "cachedHint"; allowed keys: readOnlyHint (run urlcode extensions --json for its configuration schema)');
 assert.equal(explained.matched,'extension-config');
 assert.deepEqual(explained.location,['extensions','mcp','config','servers','docs','tools','search','annotations']);
 assert.deepEqual(explained.nextTools,['get_extensions','validate']);
 assert.equal(explainError('Invalid configuration at /routes (type): must be object').matched,'schema');
});

test('every plan_feature next entry, with and without a host file, is a canonical MCP tool name',async t=>{
 const root=await project(t,{'/old':redirect()});
 const withHost=await planFeature(root,'contact form',{extensions:[]});
 assert.ok(withHost.next.includes('get_extensions'));
 assertCanonical(withHost.next,'planFeature (host file)');
 assertCanonical((await planFeature(root,'contact form')).next,'planFeature (no host file)');
});

test('every agent catalog localTooling tool is a canonical MCP tool name',async()=>{
 const catalog=await listAgentCatalog();
 assertCanonical(catalog.addons.map(addon=>addon.localTooling.tool),'listAgentCatalog');
});
