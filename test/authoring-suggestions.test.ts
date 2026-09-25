// #722: fixture suggestions and YAML change summaries as public, deterministic authoring tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {parse,stringify} from 'yaml';
import {suggestFixtures,summarizeYamlChange} from '../packages/core/src/agent-context.ts';
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
  assert.deepEqual(JSON.parse(suggested.stdout),suggestFixtures(await readFile(join(root,'urlcode.yaml'),'utf8')));
  assert.match(run('fixtures','suggest','--project',root).stdout,/^format: 1\n/);
  const before=join(root,'before.yaml');await writeFile(before,'version: "1"\nroutes: {}\n');
  const diff=run('diff',before,'--project',root,'--json');
  assert.equal(diff.status,0,diff.stderr);
  assert.deepEqual(JSON.parse(diff.stdout).routes.added,[{route:'/go',handler:'redirect',mode:'trusted'}]);
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
