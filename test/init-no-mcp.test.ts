import test from 'node:test';import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {initSite} from '../packages/core/src/authoring.ts';
import {renderMcpConfig} from '../packages/core/src/agents-guide.ts';
import {describeError} from '../packages/core/src/errors.ts';
import {systemErrorMessages} from '../packages/core/src/cli-errors.ts';

// #825: an agent sandbox that forbids writing MCP client configuration. The refusal is injected by a preload that
// makes fs/promises `open` throw EPERM for one file name, the same code the sandbox returns; it does not depend on
// chmod, ownership or running as root, so it behaves the same on Linux, macOS and Windows.
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
async function directory(t:TestContext):Promise<string> {const dir=await realpath(await mkdtemp(join(tmpdir(),'urlcode no-mcp '))); t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function snapshot(root:string):Promise<string[]> {
 const out:string[]=[];
 async function walk(dir:string):Promise<void> {
  for(const name of (await readdir(dir)).sort()) {
   const path=join(dir,name),info=await lstat(path);
   if(info.isDirectory()){out.push(`${path}/ ${info.mode}`);await walk(path);}
   else out.push(`${path} ${info.size} ${info.mode} ${info.mtimeMs} ${createHash('sha256').update(await readFile(path)).digest('hex')}`);
  }
 }
 await walk(root);return out;
}
/** A preload that denies opening any file with this base name, as a sandbox does. */
async function denying(t:TestContext,name:string):Promise<string> {
 const dir=await directory(t),preload=join(dir,'deny.mjs');
 await writeFile(preload,`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {basename} from 'node:path';
const open=fs.open;
fs.open=async(path,...rest)=>{if(basename(String(path))===${JSON.stringify(name)})throw Object.assign(new Error('EPERM: operation not permitted, open '+String(path)),{code:'EPERM',syscall:'open',path:String(path)});return open(path,...rest);};
syncBuiltinESMExports();\n`);
 return pathToFileURL(preload).href;
}
function run(args:string[],{preload,cwd}:{preload?:string;cwd?:string}={}) {
 return spawnSync(process.execPath,['--conditions=development',...(preload?['--import',preload]:[]),cli,...args],{encoding:'utf8',timeout:30000,...(cwd?{cwd}:{})});
}
function errorLine(stderr:string):{event:string;message:string;code?:string;file?:string} {return JSON.parse(stderr.trim().split('\n').pop()!) as {event:string;message:string;code?:string;file?:string};}
const mcpDenied='init could not finish writing .mcp.json: the operating system or a sandbox policy refused it (EPERM, operation not permitted). Everything this run created was removed and existing files were left as they were; .mcp.json is MCP client configuration, which this environment does not allow init to write; rerun with --no-mcp to create the site without it (register the server with your client separately, see urlcode mcp print-config)';

test('EPERM on .mcp.json names the operation and relative path, suggests --no-mcp and leaves nothing behind',async t=>{
 const root=await directory(t),preload=await denying(t,'.mcp.json'),site=join(root,'new site');
 const result=run(['init',site,'--json'],{preload});
 assert.equal(result.status,1,result.stdout);
 const error=errorLine(result.stderr);
 assert.equal(error.message,mcpDenied);
 assert.equal(error.code,'init-write-denied');assert.equal(error.file,'.mcp.json');
 assert.ok(!result.stderr.includes(root),'no absolute host path in the diagnostic');
 assert.doesNotMatch(error.message,/chmod|sudo|sandbox off|disable|dangerously/i);
 await assert.rejects(lstat(site),/ENOENT/,'a new destination is removed whole');
 // bootstrap --create delegates to init and reports the same refusal.
 const bootstrap=run(['bootstrap',site,'--create','--json'],{preload});
 assert.equal(bootstrap.status,1);assert.equal(errorLine(bootstrap.stderr).message,mcpDenied);
 await assert.rejects(lstat(site),/ENOENT/);
});

test('EPERM rolls back only this run: an in-place package.json and an adopted directory are exactly as before',async t=>{
 const root=await directory(t),preload=await denying(t,'.mcp.json');
 const inPlace=join(root,'in place');await mkdir(join(inPlace,'.git'),{recursive:true});
 await writeFile(join(inPlace,'package.json'),'{\n  "name": "mine",\n  "scripts": { "test": "echo mine" }\n}\n');
 await writeFile(join(inPlace,'.git','HEAD'),'ref: refs/heads/main\n');
 const adopted=join(root,'adopted');await mkdir(join(adopted,'frontend'),{recursive:true});await mkdir(join(adopted,'.claude'));
 await writeFile(join(adopted,'frontend','index.html'),'<h1>spa</h1>');await writeFile(join(adopted,'.claude','settings.json'),'{"permissions":{}}\n');
 for(const [site,args] of [[inPlace,[]],[adopted,['--adopt']]] as const) {
  const before=await snapshot(site);
  const result=run(['init',site,...args,'--json'],{preload});
  assert.equal(result.status,1,result.stdout);
  assert.equal(errorLine(result.stderr).message,mcpDenied);
  assert.deepEqual(await snapshot(site),before,`${site} changed`);
 }
 const bootstrap=run(['bootstrap',adopted,'--create','--adopt','--json'],{preload});
 assert.equal(bootstrap.status,1);
 assert.ok((await readdir(adopted)).sort().join()==='.claude,frontend');
});

test('EPERM on a site file names that file and never suggests --no-mcp',async t=>{
 const root=await directory(t),preload=await denying(t,'host.mjs'),site=join(root,'site');
 const result=run(['init',site,'--json'],{preload});
 assert.equal(result.status,1);
 const error=errorLine(result.stderr);
 assert.equal(error.message,'init could not finish writing host.mjs: the operating system or a sandbox policy refused it (EPERM, operation not permitted). Everything this run created was removed and existing files were left as they were; choose a destination this process is allowed to write to');
 assert.equal(error.file,'host.mjs');assert.ok(!result.stderr.includes(root));
 await assert.rejects(lstat(site),/ENOENT/);
});

test('init --no-mcp creates a runnable site with no .mcp.json and says registration was skipped',async t=>{
 const root=await directory(t),site=join(root,'site');
 // Even where the sandbox denies .mcp.json, --no-mcp never tries to write it.
 const result=run(['init',site,'--no-mcp','--json'],{preload:await denying(t,'.mcp.json')});
 assert.equal(result.status,0,result.stderr);
 const event=JSON.parse(result.stdout) as Record<string,unknown>;
 assert.equal(event.event,'created');assert.equal(event.mcpRegistration,'skipped');
 assert.match(String(event.mcpNote),/^no \.mcp\.json was written, so no MCP client has the urlcode server/);
 assert.deepEqual((await readdir(site)).sort(),['.gitattributes','.github','.gitignore','AGENTS.md','Makefile','README.md','app','host.mjs','package.json']);
 for(const args of [['validate','--local'],['test']]) {const checked=run(args,{cwd:site});assert.equal(checked.status,0,checked.stdout+checked.stderr);}
 // Default init is unchanged: .mcp.json is written and the output carries no skipped field.
 const plain=run(['init',join(root,'plain'),'--json']);
 assert.equal(plain.status,0,plain.stderr);
 assert.deepEqual(Object.keys(JSON.parse(plain.stdout) as object),['event','path','nextSteps']);
 assert.equal(await readFile(join(root,'plain','.mcp.json'),'utf8'),renderMcpConfig('app',{local:true}));
 // The API form.
 const {site:api}=await initSite(join(root,'api'),{mcp:false});
 await assert.rejects(lstat(join(api,'.mcp.json')),/ENOENT/);
});

test('--no-mcp leaves existing agent configuration untouched, in place and adopting',async t=>{
 const root=await directory(t),registered='{"mcpServers":{"mine":{"command":"mine"}}}\n';
 const inPlace=join(root,'in place');await mkdir(inPlace);await writeFile(join(inPlace,'.mcp.json'),registered);
 const adopted=join(root,'adopted');await mkdir(join(adopted,'.claude'),{recursive:true});
 await writeFile(join(adopted,'.mcp.json'),registered);await writeFile(join(adopted,'.claude','settings.json'),'{"permissions":{}}\n');
 for(const [site,args] of [[inPlace,[]],[adopted,['--adopt']]] as const) {
  const before=await snapshot(site);
  const result=run(['init',site,'--no-mcp',...args,'--json']);
  assert.equal(result.status,0,result.stderr);
  assert.equal((JSON.parse(result.stdout) as {mcpRegistration?:string}).mcpRegistration,'skipped');
  const after=new Set(await snapshot(site));
  for(const line of before)assert.ok(after.has(line),`changed: ${line}`);
  assert.equal(await readFile(join(site,'.mcp.json'),'utf8'),registered);
 }
});

test('bootstrap --create --no-mcp, alone and with --adopt, creates the site without .mcp.json',async t=>{
 const root=await directory(t);
 const fresh=join(root,'fresh');
 const created=run(['bootstrap',fresh,'--create','--no-mcp','--json']);
 assert.equal(created.status,0,created.stderr);
 const packet=JSON.parse(created.stdout) as {state:string;created:string[];mcpRegistration?:string;mcpNote?:string};
 assert.equal(packet.state,'created');assert.equal(packet.mcpRegistration,'skipped');assert.match(packet.mcpNote!,/no \.mcp\.json was written/);
 assert.ok(packet.created.includes('app')&&!packet.created.includes('.mcp.json'));
 const adopted=join(root,'adopted');await mkdir(join(adopted,'frontend'),{recursive:true});await mkdir(join(adopted,'.claude'));
 await writeFile(join(adopted,'.claude','settings.json'),'{}\n');
 const before=await snapshot(adopted);
 const both=run(['bootstrap',adopted,'--create','--adopt','--no-mcp','--json']);
 assert.equal(both.status,0,both.stderr);
 const adoptedPacket=JSON.parse(both.stdout) as {state:string;leftAlone:string[];mcpRegistration?:string};
 assert.equal(adoptedPacket.state,'created');assert.equal(adoptedPacket.mcpRegistration,'skipped');
 assert.deepEqual(adoptedPacket.leftAlone,['.claude','frontend']);
 await assert.rejects(lstat(join(adopted,'.mcp.json')),/ENOENT/);
 const after=new Set(await snapshot(adopted));
 for(const line of before)assert.ok(after.has(line),`changed: ${line}`);
 // Default bootstrap --create still writes .mcp.json and reports nothing skipped.
 const plain=JSON.parse(run(['bootstrap',join(root,'plain'),'--create','--json']).stdout) as {created:string[];mcpRegistration?:string};
 assert.ok(plain.created.includes('.mcp.json'));assert.equal(plain.mcpRegistration,undefined);
 // An existing site is never re-created, so nothing claims a skip.
 assert.equal((JSON.parse(run(['bootstrap',fresh,'--create','--no-mcp','--json']).stdout) as {mcpRegistration?:string}).mcpRegistration,undefined);
});

test('--no-mcp is refused outside init and bootstrap --create',async t=>{
 const root=await directory(t);
 for(const args of [['bootstrap',root,'--no-mcp'],['validate','--no-mcp'],['mcp','print-config','--no-mcp']]) {
  const result=run(args);
  assert.equal(result.status,1,args.join(' '));
  assert.match(errorLine(result.stderr).message,/--no-mcp is only supported by init and bootstrap --create/);
 }
});

test('EPERM and EROFS have a fixed, bounded message in both system error maps',()=>{
 for(const code of ['EPERM','EROFS']) {
  const error=Object.assign(new Error(`${code}: open /Users/someone/secret/.mcp.json`),{code});
  const message=describeError(error);
  assert.equal(message,systemErrorMessages[code]);
  assert.ok(!message.includes('/Users/')&&message.length<200);
  assert.doesNotMatch(message,/chmod|sudo|disable/i);
 }
});
