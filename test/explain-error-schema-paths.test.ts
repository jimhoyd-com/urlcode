import test from 'node:test';
import assert from 'node:assert/strict';
import {errorRules} from '../packages/core/src/explain-error-rules.ts';
import {getSchemaFragment} from '../packages/core/src/schema-query.ts';
import {explainError} from '../packages/core/src/agent-context.ts';

// A get_schema path that explain_error suggests must resolve in the bundled schema, so a
// renamed or invented field (#757: `route.inputs`, which never existed) fails here rather
// than sending an agent to a "not found" answer.
const quoted=/get_schema for `([^`]+)`/g;
// Bare dotted schema paths (`route.x`, `routes.x`) in guidance prose are checked too, so a path
// written without the backtick convention cannot slip past the extraction above.
const bare=/(?<![`\w.])(route(?:s)?(?:\.[A-Za-z][A-Za-z0-9]*)+)(?![\w`])/g;

function suggestedPaths(guidance:string):string[] {
 return [...new Set([...guidance.matchAll(quoted),...guidance.matchAll(bare)].map(match=>match[1]!))];
}

test('every get_schema path suggested by an explain_error rule resolves in the real schema query',()=>{
 const checked:string[]=[];
 for(const rule of errorRules){
  const paths=suggestedPaths(rule.guidance);
  if(paths.length)assert.ok(rule.nextTools.includes('get_schema'),`rule ${rule.id} names a schema path but does not suggest get_schema`);
  for(const path of paths){
   let fragment;
   assert.doesNotThrow(()=>{fragment=getSchemaFragment(path);},`rule ${rule.id} suggests get_schema ${JSON.stringify(path)}, which does not resolve`);
   assert.equal(fragment!.path,path);
   assert.ok(fragment!.schema&&typeof fragment!.schema==='object',`rule ${rule.id}: ${path} returned no schema`);
   checked.push(path);
  }
 }
 // Guard against a vacuous pass if the extraction stops matching.
 assert.ok(checked.includes('route.parameters'),`expected route.parameters among suggested paths, got ${JSON.stringify(checked)}`);
});

test('the extraction catches a stale path such as route.inputs',()=>{
 assert.deepEqual(suggestedPaths('Ask get_schema for `route.inputs`.'),['route.inputs']);
 assert.deepEqual(suggestedPaths('Ask get_schema for route.inputs.'),['route.inputs']);
 assert.throws(()=>getSchemaFragment('route.inputs'),/Unknown schema path segment/);
});

test('undeclared-input guidance points at route.parameters (#757)',()=>{
 const explained=explainError('Every path placeholder requires an input declaration; {id} has none.');
 assert.equal(explained.matched,'undeclared-input');
 assert.match(explained.guidance,/route\.parameters/);
 assert.doesNotMatch(explained.guidance,/route\.inputs/);
 assert.deepEqual(explained.nextTools,['get_schema']);
});
