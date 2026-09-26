import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stringify} from 'yaml';
import {buildProjectReport,renderProjectReport} from '../packages/core/src/project-report.ts';
import {explainProject} from '../packages/core/src/tooling.ts';
import {inspectExtensionRevision} from '../packages/core/src/extensions.ts';
import {loadDocument} from '../packages/core/src/config.ts';
import {prepareFunctionSnapshot,requestedPermissions} from '../packages/core/src/policy.ts';
import type {RuntimeExtension} from '../packages/core/src/extensions.ts';
import {project} from './helpers.ts';
const cookbook=fileURLToPath(new URL('../examples/cookbook/',import.meta.url));
const extensions=fileURLToPath(new URL('../examples/extensions/',import.meta.url));
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));

test('report routes are exactly what explain returns, and the page is deterministic',async()=>{
  const report=await buildProjectReport(cookbook);
  assert.deepEqual(report.routes,(await explainProject(cookbook)).routes);
  assert.equal(report.host,false);
  assert.equal(report.policy,false);
  assert.equal(report.change,undefined);
  const html=renderProjectReport(report);
  assert.equal(html,renderProjectReport(await buildProjectReport(cookbook)));
  assert.match(html,/^<!doctype html>/);
  assert.match(html,/Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/);
  for(const route of report.routes)assert(html.includes(`<code>${route.path}</code>`),route.path);
  // Disabled and expired cookbook routes are surfaced for a person to check.
  assert.deepEqual(report.attention.map(item=>[item.level,item.route]),[['check','/paused'],['check','/expired']]);
});

test('report escapes project text and never emits script',async t=>{
  const root=await project(t,{'/x':{description:'<script>alert(1)</script> "quoted" & <b>bold</b>',respond:{text:'ok'}}});
  const html=renderProjectReport(await buildProjectReport(root));
  assert(!/<script/i.test(html));
  assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;quoted&quot; &amp; &lt;b&gt;bold&lt;/b&gt;'));
});

test('report against an earlier version lists new code, sandbox flips and requested grants, never values',async t=>{
  const before={'/a':{respond:{text:'a'}},'/f':{function:{source:'functions/f.mjs'}}};
  const handler='export default () => new Response("ok");\n';
  const beforeRoot=await project(t,before,{'functions/f.mjs':handler});
  const after=await project(t,{
    '/f':{sandbox:true,function:{source:'functions/f.mjs'}},
    '/g':{secrets:{API_KEY:{secret:'API_KEY'}},function:{source:'functions/g.mjs'}},
  },{'functions/f.mjs':handler,'functions/g.mjs':handler});
  const report=await buildProjectReport(after,{before:{input:{project:beforeRoot},label:'main'}});
  assert.equal(report.change?.before,'main');
  assert.deepEqual(report.attention.map(item=>`${item.route} ${item.message}`),[
    '/g New trusted function functions/g.mjs.',
    '/f Code now runs sandboxed (was trusted).',
    '/g Asks the operator for secret API_KEY.',
    '/a Route removed.',
  ]);
  const html=renderProjectReport(report);
  assert.match(html,/Changes since <code>main<\/code>/);
  assert.match(html,/Adds <a href="#%2Fg"><code>\/g<\/code><\/a> \(function/);
  assert.match(html,/Removes <a href="#%2Fa"><code>\/a<\/code><\/a>/);
  // Without --policy the page says grants are unchecked, because /g asks for one.
  assert.match(html,/No operator policy: env, secret and outbound grants/);
  assert.doesNotMatch(html,/No host file/);
  // A YAML text side is accepted as well, the way `urlcode diff` reads a file.
  const text=await buildProjectReport(after,{before:{input:{yaml:stringify({version:'1',routes:before})},label:'urlcode.yaml'}});
  assert.equal(text.change?.scope,'mixed');
});

test('with host registrations the report flags missing add-ons and a stale revision pin',async()=>{
  const registration=(name:string,projectSha256:string):RuntimeExtension=>({name,version:'1',projectSha256,targets:['node'],schema:{type:'object'},policySchema:{type:'object'},activate(){throw new Error('report must not activate extensions');}});
  const missing=await buildProjectReport(extensions,{extensions:[]});
  assert.equal(missing.host,true);
  assert.deepEqual(missing.attention.filter(item=>item.level==='fix').map(item=>item.message),[
    'Add-on "demo" is not registered in the host file.',
    'Add-on "auth" is not registered in the host file.',
  ]);
  const current=await inspectExtensionRevision(extensions);
  const stale=await buildProjectReport(extensions,{extensions:[registration('demo','0'.repeat(64)),registration('auth',current)]});
  assert.deepEqual(stale.attention.filter(item=>item.level==='fix').map(item=>item.message),['The host file registers "demo" for a different project revision. Review this version, then re-pin.']);
  const pinned=await buildProjectReport(extensions,{extensions:[registration('demo',current),registration('auth',current)]});
  assert.deepEqual(pinned.attention.filter(item=>item.level==='fix'),[]);
});

test('urlcode report prints the page, or the report as JSON',()=>{
  const html=spawnSync(process.execPath,[cli,'report','--project',cookbook],{encoding:'utf8'});
  assert.equal(html.status,0,html.stderr);
  assert.match(html.stdout,/^<!doctype html>/);
  const json=spawnSync(process.execPath,[cli,'report','--project',cookbook,'--json'],{encoding:'utf8'});
  assert.equal(json.status,0,json.stderr);
  const parsed=JSON.parse(json.stdout) as {format:number;routeCount:number};
  assert.equal(parsed.format,1);
  assert.equal(parsed.routeCount,40);
});

test('urlcode report --policy reads the operator policy from outside the project',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'urlcode-report-policy-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const permissions=spawnSync(process.execPath,[cli,'permissions','--project',cookbook],{encoding:'utf8'});
  assert.equal(permissions.status,0,permissions.stderr);
  const file=join(dir,'policy.json');
  await writeFile(file,permissions.stdout);
  const run=spawnSync(process.execPath,[cli,'report','--project',cookbook,'--policy',file,'--json'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const report=JSON.parse(run.stdout) as {policy:boolean;attention:{from:string}[]};
  assert.equal(report.policy,true);
  assert.deepEqual(report.attention.filter(item=>item.from==='policy'),[]);
});

test('with an operator policy the report flags a stale pin and each grant it lacks, by name only',async t=>{
  const root=await project(t,{
    '/a':{env:{REGION:{env:'AWS_REGION'}},secrets:{KEY:{secret:'API_KEY'}},function:{source:'functions/a.mjs'}},
    '/b':{secrets:{KEY:{secret:'API_KEY'}},function:{source:'functions/a.mjs'}},
  },{'functions/a.mjs':'export default () => new Response("ok");\n'});
  const loaded=await loadDocument(root);
  const requested=requestedPermissions(loaded,await prepareFunctionSnapshot(loaded));
  const granted=await buildProjectReport(root,{policy:requested});
  assert.equal(granted.policy,true);
  assert.deepEqual(granted.attention,[]);
  assert.doesNotMatch(renderProjectReport(granted),/No operator policy/);
  const partial=await buildProjectReport(root,{policy:{...requested,routes:{'/a':{secrets:['API_KEY']}}}});
  assert.deepEqual(partial.attention.map(item=>`${item.level} ${item.route} ${item.message}`),[
    'fix /a The operator policy does not grant env AWS_REGION.',
    'fix /b The operator policy does not grant secret API_KEY.',
  ]);
  const stale=await buildProjectReport(root,{policy:{...requested,projectSha256:'0'.repeat(64)}});
  assert.equal(stale.attention.length,1);
  assert.match(stale.attention[0]!.message,/pinned to a different project revision/);
});

test('a project-wide grant release reads as one line per name, and a removed route is not repeated for its code',async t=>{
  const fn={'functions/f.mjs':'export default () => new Response("ok");\n'};
  const withKey=(route:string)=>({secrets:{KEY:{secret:'TOKEN'}},function:{source:'functions/f.mjs'},description:route});
  const before=await project(t,{'/a':withKey('/a'),'/b':withKey('/b'),'/c':withKey('/c')},fn);
  const after=await project(t,{'/a':{function:{source:'functions/f.mjs'}},'/b':{function:{source:'functions/f.mjs'}}},fn);
  const html=renderProjectReport(await buildProjectReport(after,{before:{input:{project:before},label:'before'}}));
  assert.equal(html.match(/No longer asks for secret TOKEN/g)?.length,1);
  assert.match(html,/No longer asks for secret TOKEN on 3 routes/);
  assert.match(html,/Removes <a href="#%2Fc"><code>\/c<\/code><\/a>/);
  assert.doesNotMatch(html,/Removes function/);
});

test('against a project directory the report compares files, so code-only edits and add-on handlers show',async t=>{
  const handler=(text:string)=>`import {greet} from './lib/greet.mjs';\nexport default () => new Response(greet(${JSON.stringify(text)}));\n`;
  const settings={extensions:{tools:{version:'1',config:{handlers:{list:{source:'./functions/tools.mjs'}}}}}};
  const routes={'/a':{function:{source:'functions/a.mjs'}},'/b':{function:{source:'functions/b.mjs'}},'/tools/*':{extension:'tools'}};
  const before=await project(t,routes,{'functions/a.mjs':handler('a'),'functions/b.mjs':handler('b'),'functions/lib/greet.mjs':'export const greet=x=>x;\n',
    'functions/tools.mjs':'export const list=()=>[];\n','notes.txt':'old'},settings);
  const after=await project(t,routes,{'functions/a.mjs':handler('A'),'functions/b.mjs':handler('b'),'functions/lib/greet.mjs':'export const greet=x=>`hi ${x}`;\n',
    'functions/tools.mjs':'export const list=()=>[1];\n','functions/new.mjs':'export default 1;\n'},settings);
  // Dot-entries, node_modules and links are never read.
  await mkdir(join(after,'node_modules/pkg'),{recursive:true});
  await writeFile(join(after,'node_modules/pkg/index.js'),'x');
  await writeFile(join(after,'.env'),'SECRET=1');
  if(process.platform!=='win32')await symlink(join(before,'notes.txt'),join(after,'linked.txt'));
  const report=await buildProjectReport(after,{before:{input:{project:before},label:'main'}});
  assert.deepEqual(report.change?.files,{
    added:['functions/new.mjs'],removed:['notes.txt'],changed:['functions/a.mjs','functions/lib/greet.mjs','functions/tools.mjs'],
    runBy:{'functions/a.mjs':['/a'],'functions/tools.mjs':['/tools/*']},
  });
  assert.deepEqual(report.attention.map(item=>`${item.route??'-'} ${item.message}`),[
    '/a Code changed in functions/a.mjs.',
    '- Code changed in functions/lib/greet.mjs (no route names it).',
    '/tools/* Code changed in functions/tools.mjs.',
  ]);
  const html=renderProjectReport(report);
  assert.match(html,/Changes 3 files: <code>functions\/a\.mjs<\/code>/);
  assert.match(html,/Removes 1 file: <code>notes\.txt<\/code>/);
  assert.match(html,/<tr id="%2Fa" class="route attention changed code"><td><details><summary><code>\/a<\/code> <span class="pill new">code changed<\/span>/);
  assert.match(html,/<label for="show-changed">Changed \(2\)<\/label>/);
  assert.doesNotMatch(html,/node_modules|\.env|linked\.txt/);
  // A YAML BEFORE compares YAML only, and the page says so.
  const yaml=await buildProjectReport(after,{before:{input:{yaml:stringify({version:'1',...settings,routes})},label:'urlcode.yaml'}});
  assert.equal(yaml.change?.files,undefined);
  assert.match(renderProjectReport(yaml),/BEFORE is a YAML file, so only YAML was compared/);
});

test('the page leads with a verdict, marks each route, and shows review findings with their excerpt',async t=>{
  const orders='let count = 0;\nexport default async (request) => {\n  const body = await request.json();\n  if (typeof body.id !== "string") return new Response("<script>", {status: 422});\n  if (body.qty.length > 3) throw new Error("invalid qty");\n  count++;\n  return new Response(String(count));\n};\n';
  const before=await project(t,{'/old':{respond:{text:'old'}},'/orders':{function:{source:'functions/orders.mjs'}}},{'functions/orders.mjs':'export default () => new Response("");\n'});
  const after=await project(t,{'/orders':{function:{source:'functions/orders.mjs'}},'/ping':{respond:{text:'pong'}}},{'functions/orders.mjs':orders});
  const report=await buildProjectReport(after,{before:{input:{project:before},label:'main'}});
  assert(report.review.observations.length>0);
  const html=renderProjectReport(report);
  assert.match(html,new RegExp(`<div class="verdict check"><b>Nothing to fix</b> · ${report.attention.length} items to check before approving\\.</div>`));
  assert.match(html,/<b>2<\/b><span>routes<\/span><span class="muted">1 new · 1 removed<\/span>/);
  assert.match(html,/<tr id="%2Fping" class="route changed">.*<span class="pill new">new<\/span>/);
  assert.match(html,/<tr id="%2Fold" class="route changed removed attention"><td><s><code>\/old<\/code><\/s>/);
  assert.match(html,/<section id="findings"><h2>Code review findings \(\d+\)<\/h2>/);
  assert.match(html,/<pre><code>[^<]*&lt;script&gt;/);
  assert(!/<script/i.test(html));
  // With nothing to report the verdict says so.
  assert.match(renderProjectReport(await buildProjectReport(before)),/<div class="verdict ok"><b>Nothing needs attention\.<\/b><\/div>/);
});
