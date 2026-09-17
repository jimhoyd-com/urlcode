import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './helpers.ts';
import { runInterchange } from '../src/interchange-cli.ts';
test('import dry-run reports without writing and committed output refuses overwrite',async t=>{
 const root=await project(t,{});const source=join(root,'routes.csv'),out=join(root,'converted.yaml');
 await writeFile(source,'path,url,status\n/a,https://example.com/a,302\n');
 const preview=await runInterchange('import',[source],{project:root,out,dryRun:true});assert.equal(preview.report.ok,true);await assert.rejects(readFile(out));
 await runInterchange('import',[source],{project:root,out});const content=await readFile(out,'utf8');assert.match(content,/\/a:/);
 await assert.rejects(runInterchange('import',[source],{project:root,out}),{code:'EEXIST'});assert.equal(await readFile(out,'utf8'),content);
});
test('unsupported provider semantics never produce an output file',async t=>{
 const root=await project(t,{});const source=join(root,'_redirects'),out=join(root,'converted.yaml');await writeFile(source,'/a https://example.com 302\n');
 const failed=await runInterchange('import',['netlify',source],{project:root,out});assert.equal(failed.report.ok,false);await assert.rejects(readFile(out));
 const accepted=await runInterchange('import',['netlify',source],{project:root,acceptProviderDifferences:true});assert.match(accepted.text,/"lossless":false/);
});
