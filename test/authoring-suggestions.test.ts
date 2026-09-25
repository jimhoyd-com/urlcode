// #722: fixture suggestions and YAML change summaries as public, deterministic authoring tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {parse,stringify} from 'yaml';
import {suggestFixtures,summarizeYamlChange} from '../packages/core/src/agent-context.ts';
import {suggestProjectFixtures} from '../packages/core/src/fixture-suggestions.ts';
import {summarizeChange} from '../packages/core/src/yaml-change.ts';
import {loadDocument} from '../packages/core/src/config.ts';
import {runProjectTests} from '../packages/core/src/project-tests.ts';
import {readFixtures} from '../packages/core/src/readiness.ts';
import {project} from './helpers.ts';
import {Readable,Writable} from 'node:stream';
import {serveMcp} from '../packages/core/src/mcp.ts';

// Every route kind the helper must classify. Runnable as a project once its files exist (no grant-requiring route).
const runnable=`version: "1"
routes:
  /go: {redirect: {url: https://example.com/dest, status: 301}}
  /docs/**: {redirect: {url: "https://docs.example/{**}"}}
  /u/{id}:
    parameters: [{name: id, in: path, required: true, schema: {type: string, enum: [ada, grace]}}]
    redirect: {url: "/profiles/{id}"}
  /search:
    parameters:
      - {name: q, in: query, required: true, schema: {type: string, minLength: 2}}
      - {name: limit, in: query, schema: {type: integer, default: 10, minimum: 1}}
    redirect: {url: https://search.example/, query: {map: {query: {from: query, name: q}, n: {from: query, name: limit}}}}
  /n/{id}:
    parameters: [{name: id, in: path, required: true, schema: {type: string}}, {name: page, in: query, schema: {type: integer}}]
    respond: {json: {kind: item}}
  /status: {respond: {json: {ok: true}}}
  /hello: {methods: [POST], respond: {status: 201, text: hi}, response: {headers: {content-type: text/plain}}}
  /page: {page: {file: index.html}}
  /file: {download: {file: data.txt}}
  /assets/*: {static: {directory: public}}
  /fn: {function: fn.mjs}
  /mw: {respond: {text: x}, middleware: [mw.mjs]}
  /cond:
    conditional:
      cases: [{match: {query: {v: "1"}}, respond: {text: one}}]
      fallback: {respond: {text: other}}
    policies: {cache: false}
  /off: {enabled: false, redirect: {url: https://example.com/}}
  /later: {expires: "2999-01-01T00:00:00Z", redirect: {url: https://example.com/}}
  /bot: {respond: {text: b}, policies: {agents: {deny: [ai-crawlers]}}}
  /code/{c}:
    parameters: [{name: c, in: path, required: true, schema: {type: string, pattern: "^[a-z]+$", maxLength: 8}}]
    redirect: {url: "https://example.com/{c}"}
  /body: {methods: [POST], request: {body: {required: true, maxBytes: 100}}, respond: {text: ok}}
  /hdr:
    parameters: [{name: X-Api-Version, in: header, required: true, schema: {type: integer}}]
    respond: {text: v}
`;
const external=`  /proxy: {proxy: {url: https://upstream.example/}}
  /secret: {function: s.mjs, secrets: {KEY: {secret: API_KEY}}}
  /envred:
    env: {BASE: {env: BASE_URL}}
    redirect: {url: https://example.com/}
  /ext/*: {extension: store}
`;
const everything=runnable+external+'extensions: {store: {version: "1", config: {}}}\n';

test('suggestFixtures generates only determinate cases and names every other route as a gap or for review',()=>{
  const result=suggestFixtures(everything);
  assert.equal(result.format,1);assert.equal(result.scope,'supplied-yaml-only');
  assert.equal(result.fixtures.length,result.cases.length);
  const covered=new Set(result.cases.map(item=>item.route));
  const gapRoutes=Object.fromEntries(result.gaps.map(gap=>[gap.route,gap.codes]));
  assert.deepEqual(gapRoutes,{'/code/{c}':['pattern-constrained'],'/envred':['external-binding'],'/ext/*':['extension'],'/fn':['function'],'/mw':['middleware'],'/proxy':['proxy'],'/secret':['function','external-binding']});
  // Nothing in gaps is ever claimed as covered.
  for(const route of Object.keys(gapRoutes))assert.equal(covered.has(route),false,route);
  assert.deepEqual(Object.fromEntries(result.review.map(entry=>[entry.route,entry.code])),{'/assets/*':'static-directory','/body':'request-body','/bot':'policy','/cond':'conditional','/later':'expires'});
  for(const route of ['/assets/*','/bot','/cond','/later'])assert.equal(covered.has(route),false,route);
  const kinds=(route:string|null)=>result.cases.filter(item=>item.route===route).map(item=>item.kind);
  assert.deepEqual(kinds('/go'),['redirect','method-refusal']);
  assert.deepEqual(kinds('/search'),['redirect','method-refusal','missing-parameter']);
  assert.deepEqual(kinds('/u/{id}'),['redirect','method-refusal','invalid-parameter']);
  assert.deepEqual(kinds('/n/{id}'),['respond','method-refusal','invalid-parameter']);
  assert.deepEqual(kinds('/off'),['disabled']);
  assert.deepEqual(kinds('/body'),['body-required','method-refusal']);
  assert.deepEqual(kinds('/hdr'),['respond','method-refusal','missing-parameter']);
  assert.deepEqual(kinds(null),['unknown-path']);
  const at=(route:string,kind:string)=>result.fixtures[result.cases.findIndex(item=>item.route===route&&item.kind===kind)];
  assert.deepEqual(at('/search','redirect'),{path:'/search?q=sample',status:302,expectHeaders:{location:'https://search.example/?query=sample&n=10'}});
  assert.deepEqual(at('/docs/**','redirect'),{path:'/docs/sample',status:302,expectHeaders:{location:'https://docs.example/sample'}});
  assert.deepEqual(at('/hello','respond'),{path:'/hello',method:'POST',status:201,expectHeaders:{'content-type':'text/plain'},expectBody:'hi'});
  assert.deepEqual(at('/status','method-refusal'),{path:'/status',method:'POST',status:405,expectHeaders:{allow:'GET, HEAD'}});
  assert.deepEqual(at('/n/{id}','invalid-parameter'),{path:'/n/sample?page=not-a-integer',status:400});
});

test('suggested fixtures pass urlcode test against the project they came from',async t=>{
  const root=await project(t,{},{
    'index.html':'<!doctype html><title>x</title>','data.txt':'data','public/a.txt':'a',
    'fn.mjs':'export default () => new Response("fn")','mw.mjs':'export default (request,ctx,next) => next()',
  });
  await writeFile(join(root,'urlcode.yaml'),runnable);
  const result=suggestFixtures(runnable);
  assert.ok(result.fixtures.length>=20);
  await mkdir(join(root,'tests'));
  await writeFile(join(root,'tests/requests.json'),JSON.stringify(result.fixtures,null,2));
  // The shipped fixture schema accepts them as written.
  assert.equal((await readFixtures(root)).length,result.fixtures.length);
  const events:Record<string,unknown>[]=[];
  const outcome=await runProjectTests(root,{log:event=>events.push(event as Record<string,unknown>)});
  assert.deepEqual(outcome,{total:result.fixtures.length,failed:0},JSON.stringify(events.filter(event=>event.pass===false)));
});

test('suggestFixtures is deterministic, bounded and refuses invalid YAML',()=>{
  assert.equal(JSON.stringify(suggestFixtures(everything)),JSON.stringify(suggestFixtures(everything)));
  // Route order in the document does not change the output.
  const document=parse(everything) as {routes:Record<string,unknown>};
  const reordered=stringify({...document,routes:Object.fromEntries(Object.entries(document.routes).reverse())});
  assert.equal(JSON.stringify(suggestFixtures(reordered)),JSON.stringify(suggestFixtures(everything)));
  const many=`version: "1"\nroutes:\n${Array.from({length:300},(_,index)=>`  /r${index}: {redirect: {url: https://example.com/${index}}}`).join('\n')}\n`;
  const bounded=suggestFixtures(many,{maxFixtures:50});
  assert.equal(bounded.fixtures.length,50);assert.equal(bounded.cases.length,50);
  assert.equal(bounded.truncated.fixtures,300*2+1-50);
  assert.equal(suggestFixtures(many,{maxFixtures:100000}).limits.maxFixtures,1000);
  assert.throws(()=>suggestFixtures('version: "1"\nroutes:\n  /a: {nope: 1}\n'),/Invalid URLCode YAML/);
  assert.throws(()=>suggestFixtures('x'.repeat(1048577)),/exceeds 1 MiB/);
});

test('includes and root mounts are never guessed',()=>{
  const included=suggestFixtures('version: "1"\nincludes: [more.yaml]\nroutes:\n  /a: {redirect: {url: https://example.com/}}\n  /p/{x}:\n    parameters: [{name: x, in: path, required: true, schema: {type: string}}]\n    redirect: {url: https://example.com/}\n');
  assert.deepEqual(included.gaps,[{route:'more.yaml',codes:['include'],reason:included.gaps[0]!.reason}]);
  assert.deepEqual(included.cases.map(item=>item.kind),['redirect','method-refusal']);
  assert.deepEqual(included.review.map(entry=>[entry.route,entry.code]),[['/p/{x}','include-shadowing'],['(unmatched path)','unknown-path']]);
  const mounted=suggestFixtures('version: "1"\nroutes:\n  /{slug}:\n    parameters: [{name: slug, in: path, required: true, schema: {type: string}}]\n    redirect: {url: "https://example.com/{slug}"}\n  /__urlcode-fixture/{a}/{b}:\n    parameters: [{name: a, in: path, required: true, schema: {type: string}}, {name: b, in: path, required: true, schema: {type: string}}]\n    respond: {text: x}\n');
  assert.equal(mounted.cases.some(item=>item.kind==='unknown-path'),false);
  assert.equal(mounted.review.at(-1)!.code,'unknown-path');
});

const base=`version: "1"
routes:
  /a: {redirect: {url: https://example.com/secret-destination}}
  /f: {function: f.mjs}
  /m: {respond: {text: x}, middleware: [m.mjs]}
  /s: {function: {source: s.mjs, args: {n: 1}}, sandbox: true}
  /gone: {page: {file: index.html}}
`;
const next=`version: "1"
includes: [more.yaml]
policies: {security: {headers: oshp}}
routes:
  /a: {redirect: {url: https://example.com/other-destination, status: 301}}
  /f: {function: f.mjs, sandbox: true}
  /m: {respond: {text: x}, middleware: [m.mjs, n.mjs]}
  /s: {function: {source: s.mjs, args: {n: 2}}, sandbox: true}
  /new:
    function: new.mjs
    env: {TOKEN: {env: API_TOKEN, default: literal-default-value}}
    secrets: {KEY: {secret: API_KEY}}
    signals: [{url: https://hooks.example/notify}]
  /p: {proxy: {url: https://upstream.example/api}}
  /ext/*: {extension: store}
  /private: {respond: {text: p}, auth: true}
extensions: {store: {version: "1", config: {}}, auth: {version: "1", config: {}}}
`;

test('summarizeYamlChange reports routes, capabilities, code seams, grants and project keys by name only',()=>{
  const summary=summarizeYamlChange(base,next);
  assert.equal(summary.changed,true);
  assert.deepEqual(summary.routes.added.map(entry=>[entry.route,entry.handler,entry.mode]),[['/ext/*','extension','trusted'],['/new','function','trusted'],['/p','proxy','trusted'],['/private','respond','trusted']]);
  assert.deepEqual(summary.routes.removed,[{route:'/gone',handler:'page',mode:'trusted'}]);
  assert.deepEqual(summary.routes.changed.map(entry=>[entry.route,entry.keys]),[['/a',['redirect']],['/f',['sandbox']],['/m',['middleware']],['/s',['function']]]);
  assert.ok(summary.capabilities.added.includes('proxy')&&summary.capabilities.added.includes('extension')&&summary.capabilities.added.includes('policies.security'));
  assert.deepEqual(summary.capabilities.removed,['page']);
  assert.deepEqual(summary.code.added,[{route:'/m',kind:'middleware',source:'n.mjs',export:'default',mode:'trusted'},{route:'/new',kind:'function',source:'new.mjs',export:'default',mode:'trusted'}]);
  assert.deepEqual(summary.code.removed,[]);
  assert.deepEqual(summary.code.argsChanged.map(seam=>seam.route),['/s']);
  assert.deepEqual(summary.code.modeChanged,[{route:'/f',before:'trusted',after:'sandboxed'}]);
  assert.deepEqual([summary.code.trusted,summary.code.sandboxed],[3,2]);
  assert.deepEqual(summary.grants.requested.env,[{route:'/new',name:'API_TOKEN'}]);
  assert.deepEqual(summary.grants.requested.secrets,[{route:'/new',name:'API_KEY'}]);
  assert.deepEqual(summary.grants.requested.egress,[{route:'/new',purpose:'signals',origin:'https://hooks.example'},{route:'/p',purpose:'proxy',origin:'https://upstream.example'}]);
  assert.deepEqual(summary.grants.requested.extensions.map(entry=>[entry.route,entry.via,entry.extension]),[['(project)','declaration','auth'],['(project)','declaration','store'],['/ext/*','mount','store'],['/private','policy','auth']]);
  assert.deepEqual(summary.grants.released,{env:[],secrets:[],egress:[],extensions:[]});
  assert.deepEqual(summary.project,{changed:['extensions','includes','policies'],includes:{added:['more.yaml'],removed:[]}});
  // Names and keys, never values.
  const text=JSON.stringify(summary);
  for(const value of ['secret-destination','other-destination','literal-default-value','/api'])assert.equal(text.includes(value),false,value);
  const reverse=summarizeYamlChange(next,base);
  assert.deepEqual(reverse.grants.released.env,[{route:'/new',name:'API_TOKEN'}]);
  assert.deepEqual(reverse.code.removed.map(seam=>seam.route),['/m','/new']);
});

test('summarizeYamlChange is deterministic, reports no change for identical documents and is bounded',()=>{
  assert.equal(JSON.stringify(summarizeYamlChange(base,next)),JSON.stringify(summarizeYamlChange(base,next)));
  const same=summarizeYamlChange(base,base);
  assert.equal(same.changed,false);assert.deepEqual([same.routes.added,same.routes.removed,same.routes.changed],[[],[],[]]);
  const many=`version: "1"\nroutes:\n${Array.from({length:600},(_,index)=>`  /r${index}: {function: f${index}.mjs}`).join('\n')}\n`;
  const big=summarizeYamlChange('version: "1"\nroutes: {}\n',many);
  assert.equal(big.routes.added.length,200);assert.equal(big.code.added.length,200);
  assert.deepEqual(big.truncated,{'routes.added':400,'code.added':400});
  assert.throws(()=>summarizeYamlChange(base,'version: "2"\nroutes: {}\n'),/Invalid URLCode after YAML/);
});

test('respond bodies above the bound are asserted by status and content type only',()=>{
  const long='x'.repeat(2000);
  const result=suggestFixtures(`version: "1"\nroutes:\n  /big: {respond: {text: ${long}}}\n`);
  assert.deepEqual(result.fixtures[0],{path:'/big',status:200,expectHeaders:{'content-type':'text/plain; charset=utf-8'}});
});

test('CLI: urlcode fixtures suggest and urlcode diff print the same results and refuse bad usage',async t=>{
  const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const root=await project(t,{'/go':{redirect:{url:'https://example.com/'}}});
  const run=(...args:string[])=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:20000});
  const suggested=run('fixtures','suggest','--project',root,'--json');
  assert.equal(suggested.status,0,suggested.stderr);
  assert.deepEqual(JSON.parse(suggested.stdout),await suggestProjectFixtures(root));
  assert.match(run('fixtures','suggest','--project',root).stdout,/^format: 1\n/);
  const before=join(root,'before.yaml');await writeFile(before,'version: "1"\nroutes: {}\n');
  const diff=run('diff',before,'--project',root,'--json');
  assert.equal(diff.status,0,diff.stderr);
  assert.deepEqual(JSON.parse(diff.stdout).routes.added,[{route:'/go',handler:'redirect',mode:'trusted',file:'urlcode.yaml'}]);
  assert.equal(JSON.parse(run('diff',before,before,'--json').stdout).changed,false);
  assert.equal(run('fixtures','--project',root).status,1);
  assert.equal(run('diff','--project',root).status,1);
  assert.equal(run('diff',before,before,before).status,1);
});

type McpReply={result:{content:{text:string}[];isError?:boolean;tools:{name:string;annotations:{readOnlyHint:boolean}}[]}};
const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}};
const ready={jsonrpc:'2.0',method:'notifications/initialized'};
async function session(root:string,messages:unknown[]):Promise<McpReply[]> {
  let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
  await serveMcp({project:root,input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output});
  return text.trim().split('\n').filter(Boolean).map(value=>JSON.parse(value) as McpReply);
}
test('local MCP exposes both helpers as read-only tools over the project urlcode.yaml or supplied YAML',async t=>{
  const root=await project(t,{'/go':{redirect:{url:'https://example.com/'}},'/fn':{function:'fn.mjs'}},{'fn.mjs':'export default () => new Response("x")'});
  const calls=[
    {name:'suggest_fixtures',arguments:{}},
    {name:'suggest_fixtures',arguments:{yaml:'version: "1"\nroutes:\n  /s: {respond: {text: s}}\n',maxFixtures:1}},
    {name:'summarize_yaml_change',arguments:{before:'version: "1"\nroutes: {}\n'}},
    {name:'summarize_yaml_change',arguments:{before:'version: "1"\nroutes: {}\n',after:'version: "1"\nroutes:\n  /p: {proxy: {url: https://upstream.example/}}\n'}},
    {name:'summarize_yaml_change',arguments:{before:'nope: 1'}},
  ];
  const replies=await session(root,[initialize,ready,{jsonrpc:'2.0',id:2,method:'tools/list'},...calls.map((params,index)=>({jsonrpc:'2.0',id:index+3,method:'tools/call',params}))]);
  const tools=replies[1]!.result.tools.filter(tool=>['suggest_fixtures','summarize_yaml_change'].includes(tool.name));
  assert.deepEqual(tools.map(tool=>[tool.name,tool.annotations.readOnlyHint]),[['suggest_fixtures',true],['summarize_yaml_change',true]]);
  const body=(index:number)=>JSON.parse(replies[index]!.result.content[0]!.text);
  assert.deepEqual(body(2).cases.map((item:{route:string})=>item.route),['/go','/go',null]);
  assert.deepEqual(body(2).gaps.map((gap:{route:string})=>gap.route),['/fn']);
  assert.equal(body(3).fixtures.length,1);assert.equal(body(3).truncated.fixtures,2);
  assert.deepEqual(body(4).routes.added.map((entry:{route:string})=>entry.route),['/fn','/go']);
  assert.deepEqual(body(4).code.added.map((seam:{source:string;mode:string})=>[seam.source,seam.mode]),[['fn.mjs','trusted']]);
  assert.deepEqual(body(5).grants.requested.egress,[{route:'/p',purpose:'proxy',origin:'https://upstream.example'}]);
  assert.equal(replies[6]!.result.isError,true);assert.match(replies[6]!.result.content[0]!.text,/Invalid URLCode before YAML/);
});

// #733: project mode reads the project's YAML through the configuration loader, includes and all.
const cookbook=fileURLToPath(new URL('../examples/cookbook',import.meta.url));
test('project mode follows includes: the cookbook, whose routes all live in includes, gets fixtures urlcode test passes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'urlcode-733-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(cookbook,root,{recursive:true});
  const result=await suggestProjectFixtures(root);
  assert.equal(result.scope,'project-yaml');
  const includes=(parse(await readFile(join(root,'urlcode.yaml'),'utf8')) as {includes:string[]}).includes;
  assert.deepEqual(result.files,['urlcode.yaml',...includes]);
  assert.equal(result.gaps.some(gap=>gap.codes.includes('include')),false);
  assert.equal(result.review.some(entry=>entry.code==='include-shadowing'),false);
  assert.ok(result.cases.some(item=>item.kind==='unknown-path'));
  // Included routes are analysed like entry routes, and every route-bound entry names the file that declares it.
  const loaded=await loadDocument(root,{sources:true});
  for(const entry of [...result.cases,...result.gaps,...result.review])if(entry.route!==null&&entry.route!=='site')assert.equal(entry.file,loaded.sources!.routes[entry.route],entry.route);
  assert.ok(result.cases.filter(item=>item.file!==undefined&&item.file!=='urlcode.yaml').length>=10);
  assert.ok(result.cases.some(item=>item.file==='routes/redirects.yaml'&&item.kind==='redirect'));
  assert.ok(result.gaps.some(gap=>gap.file==='routes/code.yaml'&&gap.codes.includes('function')));
  // Deterministic: the same project gives the same bytes.
  assert.equal(JSON.stringify(await suggestProjectFixtures(root)),JSON.stringify(result));
  await writeFile(join(root,'tests/requests.json'),JSON.stringify(result.fixtures,null,2));
  assert.equal((await readFixtures(root)).length,result.fixtures.length);
  const events:Record<string,unknown>[]=[];
  const outcome=await runProjectTests(root,{log:event=>events.push(event as Record<string,unknown>)});
  assert.deepEqual(outcome,{total:result.fixtures.length,failed:0},JSON.stringify(events.filter(event=>event.pass===false)));
  // Text mode over the same entry file is unchanged: every include is a gap and nothing inside it is read.
  const text=suggestFixtures(await readFile(join(root,'urlcode.yaml'),'utf8'));
  assert.equal(text.scope,'supplied-yaml-only');assert.equal(text.files,undefined);assert.equal(text.routeCount,0);
  assert.deepEqual(text.gaps.map(gap=>[gap.route,gap.codes,gap.file]),[...includes].sort().map(include=>[include,['include'],undefined]));
});

test('project mode refuses an include that escapes the root exactly as the loader does',async t=>{
  const outer=await mkdtemp(join(tmpdir(),'urlcode-733-outer-'));t.after(()=>rm(outer,{recursive:true,force:true}));
  const root=join(outer,'app');
  await mkdir(root);
  await writeFile(join(outer,'outside.yaml'),'version: "1"\nroutes:\n  /leak: {respond: {text: leaked}}\n');
  await writeFile(join(root,'urlcode.yaml'),'version: "1"\nincludes: [../outside.yaml]\nroutes:\n  /a: {respond: {text: a}}\n');
  const refusal=await loadDocument(root).then(()=>'loaded',(error:Error)=>error.message);
  assert.match(refusal,/escapes project/);
  await assert.rejects(suggestProjectFixtures(root),(error:Error)=>error.message===refusal);
  await assert.rejects(summarizeChange({project:root},{project:root}),(error:Error)=>error.message===refusal);
  const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const run=spawnSync(process.execPath,[cli,'fixtures','suggest','--project',root,'--json'],{encoding:'utf8',timeout:20000});
  assert.notEqual(run.status,0);assert.doesNotMatch(run.stdout+run.stderr,/leak/);
});

const withIncludes=(target:string):Record<string,string>=>({
  'urlcode.yaml':'version: "1"\nincludes: [routes/store.yaml, routes/fn.yaml]\nroutes:\n  /home: {respond: {text: home}}\n',
  'routes/store.yaml':`version: "1"\nroutes:\n  /shop: {redirect: {url: "${target}"}}\n  /moving: {respond: {text: m}}\n`,
  'routes/fn.yaml':'version: "1"\nroutes:\n  /fn: {function: fn.mjs}\n',
  'fn.mjs':'export default () => new Response("fn")',
});
async function write(root:string,files:Record<string,string>):Promise<void> {
  for(const [file,content] of Object.entries(files)){await mkdir(join(root,file,'..'),{recursive:true});await writeFile(join(root,file),content);}
}
test('diff across two project directories catches a change inside an include and names its file',async t=>{
  const outer=await mkdtemp(join(tmpdir(),'urlcode-733-diff-'));t.after(()=>rm(outer,{recursive:true,force:true}));
  const before=join(outer,'before'), after=join(outer,'after');
  await write(before,withIncludes('https://example.com/old-destination'));
  const next=withIncludes('https://example.com/new-destination');
  // /moving moves from routes/store.yaml to routes/fn.yaml, /fn becomes sandboxed and a new include adds a proxy.
  next['routes/store.yaml']=next['routes/store.yaml']!.replace('  /moving: {respond: {text: m}}\n','');
  next['routes/fn.yaml']='version: "1"\nroutes:\n  /fn: {function: fn.mjs, sandbox: true}\n  /moving: {respond: {text: m}}\n';
  next['urlcode.yaml']=next['urlcode.yaml']!.replace('routes/fn.yaml]','routes/fn.yaml, routes/api.yaml]');
  next['routes/api.yaml']='version: "1"\nroutes:\n  /api/**: {proxy: {url: https://upstream.example/}}\n';
  await write(after,next);
  const summary=await summarizeChange({project:before},{project:after});
  assert.equal(summary.scope,'project-yaml');assert.deepEqual(summary.sides,{before:'project',after:'project'});
  assert.equal(summary.changed,true);assert.equal(summary.routes.unresolved,undefined);
  assert.deepEqual(summary.routes.added,[{route:'/api/**',handler:'proxy',mode:'trusted',file:'routes/api.yaml'}]);
  assert.deepEqual(summary.routes.changed.map(entry=>[entry.route,entry.file,entry.movedFrom,entry.keys]),[
    ['/fn','routes/fn.yaml',undefined,['sandbox']],
    ['/moving','routes/fn.yaml','routes/store.yaml',[]],
    ['/shop','routes/store.yaml',undefined,['redirect']],
  ]);
  assert.deepEqual(summary.code.modeChanged,[{route:'/fn',before:'trusted',after:'sandboxed'}]);
  assert.deepEqual(summary.grants.requested.egress,[{route:'/api/**',purpose:'proxy',origin:'https://upstream.example'}]);
  assert.deepEqual(summary.project.includes,{added:['routes/api.yaml'],removed:[]});
  // Names and keys only: no redirect destination appears.
  assert.doesNotMatch(JSON.stringify(summary),/destination/);
  assert.equal(JSON.stringify(await summarizeChange({project:before},{project:after})),JSON.stringify(summary));
  assert.equal((await summarizeChange({project:before},{project:before})).changed,false);
  // The CLI takes a directory on either side (the after side defaults to --project) and prints the same result.
  const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
  const run=spawnSync(process.execPath,[cli,'diff',before,after,'--json'],{encoding:'utf8',timeout:20000});
  assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),JSON.parse(JSON.stringify(summary)));
  const defaulted=spawnSync(process.execPath,[cli,'diff',before,'--project',after,'--json'],{encoding:'utf8',timeout:20000});
  assert.equal(defaulted.status,0,defaulted.stderr);assert.deepEqual(JSON.parse(defaulted.stdout),JSON.parse(JSON.stringify(summary)));
  // A YAML file against a project: routes in includes the file lists but does not read are set aside, never guessed.
  const mixed=await summarizeChange({yaml:await readFile(join(before,'urlcode.yaml'),'utf8')},{project:after});
  assert.equal(mixed.scope,'mixed');assert.deepEqual(mixed.sides,{before:'yaml',after:'project'});
  assert.deepEqual(mixed.routes.added.map(entry=>[entry.route,entry.file]),[['/api/**','routes/api.yaml']]);
  assert.deepEqual(mixed.routes.unresolved,[
    {route:'/fn',file:'routes/fn.yaml',side:'after'},{route:'/moving',file:'routes/fn.yaml',side:'after'},{route:'/shop',file:'routes/store.yaml',side:'after'},
  ]);
  assert.deepEqual(mixed.code.added,[]);
  // Two YAML texts keep the text-only shape exactly.
  const text=summarizeYamlChange(await readFile(join(before,'urlcode.yaml'),'utf8'),await readFile(join(after,'urlcode.yaml'),'utf8'));
  assert.equal(text.scope,'supplied-yaml-only');assert.equal('sides' in text,false);assert.equal('unresolved' in text.routes,false);
  assert.deepEqual(text.routes.changed,[]);
});

test('local MCP reads the project with its includes when no YAML is supplied, and supplied YAML stays text-only',async t=>{
  const root=await mkdtemp(join(tmpdir(),'urlcode-733-mcp-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await write(root,withIncludes('https://example.com/'));
  const replies=await session(root,[initialize,ready,
    {jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'suggest_fixtures',arguments:{}}},
    {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'suggest_fixtures',arguments:{yaml:await readFile(join(root,'urlcode.yaml'),'utf8')}}},
    {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'summarize_yaml_change',arguments:{before:'version: "1"\nroutes: {}\n'}}},
  ]);
  const body=(index:number)=>JSON.parse(replies[index]!.result.content[0]!.text);
  assert.deepEqual(body(1),JSON.parse(JSON.stringify(await suggestProjectFixtures(root))));
  assert.ok(body(1).cases.some((item:{route:string;file:string})=>item.route==='/shop'&&item.file==='routes/store.yaml'));
  assert.deepEqual(body(1).gaps.map((gap:{route:string;file:string})=>[gap.route,gap.file]),[['/fn','routes/fn.yaml']]);
  assert.deepEqual(body(2).gaps.map((gap:{route:string;codes:string[]})=>[gap.route,gap.codes]),[['routes/fn.yaml',['include']],['routes/store.yaml',['include']]]);
  assert.equal(body(3).scope,'mixed');
  assert.deepEqual(body(3).routes.added.map((entry:{route:string;file:string})=>[entry.route,entry.file]),[['/fn','routes/fn.yaml'],['/home','urlcode.yaml'],['/moving','routes/store.yaml'],['/shop','routes/store.yaml']]);
});
