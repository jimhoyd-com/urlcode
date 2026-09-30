// `urlcode recipes add <name> --project <dir>` merges a recipe into an existing project (#1014). The store recipes,
// which need the auth and store extensions, are merged into a site and run in packages/store/test/recipe-*.test.ts
// and, through a real `init` and `extensions add`, in test/addons.integration.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,cp,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {TestContext} from 'node:test';
import {mergeRecipe} from '../packages/core/src/recipe-merge.ts';
import type {RecipeMergeReport} from '../packages/core/src/recipe-merge.ts';

const cli=fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
const starter=fileURLToPath(new URL('../starters/default/app/',import.meta.url));
const {PROJECT_SHA256:_pin,URLCODE_ORIGIN:_origin,URLCODE_POLICY:_policy,...env}=process.env;

/** A site's app/ as `urlcode init` writes it: the default starter, with its committed zero route count. */
async function site(t: TestContext): Promise<{root: string; app: string}> {
  const root=await mkdtemp(join(tmpdir(),'urlcode-merge-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await cp(starter,join(root,'app'),{recursive:true});
  return {root,app:join(root,'app')};
}
function run(cwd: string,...args: string[]) {
  const result=spawnSync(process.execPath,['--conditions=development',cli,...args],{cwd,encoding:'utf8',timeout:120000,env});
  return {...result,output:result.stdout+result.stderr};
}
/** Every file of the project and its bytes, to prove a refused merge wrote nothing. */
async function contents(root: string): Promise<Record<string,string>> {
  const files: Record<string,string>={};
  for(const entry of await readdir(root,{recursive:true,withFileTypes:true}))if(entry.isFile()){const path=join(entry.parentPath,entry.name);files[relative(root,path)]=await readFile(path,'utf8');}
  return files;
}
function checks(root: string) {
  for(const args of [['validate','--local'],['test'],['audit']]){
    const result=run(root,...args,'--project','app');
    assert.equal(result.status,0,`${args.join(' ')}: ${result.output}`);
  }
  const audited=run(root,'audit','--project','app');
  assert.match(audited.stdout,/"ready":true/);
  assert.match(audited.stdout,/"countMatches":true/);
}

test('recipes add --project merges two recipes into a site that validates, tests and audits ready', async t => {
  const {root,app}=await site(t);
  const before=await readFile(join(app,'urlcode.yaml'),'utf8');
  const added=run(root,'recipes','add','json-endpoint','--project','app','--json');
  assert.equal(added.status,0,added.output);
  const report=JSON.parse(added.stdout) as RecipeMergeReport;
  assert.deepEqual(report.routes.added,['/api/status','/api/signups']);
  assert.deepEqual(report.expectRoutes,{file:'tests/audit.json',from:0,to:2});
  assert.deepEqual(report.written,['tests/requests.json','urlcode.yaml','tests/audit.json']);
  assert.deepEqual(report.files.skipped,['README.md']);
  assert.ok(report.fixtures.added>0);
  assert.ok(report.next.every(command=>command.includes('--project app')),report.next.join('\n'));
  // The project's own lines stay as they were; the recipe's route arrives as block YAML after them.
  const after=await readFile(join(app,'urlcode.yaml'),'utf8');
  assert.ok(after.startsWith(before.split('routes: {}')[0]!),after);
  assert.match(after,/^routes:\n {2}\/api\/status:\n/m);

  const second=run(root,'recipes','add','redirect','--project','app','--json');
  assert.equal(second.status,0,second.output);
  assert.equal((JSON.parse(second.stdout) as RecipeMergeReport).expectRoutes?.to,4);
  assert.equal(JSON.parse(await readFile(join(app,'tests','audit.json'),'utf8')).expectRoutes,4);
  checks(root);

  // The same recipe again is all unchanged and writes nothing.
  const files=await contents(app);
  const again=await mergeRecipe('redirect',app);
  assert.deepEqual(again.written,[]);
  assert.deepEqual(again.routes.added,[]);
  assert.equal(again.fixtures.added,0);
  assert.ok(again.routes.unchanged.length>0&&again.fixtures.unchanged>0);
  assert.deepEqual(await contents(app),files);
});

test('recipes add --project refuses the whole merge on clashing recipes, naming every clash, and writes nothing', async t => {
  const {root,app}=await site(t);
  assert.equal(run(root,'recipes','add','static-page','--project','app').status,0);
  const files=await contents(app);
  const refused=run(root,'recipes','add','contact-form','--project','app');
  assert.notEqual(refused.status,0);
  assert.match(refused.stderr,/Refusing to add contact-form to the project: \d+ entries clash/);
  assert.match(refused.stderr,/- route \/ in urlcode\.yaml differs/);
  assert.match(refused.stderr,/- file public\/index\.html differs from the recipe's/);
  assert.match(refused.stderr,/"code":"recipe-clash"/);
  assert.deepEqual(await contents(app),files);
  // A dry run reports the same refusal.
  await assert.rejects(mergeRecipe('contact-form',app,{dryRun:true}),/route \/ in/);
});

test('recipes add --project names a changed collection, include, seed account and fixture as clashes', async t => {
  const {app}=await site(t);
  // A project that has the booking recipe's names with other content, and the auth and store extensions declared.
  await writeFile(join(app,'urlcode.yaml'),`version: "1"
includes: [routes/auth.yaml]
extensions:
  auth: {version: "1", config: {}}
  store:
    version: "1"
    config:
      collections:
        bookings: {schema: {type: object}}
routes:
  /api/bookings/*: {extension: store, auth: true}
`);
  await mkdir(join(app,'routes'));
  await writeFile(join(app,'routes','auth.yaml'),'version: "1"\nroutes:\n  /api/auth/*: {extension: auth, methods: [POST]}\n');
  await writeFile(join(app,'tests','seed.json'),'{"auth": {"users": [{"id": "alice", "email": "someone-else@example.test", "password": "x"}]}}\n');
  await writeFile(join(app,'tests','requests.json'),'[\n  {"path": "/api/bookings", "status": 404}\n]\n');
  const files=await contents(app);
  const error=await mergeRecipe('store-booking',app).then(()=>undefined,(caught: unknown)=>caught as Error);
  assert.ok(error);
  for(const clash of ['extensions.store.config.collections.bookings in','route /api/bookings/* in','include routes/auth.yaml differs','seed auth.users[id=alice] in tests/seed.json differs','fixture GET /api/bookings in'])assert.ok(error.message.includes(clash),`${clash}\n${error.message}`);
  assert.deepEqual(await contents(app),files);
});

test('recipes add --project refuses a recipe whose extensions the project has not added, naming the command', async t => {
  const {root,app}=await site(t);
  const files=await contents(app);
  const refused=run(root,'recipes','add','store-booking','--project','app');
  assert.notEqual(refused.status,0);
  assert.match(refused.stderr,/store-booking needs the auth and store extensions/);
  assert.match(refused.stderr,/urlcode extensions add auth store`, then add the recipe again/);
  assert.match(refused.stderr,/which urlcode\.yaml does not declare/);
  assert.match(refused.stderr,/"code":"recipe-needs-extension"/);
  assert.deepEqual(await contents(app),files);
});

test('recipes add takes exactly one of --out and --project', async t => {
  const {root}=await site(t);
  assert.match(run(root,'recipes','add','redirect').stderr,/Provide --out new-directory to create a project, or --project existing-project/);
  assert.match(run(root,'recipes','add','redirect','--out','x','--project','app').stderr,/not both/);
});

test('recipes add --project keeps the project\'s comments and carries the recipe\'s own', async t => {
  const {app}=await site(t);
  await writeFile(join(app,'urlcode.yaml'),'# my site\nversion: "1"  # pinned\nroutes:\n  # the old page\n  /old: {redirect: {url: "https://example.com/"}}\n');
  const report=await mergeRecipe('json-endpoint',app);
  assert.deepEqual(report.routes.added,['/api/status','/api/signups']);
  const text=await readFile(join(app,'urlcode.yaml'),'utf8');
  assert.ok(text.startsWith('# my site\nversion: "1"  # pinned\nroutes:\n  # the old page\n  /old: {redirect: {url: "https://example.com/"}}\n  /api/status:\n'),text);
});

test('a failed write restores every file and removes what the merge created', {skip:process.platform==='win32'||process.getuid?.()===0}, async t => {
  const {app}=await site(t);
  const files=await contents(app);
  // json-api writes functions/echo.mjs, then tests/requests.json, which a read-only tests/ refuses.
  await chmod(join(app,'tests'),0o555);
  try{await assert.rejects(mergeRecipe('json-api',app),/EACCES|permission/i);}
  finally{await chmod(join(app,'tests'),0o755);}
  assert.deepEqual(await contents(app),files);
  await assert.rejects(readdir(join(app,'functions')),{code:'ENOENT'});
});
