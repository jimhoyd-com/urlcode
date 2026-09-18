import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {Ajv} from 'ajv';
import {capabilityNames,capabilityTargets,capabilityDetails} from '../src/capabilities.ts';
import {getCapability,formatCapability} from '../src/capability-query.ts';
import {getSchemaFragment,schemaPathNames} from '../src/schema-query.ts';
import {getCapability as sdkCapability,getSchemaFragment as sdkSchema} from '../src/tooling.ts';
const cli=fileURLToPath(new URL('../src/cli.ts',import.meta.url));
const run=(...args:string[])=>spawnSync(process.execPath,['--conditions=development',cli,...args],{encoding:'utf8',timeout:15000});
const compiles=(schema:unknown)=>{const ajv=new Ajv({strict:false});assert.doesNotThrow(()=>ajv.compile(schema as object));};
test('every catalog name resolves through getCapability with valid, bounded schema fragments',()=>{
 assert.deepEqual(Object.keys(capabilityDetails).sort(),[...capabilityNames].sort());
 for(const name of capabilityNames){
  const entry=getCapability(name);
  assert.equal(entry.name,name);assert.ok(entry.summary);assert.ok(entry.schema.length);assert.equal(entry.schemaFragments.length,entry.schema.length);
  for(const target of capabilityTargets)assert.ok(entry.targets[target].support);
  assert.deepEqual(entry.refused.map(item=>item.target),capabilityTargets.filter(target=>entry.targets[target].support==='refused'));
  for(const fragment of entry.schemaFragments){const text=JSON.stringify(fragment.schema);assert.ok(Buffer.byteLength(text)<=16384,`${fragment.path} exceeds 16 KiB`);assert.equal(text.includes('"$ref"'),false);compiles(fragment.schema);}
  assert.match(formatCapability(entry),new RegExp(`^${name.replace('.','\\.')} \\(${entry.kind}\\)`));
 }
 assert.equal(sdkCapability,getCapability);assert.equal(sdkSchema,getSchemaFragment);
 assert.throws(()=>getCapability('SECRET'),/valid names: extension/);
});
test('every schema path yields a valid inline fragment and unknown paths list valid names',()=>{
 for(const path of schemaPathNames()){const fragment=getSchemaFragment(path);assert.equal(fragment.path,path);const text=JSON.stringify(fragment.schema);assert.ok(Buffer.byteLength(text)<=16384,path);assert.equal(text.includes('"$ref"'),false);compiles(fragment.schema);}
 for(const path of ['policies.cache','site.sitemap','request.body','conditional.cases','profiles']){compiles(getSchemaFragment(path).schema);}
 assert.equal(getSchemaFragment('policies.cache').pointer,'#/properties/policies/properties/cache');
 assert.equal(getSchemaFragment('site.sitemap').pointer,'#/properties/site/properties/sitemap');
 assert.equal(getSchemaFragment('redirect').pointer,'#/$defs/route/properties/redirect');
 assert.match((getSchemaFragment('routes').schema.additionalProperties as {$comment:string}).$comment,/see urlcode schema route/);assert.ok(Buffer.byteLength(JSON.stringify(getSchemaFragment('route').schema))>4096);
 assert.throws(()=>getSchemaFragment('nope'),/top-level names: version, routes/);
 assert.throws(()=>getSchemaFragment('site.nope'),/names under #\/properties\/site: robots/);
 for(const bad of ['','../x','#/$defs/route','a'.repeat(300)])assert.throws(()=>getSchemaFragment(bad));
});
test('capability entries report bundled usage, grants and refusals from existing data',()=>{
 const redirect=getCapability('redirect');
 assert.equal(redirect.kind,'handler');assert.ok(redirect.recipes.some(item=>item.file==='redirect/urlcode.yaml'&&item.routes.includes('/docs')));assert.ok(redirect.cookbook.some(item=>item.file==='routes/redirects.yaml'&&item.routes.includes('/go')));
 const cache=getCapability('policies.cache');
 assert.equal(cache.kind,'policy');assert.deepEqual(cache.refused,[{target:'cloudflare',reason:'policies.cache cannot be compiled or enforced by this target'}]);assert.ok(cache.cookbook.some(item=>item.routes.includes('/cached')));
 const proxy=getCapability('proxy');
 assert.equal(proxy.kind,'egress');assert.deepEqual(proxy.refused.map(item=>item.target),['cloudflare','aws','vercel']);assert.ok(proxy.grants.some(grant=>/--policy/.test(grant)));
 assert.ok(getCapability('bindings').grants.length);assert.equal(getCapability('bindings').schemaFragments.length,2);
 assert.equal(JSON.stringify(getCapability('link')).includes('sqlite'),false);
});
test('CLI prints one handler, one policy, schema fragments and fails closed on unknown names',()=>{
 const handler=run('capabilities','function','--json','--project','/missing');
 assert.equal(handler.status,0,handler.stderr);const entry=JSON.parse(handler.stdout);assert.equal(entry.kind,'handler');assert.equal(entry.targets.cloudflare.support,'refused');
 const policy=run('capabilities','policies.throttle');
 assert.equal(policy.status,0,policy.stderr);assert.match(policy.stdout,/^policies\.throttle \(policy\)/);assert.match(policy.stdout,/Cookbook routes:\n {2}- routes\/policies\.yaml: \/budget/);
 const unknown=run('capabilities','SECRET-NAME');
 assert.equal(unknown.status,1);assert.doesNotMatch(unknown.stderr,/SECRET-NAME/);assert.match(unknown.stderr,/valid names: extension, policies.extensions, proxy/);
 assert.equal(run('capabilities','redirect','--target','aws').status,1);
 const schema=run('schema','policies.cache','--json');
 assert.equal(schema.status,0,schema.stderr);assert.equal(JSON.parse(schema.stdout).oneOf[0].const,false);
 assert.match(run('schema','site.sitemap','--yaml').stdout,/^oneOf:\n {2}- const: true/);
 const bad=run('schema','SECRET-PATH');assert.equal(bad.status,1);assert.doesNotMatch(bad.stderr,/SECRET-PATH/);assert.match(bad.stderr,/top-level names: version/);
 assert.equal(run('schema').status,1);
});
