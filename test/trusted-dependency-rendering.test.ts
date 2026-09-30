import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parse} from 'yaml';
import {buildProjectReport,renderProjectReport} from '../packages/core/src/project-report.ts';
import {project} from './helpers.ts';
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));

test('plain CLI review exposes incomplete passive dependency inventory',async t=>{
  const root=await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':"import 'example-lib'; throw new Error('must not execute'); export default ()=>null;"});
  const child=spawnSync(process.execPath,[cli,'review','--project',root],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const review=parse(child.stdout);
  assert.equal(review.trustedDependencies.complete,false);
  assert.deepEqual(review.trustedDependencies.packages,['example-lib']);
  assert.ok(review.trustedDependencies.opaque.some((item:{reason:string})=>item.reason==='package-implementation-not-inventoried'));
});

test('HTML report shows opaque dependencies as attention and escapes inventory text',async t=>{
  const root=await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':"import 'example-lib'; export default ()=>null;"});
  const report=await buildProjectReport(root);
  assert.ok(report.attention.some(item=>item.message.includes('dependency inventory is incomplete')));
  // The renderer must escape every metadata string, including future collector fields.
  report.review.trustedDependencies.opaque.push({source:'<SCRIPT>secret</SCRIPT>',reason:'<img onerror=alert(1)>'});
  report.review.trustedDependencies.packageDeclarations.push({name:'<pkg>',lockfile:'<lock>',version:'<version>',integrity:'<integrity>'});
  const html=renderProjectReport(report);
  assert.match(html,/Static import inventory: incomplete/);
  assert.match(html,/Opaque dependencies/);
  assert.match(html,/package-implementation-not-inventoried/);
  assert.match(html,/does not prove full runtime dependency coverage/);
  assert.match(html,/&lt;SCRIPT&gt;secret&lt;\/SCRIPT&gt;/);
  assert.match(html,/&lt;lock&gt;/);
  assert.doesNotMatch(html,/<(?:script|img)\b|Nothing needs attention/i);
});

test('HTML limits complete claim to static inventory',async t=>{
  const root=await project(t,{'/':{function:{source:'f.mjs'}}},{'f.mjs':"export default ()=>null;"});
  const html=renderProjectReport(await buildProjectReport(root));
  assert.match(html,/Static import inventory: complete/);
  assert.match(html,/Trusted code still has full Node access/);
  assert.match(html,/Hashed files/);
});
