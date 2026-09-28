import test from 'node:test';import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,readdir,realpath,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable,Writable} from 'node:stream';
import {buildBootstrap,bootstrapMaxCapabilities} from '../packages/core/src/bootstrap.ts';
import type {Bootstrap} from '../packages/core/src/bootstrap.ts';
import {getSchemaFragment} from '../packages/core/src/schema-query.ts';
import {localInvocation,shellWord} from '../packages/core/src/context.ts';
import {serveMcp} from '../packages/core/src/mcp.ts';

// #807: the local agent bootstrap composes init, context's quoting and the capability catalog.
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
const version=(JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string}).version;
const schemaSha256=createHash('sha256').update(await readFile(new URL('../schemas/urlcode.schema.json',import.meta.url))).digest('hex');
async function directory(t:TestContext,name='urlcode bootstrap '):Promise<string> {const dir=await realpath(await mkdtemp(join(tmpdir(),name)));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
/** Every path under a directory with its size, mode, mtime and content hash: any write shows up. */
async function snapshot(root:string):Promise<string[]> {
 const out:string[]=[];
 async function walk(dir:string):Promise<void> {
  for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
   const path=join(dir,entry.name),info=await stat(path);
   if(entry.isDirectory()){out.push(`${path}/ ${info.mtimeMs}`);await walk(path);}
   else out.push(`${path} ${info.size} ${info.mode} ${info.mtimeMs} ${createHash('sha256').update(await readFile(path)).digest('hex')}`);
  }
 }
 await walk(root);return out;
}
/** init's host.mjs imports the installed runtime, which these temporary sites do not have: an inert host stands in. */
const inertHost=(site:string)=>writeFile(join(site,'host.mjs'),'export default {plugins: [], extensions: []};');
function run(args:string[],cwd?:string) {return spawnSync(process.execPath,['--conditions=development',cli,...args],{encoding:'utf8',...(cwd?{cwd}:{})});}
function runJson(args:string[],cwd?:string):Bootstrap {const result=run([...args,'--json'],cwd);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout) as Bootstrap;}
// The emitted commands are POSIX shell text; Windows runners have no /bin/sh (the same skip as test/context-commands.test.ts).
const posixShell=process.platform!=='win32';
/** Runs an emitted command through a POSIX shell after its `cd`, with this checkout's CLI standing in for the site-local one. */
function runEmitted(bootstrap:Bootstrap,name:string) {
 const command=bootstrap.commands![name]!;
 assert.ok(command.startsWith(`${localInvocation} `),command);
 return spawnSync('/bin/sh',['-c',`${bootstrap.commands!.cd} && ${shellWord(process.execPath)} --conditions=development ${shellWord(cli)} ${command.slice(localInvocation.length+1)}`],{encoding:'utf8',cwd:tmpdir()});
}

test('an empty directory is inspected, never created into, and names the explicit create command',async t=>{
 const empty=await directory(t);
 const before=await snapshot(empty);
 const result=runJson(['bootstrap','--capabilities','respond'],empty);
 assert.equal(result.state,'none');assert.equal(result.site,null);
 assert.deepEqual(await snapshot(empty),before);assert.deepEqual(await readdir(empty),[]);
 assert.match(result.next[0]!,new RegExp(`bootstrap --create ${shellWord(empty).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`));
 // The packet still arrives with no site: it is the running runtime's contract.
 assert.equal(result.capabilities!.packet[0]!.name,'respond');
 assert.equal(result.runtime.status,'unverified');
 // --create needs a destination the caller named.
 const refused=run(['bootstrap','--create'],empty);
 assert.notEqual(refused.status,0);assert.match(refused.stderr,/explicit destination/);
 assert.deepEqual(await readdir(empty),[]);
 // A directory that does not exist yet is not created either.
 assert.equal((await buildBootstrap(join(empty,'later'))).state,'none');
 assert.deepEqual(await readdir(empty),[]);
});

test('--create with an explicit destination creates one site once; repeating it changes nothing',async t=>{
 const root=await directory(t),site=join(root,'my site');
 const first=runJson(['bootstrap',site,'--create']);
 assert.equal(first.state,'created');
 assert.ok(first.created!.includes('app')&&first.created!.includes('host.mjs')&&first.created!.includes('package.json'));
 assert.deepEqual(first.site,{root:site,layout:'site',project:'app',projectRoot:join(site,'app'),entry:'app/urlcode.yaml',hostFile:'host.mjs',packageJson:'package.json'});
 assert.equal(first.runtime.pinned,version);assert.equal(first.runtime.status,'matched');
 assert.equal(first.commands!.install,'npm install');
 await inertHost(site);
 const before=await snapshot(root);
 for(const args of [['bootstrap',site,'--create'],['bootstrap',site],['bootstrap','.','--create'],['bootstrap','app','--create']]) {
  const again=runJson(args,site);
  assert.equal(again.state,'existing',args.join(' '));assert.equal(again.created,undefined);
  assert.equal(again.site!.root,site);assert.equal(again.site!.projectRoot,join(site,'app'));
 }
 assert.deepEqual(await snapshot(root),before);
 await assert.rejects(stat(join(site,'app','app')));
 // The emitted validate and test run from the site root although its path has a space.
 if(posixShell)for(const name of ['validate','test']) {const emitted=runEmitted(first,name);assert.equal(emitted.status,0,`${name}: ${emitted.stderr}`);}
});

test('creation is refused where it would nest a site: at an app directory or inside a project',async t=>{
 const root=await directory(t);
 await assert.rejects(buildBootstrap(join(root,'fresh','app'),{create:true}),/nests app\/app/);
 await assert.rejects(stat(join(root,'fresh')));
 const site=join(root,'site');await buildBootstrap(site,{create:true});
 const before=await snapshot(root);
 await assert.rejects(buildBootstrap(join(site,'app','public'),{create:true}),/inside an existing URLCode project \(\.\.\)/);
 assert.deepEqual(await snapshot(root),before);
 // Inspecting from inside the project points back at the site instead of offering to create.
 await mkdir(join(site,'app','public'));
 const inside=await buildBootstrap(join(site,'app','public'));
 assert.equal(inside.state,'none');assert.equal(inside.diagnostics![0]!.code,'inside-project');
 // A directory holding user files is left to init's own refusal, and keeps every file.
 const occupied=join(root,'occupied');await mkdir(occupied);await writeFile(join(occupied,'notes.txt'),'mine');
 await assert.rejects(buildBootstrap(occupied,{create:true}),/already contains notes\.txt/);
 assert.deepEqual(await readdir(occupied),['notes.txt']);
});

test('an existing site is found from its root and from app/, with a supplied frontend mapped onto the project',async t=>{
 const site=join(await directory(t),'site');await buildBootstrap(site,{create:true});await inertHost(site);
 await mkdir(join(site,'frontend','dist'),{recursive:true});await writeFile(join(site,'frontend','dist','index.html'),'<h1>spa</h1>');
 await mkdir(join(site,'app','public'));await writeFile(join(site,'app','public','index.html'),'<h1>hi</h1>');
 const fromRoot=await buildBootstrap(site),fromProject=await buildBootstrap(join(site,'app'));
 assert.deepEqual(fromProject,fromRoot);
 assert.equal(fromRoot.state,'existing');
 assert.deepEqual(fromRoot.paths!.example,{onDisk:'app/public',yaml:'public',declaration:'/public/*: {static: {directory: public}}'});
 assert.match(fromRoot.paths!.rule,/relative to the route project root app\//);
 assert.deepEqual(fromRoot.paths!.outsideProject.map(item=>item.path),['frontend']);
 assert.match(fromRoot.paths!.outsideProject[0]!.note,/into app\/frontend and reference them as frontend; operator code, credentials and data stay outside/);
 // Nothing outside the site is named.
 for(const value of [fromRoot.site!.root,fromRoot.site!.projectRoot])assert.ok(value.startsWith(site));
 // The mapping holds: a static route naming `public` validates; one naming the site-relative path does not.
 await writeFile(join(site,'app','urlcode.yaml'),'version: "1"\nroutes:\n  /public/*: {static: {directory: public, index: index.html}}\n');
 // Checked through the emitted command where a POSIX shell exists, otherwise through the CLI with the same arguments.
 const validate=():number|null=>posixShell?runEmitted(fromRoot,'validate').status:run(['validate','--local','--project','app','--host-file','host.mjs'],site).status;
 assert.equal(validate(),0);
 await writeFile(join(site,'app','urlcode.yaml'),'version: "1"\nroutes:\n  /public/*: {static: {directory: app/public}}\n');
 assert.notEqual(validate(),0);
 // --origin reaches the commands, quoted; a project that no longer loads is a diagnostic, not a crash.
 const withOrigin=await buildBootstrap(site,{origin:'https://example.test'});
 assert.ok(withOrigin.commands!.start!.endsWith('--origin https://example.test'));
 await writeFile(join(site,'app','urlcode.yaml'),'version: "1"\nroutes:\n  /x: {nope: true}\n');
 const broken=await buildBootstrap(site);
 assert.equal(broken.diagnostics![0]!.code,'project-invalid');
});

test('a bare project directory is its own site root with no host file',async t=>{
 const project=await directory(t);await writeFile(join(project,'urlcode.yaml'),'version: "1"\nroutes: {}\n');
 const result=await buildBootstrap(project);
 assert.equal(result.site!.layout,'project');assert.equal(result.site!.project,'.');assert.equal(result.site!.entry,'urlcode.yaml');assert.equal(result.site!.hostFile,null);
 assert.equal(result.commands!.validate,'urlcode validate --local --project .');
 assert.deepEqual(result.paths!.outsideProject,[]);
});

test('the capability packet is the running revision\'s contract, bounded, with unknown and refused names reported',async t=>{
 const result=await buildBootstrap(await directory(t),{capabilities:['respond','static','redirect','auth','made-up'],target:'cloudflare'});
 assert.equal(result.urlcode,version);assert.equal(result.runtime.running.version,version);assert.equal(result.runtime.running.schemaSha256,schemaSha256);
 const packet=result.capabilities!;
 assert.deepEqual(packet.packet.map(entry=>entry.name),['respond','static','redirect']);
 for(const entry of packet.packet) {
  for(const fragment of entry.schema)assert.deepEqual(fragment.schema,getSchemaFragment(fragment.path).schema);
  assert.deepEqual(Object.keys(entry.targets),['cloudflare']);
  assert.ok(entry.example===null||entry.example.yaml.length<=1500);
 }
 assert.match(packet.packet[0]!.example!.yaml,/respond:/);
 assert.deepEqual(packet.unknown.map(item=>item.name),['auth','made-up']);
 assert.deepEqual(packet.unsupported.map(item=>[item.name,item.support]),[['static','refused']]);
 await assert.rejects(buildBootstrap('.',{capabilities:Array.from({length:bootstrapMaxCapabilities+1},(_,index)=>`c${index}`)}),/at most 8/);
 await assert.rejects(buildBootstrap('.',{target:'mars'}),/Unknown capability target/);
});

test('a site whose installed runtime differs gets the mismatch reported and the packet withheld',async t=>{
 const site=join(await directory(t),'site');await buildBootstrap(site,{create:true});
 const installed=join(site,'node_modules','@jimhoyd','urlcode');await mkdir(join(installed,'schemas'),{recursive:true});
 await writeFile(join(installed,'package.json'),JSON.stringify({name:'@jimhoyd/urlcode',version:'0.0.1'}));
 await writeFile(join(installed,'schemas','urlcode.schema.json'),'{}');
 const mismatched=await buildBootstrap(site,{capabilities:['respond']});
 assert.equal(mismatched.runtime.status,'mismatched');assert.equal(mismatched.runtime.installed!.version,'0.0.1');
 assert.deepEqual(mismatched.capabilities!.packet,[]);assert.match(mismatched.capabilities!.withheld!,/does not match/);
 assert.equal(mismatched.commands!.install,undefined);
 // Same version, same schema bytes: matched.
 await writeFile(join(installed,'package.json'),JSON.stringify({name:'@jimhoyd/urlcode',version}));
 await writeFile(join(installed,'schemas','urlcode.schema.json'),await readFile(new URL('../schemas/urlcode.schema.json',import.meta.url)));
 const matched=await buildBootstrap(site,{capabilities:['respond']});
 assert.equal(matched.runtime.status,'matched');assert.equal(matched.capabilities!.packet.length,1);
});

test('MCP get_context bootstrap returns the same read-only bootstrap for the server\'s site',async t=>{
 const site=join(await directory(t),'site');await buildBootstrap(site,{create:true});
 const before=await snapshot(site);
 const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'test',version:'1'}}};
 const calls=[{name:'get_context',arguments:{bootstrap:true,capabilities:['respond','nope']}},{name:'get_context',arguments:{capabilities:['respond']}}];
 const messages=[initialize,{jsonrpc:'2.0',method:'notifications/initialized'},...calls.map((params,index)=>({jsonrpc:'2.0',id:index+2,method:'tools/call',params}))];
 let text='';const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}});
 await serveMcp({project:join(site,'app'),input:Readable.from([messages.map(value=>JSON.stringify(value)+'\n').join('')]),output});
 const replies=text.trim().split('\n').map(line=>JSON.parse(line) as {result:{content:{text:string}[];isError?:boolean}}).slice(1);
 assert.equal(replies[0]!.result.isError,undefined,replies[0]!.result.content[0]!.text);
 const result=JSON.parse(replies[0]!.result.content[0]!.text) as Bootstrap;
 assert.deepEqual(result,await buildBootstrap(site,{capabilities:['respond','nope']}));
 assert.equal(result.site!.root,site);
 assert.equal(replies[1]!.result.isError,true);assert.match(replies[1]!.result.content[0]!.text,/only with bootstrap/);
 assert.deepEqual(await snapshot(site),before);
});

test('--create --adopt builds the site around a supplied frontend, moves nothing, and a repeat changes nothing (#814)',async t=>{
 const root=await directory(t),site=join(root,'my frontend');
 await mkdir(join(site,'frontend','dist'),{recursive:true});await writeFile(join(site,'frontend','dist','index.html'),'<h1>spa</h1>');
 await mkdir(join(site,'dist'));await writeFile(join(site,'dist','app.js'),'console.log(1)');
 const before=await snapshot(site);
 // Inspecting names the adopting command; plain --create is refused by init and says to add --adopt.
 const inspected=runJson(['bootstrap',site]);
 assert.equal(inspected.state,'none');
 assert.match(inspected.next[0]!,new RegExp(`already holds dist, frontend, none of which collides .*bootstrap --create ${shellWord(site).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} --adopt$`));
 const plain=run(['bootstrap',site,'--create']);
 assert.notEqual(plain.status,0);assert.match(plain.stderr,/add --adopt/);
 assert.deepEqual(await snapshot(site),before);
 assert.match(run(['bootstrap',site,'--adopt']).stderr,/--adopt is only supported by init and bootstrap --create/);
 const created=runJson(['bootstrap',site,'--create','--adopt']);
 assert.equal(created.state,'created');assert.deepEqual(created.leftAlone,['dist','frontend']);
 assert.ok(!created.created!.includes('frontend')&&created.created!.includes('app')&&created.created!.includes('host.mjs'));
 assert.equal(created.site!.root,site);assert.equal(created.site!.projectRoot,join(site,'app'));
 // The supplied directories stay where they are; the mapping says how to serve them.
 assert.deepEqual(created.paths!.outsideProject.map(item=>item.path),['dist','frontend']);
 assert.match(created.paths!.outsideProject[1]!.note,/build or copy those into app\/frontend and reference them as frontend/);
 const after=await snapshot(site);
 for(const line of before)assert.ok(after.includes(line),`changed: ${line}`);
 for(const args of [['bootstrap',site,'--create','--adopt'],['bootstrap',site,'--create'],['bootstrap',site]]) {
  const again=runJson(args);
  assert.equal(again.state,'existing',args.join(' '));assert.equal(again.created,undefined);assert.equal(again.leftAlone,undefined);
 }
 assert.deepEqual(await snapshot(site),after);
 await assert.rejects(stat(join(site,'app','app')));
});
