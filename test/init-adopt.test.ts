import test from 'node:test';import assert from 'node:assert/strict';
import type {TestContext} from 'node:test';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,mkdir,mkdtemp,readFile,readdir,readlink,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {initSite,planInit} from '../packages/core/src/authoring.ts';
import {initSiteWith} from '../packages/core/src/init-with.ts';
import {parseAddonManifest} from '../packages/core/src/addon-manifest.ts';
import type {AddonManifest} from '../packages/core/src/addon-manifest.ts';

// #814: init --adopt creates a site around user files already in the destination, never touching them.
const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
const fixtures=fileURLToPath(new URL('./fixtures/addons/',import.meta.url));
process.env.URLCODE_NPM=join(fixtures,'fake-npm.mjs');
function manifest():AddonManifest {
 return parseAddonManifest({format:1,version:'9.9.9',addons:{alpha:{kind:'extension',package:'@jimhoyd/urlcode-alpha',description:'alpha',requires:[],url:`file:${join(fixtures,'alpha')}`,integrity:null}}},'test manifest');
}
async function directory(t:TestContext):Promise<string> {const dir=await realpath(await mkdtemp(join(tmpdir(),'urlcode adopt '))); t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
/** Every path under a directory, symlinks as their target (never followed), files with mode, mtime and content hash. */
async function snapshot(root:string):Promise<string[]> {
 const out:string[]=[];
 async function walk(dir:string):Promise<void> {
  for(const name of (await readdir(dir)).sort()) {
   const path=join(dir,name),info=await lstat(path);
   if(info.isSymbolicLink())out.push(`${path} -> ${await readlink(path)}`);
   else if(info.isDirectory()){out.push(`${path}/ ${info.mode}`);await walk(path);}
   else out.push(`${path} ${info.size} ${info.mode} ${info.mtimeMs} ${createHash('sha256').update(await readFile(path)).digest('hex')}`);
  }
 }
 await walk(root);return out;
}
/** A prebuilt frontend, a note and a git directory: user work that init writes none of. */
async function frontend(dir:string,name='frontend'):Promise<void> {
 await mkdir(join(dir,name,'dist','assets'),{recursive:true});
 await writeFile(join(dir,name,'dist','index.html'),'<!doctype html><div id="root"></div>');
 await writeFile(join(dir,name,'dist','assets','app.js'),'console.log("spa")');
 await writeFile(join(dir,'notes.txt'),'mine');
 await mkdir(join(dir,'.git'));await writeFile(join(dir,'.git','HEAD'),'ref: refs/heads/main\n');
}
function init(args:string[]) {return spawnSync(process.execPath,['--conditions=development',cli,'init',...args,'--json'],{encoding:'utf8',timeout:20000});}
/** Only the entries init adds: the user's snapshot lines are a subset of the result's, byte for byte. */
async function assertUntouched(before:string[],root:string):Promise<void> {
 const after=new Set(await snapshot(root));
 for(const line of before)assert.ok(after.has(line),`changed or removed: ${line}`);
}

test('an empty or missing destination is initialized exactly as before, with nothing to leave alone',async t=>{
 const root=await directory(t);
 await mkdir(join(root,'empty'));
 for(const name of ['empty','missing']) {
  const {site,leftAlone}=await initSite(join(root,name));
  assert.deepEqual(leftAlone,[]);
  assert.deepEqual((await readdir(site)).sort(),['.gitattributes','.github','.gitignore','.mcp.json','AGENTS.md','Makefile','README.md','app','host.mjs','package.json']);
 }
 // The same files, byte for byte, whatever the starting point: --adopt on an empty directory changes nothing.
 await mkdir(join(root,'adopt-empty'));
 await initSite(join(root,'adopt-empty'),{adopt:true});
 // Paths, modes and content without mtimes; package.json is named after its directory, so it is left out
 // (the snapshot's paths use the platform separator: \\ on Windows).
 const relative=async(dir:string)=>(await snapshot(dir)).map(line=>line.slice(dir.length).split(' ')).filter(fields=>!/^[\\/]package\.json$/.test(fields[0]!)).map(fields=>fields.length===5?[fields[0],fields[1],fields[2],fields[4]].join(' '):fields.join(' '));
 assert.deepEqual(await relative(join(root,'adopt-empty')),await relative(join(root,'empty')));
});

test('a directory holding a frontend is refused without --adopt and adopted with it, every user file untouched',async t=>{
 const site=join(await directory(t),'my site');await mkdir(site);await frontend(site);
 const before=await snapshot(site);
 const plain=init([site]);
 assert.equal(plain.status,1);
 assert.match(plain.stderr+plain.stdout,/already contains frontend, notes\.txt; nothing there collides with what init writes, so add --adopt/);
 assert.deepEqual(await snapshot(site),before,'a refused init writes nothing');
 const adopted=init([site,'--adopt']);
 assert.equal(adopted.status,0,adopted.stderr);
 const event=JSON.parse(adopted.stdout) as {event:string;path:string;leftAlone:string[]};
 assert.equal(event.event,'created');assert.equal(event.path,site);
 assert.deepEqual(event.leftAlone,['.git','frontend','notes.txt']);
 await assertUntouched(before,site);
 for(const file of ['app/urlcode.yaml','host.mjs','package.json','AGENTS.md','.mcp.json','.gitignore','.github/workflows/urlcode.yml'])assert.ok((await lstat(join(site,file))).isFile(),file);
 assert.equal(JSON.parse(await readFile(join(site,'package.json'),'utf8')).name,'my-site');
 // Idempotent: the result is a site, so a second run (adopting or not) finds it and writes nothing.
 const after=await snapshot(site);
 for(const args of [[site,'--adopt'],[site]]) {
  const again=init(args);
  assert.equal(again.status,1);assert.match(again.stderr+again.stdout,/already holds a URLCode site \(app\/urlcode\.yaml\); init writes nothing/);
 }
 assert.deepEqual(await snapshot(site),after);
});

test('any collision with what init writes is refused with every colliding path listed and nothing written',async t=>{
 const root=await directory(t);
 const cases:[string,(dir:string)=>Promise<void>,string[]][]=[
  ['existing app/',async dir=>{await mkdir(join(dir,'app'));},['app']],
  ['existing app file',async dir=>{await writeFile(join(dir,'app'),'x');},['app']],
  ['existing package.json',async dir=>{await writeFile(join(dir,'package.json'),'{"name":"spa","scripts":{"build":"vite build"}}');},['package.json']],
  ['existing host.mjs and README.md',async dir=>{await writeFile(join(dir,'host.mjs'),'export default {}');await writeFile(join(dir,'README.md'),'# mine');},['README.md','host.mjs']],
  ['a file where init needs a directory',async dir=>{await writeFile(join(dir,'.github'),'not a directory');},['.github']],
  ['a directory where init writes a file',async dir=>{await mkdir(join(dir,'Makefile'));await mkdir(join(dir,'.github','workflows','urlcode.yml'),{recursive:true});},['.github/workflows/urlcode.yml','Makefile']],
 ];
 for(const [name,arrange,expected] of cases) {
  const dir=join(root,name);await mkdir(dir);await frontend(dir);await arrange(dir);
  const before=await snapshot(dir);
  const plan=await planInit(dir,{adopt:true});
  assert.deepEqual(plan.collisions,expected,name);
  const result=init([dir,'--adopt']);
  assert.equal(result.status,1,name);
  assert.match(result.stderr+result.stdout,new RegExp(`init --adopt refuses ${expected.map(path=>path.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')).join(', ')}: `),name);
  assert.match(result.stderr+result.stdout,/Nothing was changed/);
  assert.deepEqual(await snapshot(dir),before,`${name}: nothing written`);
  // Without --adopt the refusal says --adopt would not help, naming the same paths.
  const plain=init([dir]);
  assert.match(plain.stderr+plain.stdout,/--adopt would not help here/,name);
  assert.deepEqual(await snapshot(dir),before);
 }
});

test('an existing real directory init writes into is shared, file by file; a symlink is never followed',async t=>{
 const root=await directory(t),outside=join(root,'outside');
 await mkdir(join(outside,'workflows'),{recursive:true});await writeFile(join(outside,'workflows','other.yml'),'on: push');
 const outsideBefore=await snapshot(outside);
 // .github/workflows/ci.yml is the user's; init adds urlcode.yml beside it and changes nothing else.
 const shared=join(root,'shared');await mkdir(join(shared,'.github','workflows'),{recursive:true});await frontend(shared);
 await writeFile(join(shared,'.github','workflows','ci.yml'),'on: pull_request');
 // A symlink to a directory outside is user work init leaves alone and never reads through.
 await symlink(outside,join(shared,'linked'));
 const before=await snapshot(shared);
 const {leftAlone}=await initSite(shared,{adopt:true});
 assert.deepEqual(leftAlone,['.git','.github','frontend','linked','notes.txt']);
 await assertUntouched(before,shared);
 assert.deepEqual((await readdir(join(shared,'.github','workflows'))).sort(),['ci.yml','urlcode.yml']);
 assert.ok((await lstat(join(shared,'linked'))).isSymbolicLink());
 // A symlink where init needs a directory collides even though it points at a directory: init never writes through it.
 const linked=join(root,'linked-github');await mkdir(linked);await frontend(linked);await symlink(outside,join(linked,'.github'));
 const linkedBefore=await snapshot(linked);
 await assert.rejects(initSite(linked,{adopt:true}),/init --adopt refuses \.github: /);
 assert.deepEqual(await snapshot(linked),linkedBefore);
 // So does a dangling symlink at a path init writes.
 const dangling=join(root,'dangling');await mkdir(dangling);await frontend(dangling);await symlink(join(outside,'nowhere'),join(dangling,'host.mjs'));
 await assert.rejects(initSite(dangling,{adopt:true}),/init --adopt refuses host\.mjs: /);
 await assert.rejects(lstat(join(outside,'nowhere')));
 assert.deepEqual(await snapshot(outside),outsideBefore,'nothing outside the destination was written');
});

test('--adopt keeps the nesting guards: never at an app directory or inside an existing project',async t=>{
 const root=await directory(t);
 const app=join(root,'fresh','app');await mkdir(app,{recursive:true});await frontend(app);
 await assert.rejects(initSite(app,{adopt:true}),/nests app\/app/);
 const {site}=await initSite(join(root,'site'));
 const inner=join(site,'app','public');await mkdir(inner);await frontend(inner);
 const before=await snapshot(root);
 await assert.rejects(initSite(inner,{adopt:true}),/inside an existing URLCode project \(\.\.\)/);
 assert.deepEqual(await snapshot(root),before);
});

test('init --with --adopt checks npm\'s paths first and undoes everything when an add-on file lands in an adopted entry',async t=>{
 const root=await directory(t);
 // node_modules and package-lock.json are what npm writes: with user files present they collide before anything is written.
 const modules=join(root,'modules');await mkdir(join(modules,'node_modules'),{recursive:true});await frontend(modules);
 const modulesBefore=await snapshot(modules);
 await assert.rejects(initSiteWith(modules,['alpha'],{adopt:true,manifest:manifest()}),/init --adopt refuses node_modules: /);
 assert.deepEqual(await snapshot(modules),modulesBefore);
 // alpha's scaffold writes data/alpha.key; an existing data/ directory is the user's, so the whole init is undone.
 const data=join(root,'with data');await mkdir(join(data,'data'),{recursive:true});await writeFile(join(data,'data','mine.db'),'rows');await frontend(data);
 const dataBefore=await snapshot(data);
 await assert.rejects(initSiteWith(data,['alpha'],{adopt:true,manifest:manifest()}),/alpha would write data\/alpha\.key, but data was already in the adopted directory/);
 assert.deepEqual(await snapshot(data),dataBefore,'the refused init left nothing behind');
 // With nothing in the way the add-on is installed around the frontend.
 const clean=join(root,'clean');await mkdir(clean);await frontend(clean);
 const cleanBefore=await snapshot(clean);
 const added=await initSiteWith(clean,['alpha'],{adopt:true,manifest:manifest()});
 assert.deepEqual(added.added,['alpha']);assert.deepEqual(added.leftAlone,['.git','frontend','notes.txt']);
 assert.ok((await lstat(join(clean,'data','alpha.key'))).isFile());
 await assertUntouched(cleanBefore,clean);
});
