import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn,spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { initProject, addRedirect, stampStarterText } from '../packages/core/src/authoring.ts';
import { loadDocument } from '../packages/core/src/config.ts';
import { runProjectTests } from '../packages/core/src/project-tests.ts';
import { project,redirect } from './helpers.ts';
import { renderAgentsGuide, renderMcpConfig, skillPath } from '../packages/core/src/agents-guide.ts';
import { projectScripts } from '../packages/core/src/context.ts';
const cli = fileURLToPath(new URL('../packages/core/src/cli.ts',import.meta.url));
test('the bare agent-ready starter initializes without application routes or fixtures', async t => {
  const root = await project(t,{});
  {
    const target = join(root,'app');
    await initProject(target);
    assert.deepEqual(await runProjectTests(target),{ total:0,failed:0 });
    await assert.rejects(readFile(join(target,'tests','requests.json')),/ENOENT/);
    await assert.rejects(initProject(target),/already contains .*init into a new or empty directory/);
    assert.ok((await readFile(join(target,'.gitignore'),'utf8')).includes('.env.*'));
    // The CI template is a dotfile directory: init must copy it as-is.
    assert.ok((await readFile(join(target,'.github','workflows','urlcode.yml'),'utf8')).includes('jimhoyd-com/urlcode/action@'));
    // The generated AGENTS.md names the exact checks and the starter's real route count.
    const routes = Object.keys((await loadDocument(target)).routes).length;
    const guide = await readFile(join(target,'AGENTS.md'),'utf8');
    for (const command of ['urlcode validate --local','urlcode test',`urlcode audit --expect-routes ${routes}`,'urlcode context --project DIR','capabilities NAME','recipes list']) assert.ok(guide.includes(command),`AGENTS.md lacks ${command}`);
    assert.ok(guide.includes(skillPath),'AGENTS.md does not point at the packaged skill');
    assert.ok(guide.split('\n').length <= 80,'AGENTS.md must stay under 80 lines');
    for (const tool of ['get_context','get_capability','get_schema','search_recipes','explain','get_manifest','get_extension_artifacts','get_extension_artifact','--allow-authoring']) assert.ok(guide.includes(tool),`AGENTS.md lacks ${tool}`);
    // .mcp.json registers the read-only server for the project directory itself.
    const mcp = JSON.parse(await readFile(join(target,'.mcp.json'),'utf8')) as { mcpServers: Record<string,{ command: string; args: string[] }> };
    assert.deepEqual(mcp,{ mcpServers:{ urlcode:{ command:'urlcode',args:['mcp','--project','.'] } } });
  }
});
test('the committed starter .mcp.json equals what init generates', async () => {
  const starter = fileURLToPath(new URL('../starters/default',import.meta.url));
  assert.equal(await readFile(join(starter,'.mcp.json'),'utf8'),renderMcpConfig('.'),'starters/default/.mcp.json is stale; regenerate it with renderMcpConfig and commit');
  assert.ok(!renderMcpConfig('app').includes('--allow-authoring'));
  assert.ok(!renderMcpConfig('app',{ local:true }).includes('--allow-authoring'));
  assert.ok(renderMcpConfig('.',{ local:true }).includes('"@jimhoyd/urlcode"'),'npx must always name the scoped package');
  for (const bad of ['','/abs','../up','a/../b']) assert.throws(() => renderMcpConfig(bad),bad);
});
test('the committed starter AGENTS.md equals what init generates from this runtime', async () => {
  // init copies the starter verbatim except for this file, which it generates
  // from the capability catalog; a clone of the starter must carry the same text.
  const starter = fileURLToPath(new URL('../starters/default',import.meta.url));
  const routes = Object.keys((await loadDocument(starter)).routes).length;
  assert.equal(await readFile(join(starter,'AGENTS.md'),'utf8'),renderAgentsGuide({ routes }),
    'starters/default/AGENTS.md is stale; regenerate it with renderAgentsGuide and commit');
  const guide = renderAgentsGuide({ routes });
  // Only capabilities this version implements natively may be named.
  for (const name of ['redirect','respond','page','static','download','function','proxy','conditional']) assert.ok(guide.includes(`\`${name}\``));
  assert.ok(guide.includes('## Feedback'));
  assert.ok(guide.includes("user's explicit approval"));
  // #539: the trust section must separate the injected-context limit from trusted
  // Node's ambient authority, and must never read as a confinement guarantee.
  const trust = guide.slice(guide.indexOf('## Functions and middleware'), guide.indexOf('## Checks'));
  assert.match(trust, /injected context holds only declared `args`\/`env`\/`secrets`/);
  assert.match(trust, /ambient authority \(`process\.env`, filesystem, network, installed modules\)/);
  assert.match(trust, /not confinement/);
  assert.doesNotMatch(trust, /Node with only declared/);
  assert.ok(guide.split('\n').length <= 80, 'generated project guidance must remain concise');
  assert.throws(() => renderAgentsGuide({ routes:-1 }));
});
test('authoring validates destination, rejects collisions and preserves original on failure', async t => {
  const root = await project(t,{ '/go':redirect() });
  const original = await readFile(join(root,'urlcode.yaml'),'utf8');
  await assert.rejects(addRedirect(root,'javascript:alert(1)','bad'));
  assert.equal(await readFile(join(root,'urlcode.yaml'),'utf8'),original);
  await assert.rejects(addRedirect(root,'https://example.org','go'));
  assert.equal(await addRedirect(root,'https://example.org','new'),'/new');
  assert.equal((await loadDocument(root)).routes['/new']?.redirect?.url,'https://example.org');
});
test('init works in place after npm init and npm install without changing package.json', async t => {
  const root = await project(t,{});
  const target = join(root,'inplace');
  await mkdir(join(target,'node_modules','@jimhoyd','urlcode'),{ recursive:true });
  await writeFile(join(target,'package.json'),JSON.stringify({ name:'mine',version:'2.3.4',license:'MIT',scripts:{ test:'echo hi' },dependencies:{ '@jimhoyd/urlcode':'0.5.0' } },null,2)+'\n');
  const init = spawnSync(process.execPath,[cli,'init',target],{ encoding:'utf8',timeout:20000 });
  assert.equal(init.status,0,init.stderr);
  const merged = JSON.parse(await readFile(join(target,'package.json'),'utf8'));
  assert.equal(merged.name,'mine'); assert.equal(merged.version,'2.3.4'); assert.equal(merged.license,'MIT');
  // An existing script is never overwritten; the missing ones that run the local install are added (#588).
  assert.equal(merged.scripts.test,'echo hi'); assert.equal(merged.scripts.start,'urlcode serve'); assert.equal(merged.scripts.validate,'urlcode validate --local');
  assert.equal(merged.scripts.audit,'urlcode audit --expect-routes 0');
  assert.equal(merged.dependencies['@jimhoyd/urlcode'],'0.5.0','an installed pin is kept, never rewritten');
  assert.deepEqual(JSON.parse(await readFile(join(target,'.mcp.json'),'utf8')).mcpServers.urlcode.command,'npx');
  for (const args of [['validate','--local'],['test']]) {
    const result = spawnSync(process.execPath,[cli,...args,'--project',target],{ encoding:'utf8',timeout:20000 });
    assert.equal(result.status,0,result.stdout+result.stderr);
  }
  assert.equal(spawnSync(process.execPath,[cli,'init',target],{ encoding:'utf8',timeout:20000 }).status,1,'a second init finds urlcode.yaml and refuses');
});
test('init stamps the running release into the schema pin and CI action, and pins scripts with --manifest (#557, #588)', async t => {
  const root = await project(t,{});
  const version = (JSON.parse(await readFile(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8')) as { version:string }).version;
  const target = join(root,'stamped');
  const init = spawnSync(process.execPath,[cli,'init',target,'--manifest'],{ encoding:'utf8',timeout:20000 });
  assert.equal(init.status,0,init.stderr);
  const yaml = await readFile(join(target,'urlcode.yaml'),'utf8');
  assert.match(yaml,new RegExp(`^# yaml-language-server: \\$schema=https://raw\\.githubusercontent\\.com/jimhoyd-com/urlcode/v${version.replaceAll('.','\\.')}/schemas/urlcode\\.schema\\.json\n`));
  const workflow = await readFile(join(target,'.github','workflows','urlcode.yml'),'utf8');
  assert.deepEqual([...workflow.matchAll(/jimhoyd-com\/urlcode\/action@(\S+)/g)].map(match => match[1]),[`v${version}`]);
  assert.ok(!(await readFile(join(target,'starter.json'),'utf8')).includes('compatibleRuntime'),'nothing reads a compatibility claim, so none is shipped');
  const readme = await readFile(join(target,'README.md'),'utf8');
  assert.ok(!readme.includes('gitignore.template') && !readme.includes('installed separately'),'README describes the generated project, not the packaging source');
  const pkg = JSON.parse(await readFile(join(target,'package.json'),'utf8'));
  assert.deepEqual(pkg.scripts,projectScripts(0));
  assert.equal(pkg.dependencies['@jimhoyd/urlcode'],version);
  // The committed starter already carries the current release, so a clone matches what init writes.
  const starter = fileURLToPath(new URL('../starters/default',import.meta.url));
  for (const file of ['urlcode.yaml','.github/workflows/urlcode.yml']) {
    const text = await readFile(join(starter,file),'utf8');
    assert.equal(stampStarterText(text,version),text,`starters/default/${file} names another release`);
  }
  assert.ok(!(await readFile(join(starter,'AGENTS.md'),'utf8')).includes('/path/to/urlcode'));
});
test('init replaces only the npm init placeholder test script in an existing pinned package.json', async t => {
  const root = await project(t,{});
  const target = join(root,'npm-init'); await mkdir(target);
  await writeFile(join(target,'package.json'),JSON.stringify({ name:'x',scripts:{ test:'echo "Error: no test specified" && exit 1',dev:'vite' },devDependencies:{ '@jimhoyd/urlcode':'0.5.9' } },null,4)+'\n');
  assert.equal(spawnSync(process.execPath,[cli,'init',target],{ encoding:'utf8',timeout:20000 }).status,0);
  const text = await readFile(join(target,'package.json'),'utf8');
  assert.ok(text.startsWith('{\n    "name"'),'the existing indentation is kept');
  const merged = JSON.parse(text);
  assert.equal(merged.scripts.test,'urlcode test'); assert.equal(merged.scripts.dev,'vite');
});
test('init in place preserves the route-only default when only node_modules exists', async t => {
  const root = await project(t,{});
  const bare = join(root,'bare'); await mkdir(join(bare,'node_modules'),{ recursive:true });
  assert.equal(spawnSync(process.execPath,[cli,'init',bare],{ encoding:'utf8',timeout:20000 }).status,0);
  await assert.rejects(readFile(join(bare,'package.json')), /ENOENT/);
  assert.equal(JSON.parse(await readFile(join(bare,'.mcp.json'),'utf8')).mcpServers.urlcode.command,'urlcode');
});
test('init in place refuses user files and preserves existing package metadata', async t => {
  const root = await project(t,{});
  const run = (target: string, ...extra: string[]) => spawnSync(process.execPath,[cli,'init',target,...extra],{ encoding:'utf8',timeout:20000 });
  const files = join(root,'files'); await mkdir(files); await writeFile(join(files,'notes.txt'),'mine'); await writeFile(join(files,'package.json'),'{}');
  const refused = run(files); assert.equal(refused.status,1); assert.match(refused.stderr+refused.stdout,/already contains notes\.txt/);
  assert.deepEqual((await readdir(files)).sort(),['notes.txt','package.json'],'nothing was added');
  const existingManifest = join(root,'existing-manifest'); await mkdir(existingManifest);
  const original = JSON.stringify({ name:'c',scripts:{ start:'node server.js' } });
  await writeFile(join(existingManifest,'package.json'),original);
  assert.equal(run(existingManifest).status,0);
  assert.equal(await readFile(join(existingManifest,'package.json'),'utf8'),original,'package.json is byte-identical after init');
  const manifest = join(root,'manifest'); await mkdir(manifest); await writeFile(join(manifest,'package.json'),'{}');
  assert.equal(run(manifest,'--manifest').status,1);
  const broken = join(root,'broken'); await mkdir(broken); await writeFile(join(broken,'package.json'),'{oops');
  assert.equal(run(broken).status,1);
});
test('CLI errors use nonzero status and do not echo secret arguments', async t => {
  const root = await project(t,{});
  for (const args of [['init','unused','--template','redirects'],['unknown'],['serve','--port','invalid'],['add','javascript:SECRET','--project',root]]) {
    const result = spawnSync(process.execPath,[cli,...args],{ encoding:'utf8',timeout:10000 });
    assert.equal(result.status,1); assert.ok(!result.stderr.includes('SECRET'));
  }
});
test('authoring does not read credentials or execute functions in an untrusted project', async t => {
  const root = await project(t,{'/f':{function:{source:'f.mjs'},secrets:{KEY:{secret:'missing'}}}},{'f.mjs':'while(true) {} export default () => new Response("no")','.env.local':'invalid dotenv'});
  assert.equal(await addRedirect(root,'https://example.com','new'),'/new');
});
test('audit CLI fails count mismatch and does not print redirect destinations',async t=>{
  const root=await project(t,{'/go':redirect('https://example.com/SECRET')});
  for(const [count,code] of [['1',0],['2',1]] as const) {
    const result=spawnSync(process.execPath,[cli,'audit','--project',root,'--expect-routes',count],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,code);assert.ok(!result.stdout.includes('SECRET'));
    const report: unknown=JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
    assert.ok(typeof report==='object' && report!==null && 'ready' in report);assert.equal(report.ready,code===0);
  }
});

test('serve names the port and a next step when the port is taken, as one JSON error event', async t => {
  const root = await project(t,{ '/go':redirect() });
  const blocker = createServer();
  await new Promise<void>(resolve => blocker.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise<void>(resolve => blocker.close(() => resolve())));
  const { port } = blocker.address() as AddressInfo;
  for (const command of ['serve','dev']) {
    const result = await new Promise<{ status:number|null; stderr:string }>(resolve => {
      const child = spawn(process.execPath,[cli,command,'--project',root,'--host','127.0.0.1','--port',String(port)],{ timeout:20000 });
      let stderr = ''; child.stderr.on('data',chunk => { stderr += chunk; });
      child.on('close',status => resolve({ status,stderr }));
    });
    assert.notEqual(result.status,0,command);
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length,1,`${command} must print one line: ${result.stderr}`);
    const event = JSON.parse(lines[0]!);
    assert.equal(event.event,'error');
    assert.ok(event.message.includes(String(port)),event.message);
    assert.ok(event.message.includes('127.0.0.1'),event.message);
    assert.ok(event.message.includes('--port'),event.message);
  }
});

test('serve exposes deployment capacity controls and rejects invalid values', async t => {
  const root = await project(t,{ '/go':redirect() });
  const run = (...args: string[]) => spawnSync(process.execPath,[cli,...args],{ encoding:'utf8',timeout:20000 });
  for (const args of [['--workers','0'],['--workers','abc'],['--function-timeout-ms','5'],['--max-in-flight','0'],
    ['--max-in-flight-health','99999'],['--max-body-bytes','0'],['--request-log','verbose']]) {
    const result = run('serve','--project',root,'--port','0',...args);
    assert.equal(result.status,1,`expected ${args.join(' ')} to be rejected`);
    assert.equal(JSON.parse(result.stderr).event,'error');
    assert.ok(!result.stdout.includes('listening'));
  }
  // Accepted values reach the runtime rather than being silently ignored.
  const started = run('validate','--project',root);
  assert.equal(started.status,0);
  assert.ok(run('--help').stdout.includes('--max-in-flight-health'));
});

test('doctor reports the node runtime facts', async () => {
  const report: unknown = JSON.parse(spawnSync(process.execPath,[cli,'doctor'],{ encoding:'utf8',timeout:10000 }).stdout);
  assert.ok(typeof report==='object' && report!==null && 'node' in report && 'platform' in report);
  assert.equal(typeof report.node,'string');
});

test('urlcode test is quiet by default and logs every request only with --verbose', async t => {
  const root = await project(t,{});
  const target = join(root,'app');
  await initProject(target);
  await mkdir(join(target,'tests'));
  await writeFile(join(target,'tests','requests.json'),'[{"path":"/missing","status":404}]\n');
  const run = (...args: string[]) => spawnSync(process.execPath,[cli,'test','--project',target,...args],{ encoding:'utf8',timeout:20000 });
  const quiet = run(), loud = run('--verbose');
  assert.equal(quiet.status,0);
  assert.ok(!quiet.stdout.includes('"event":"test"'));
  assert.equal((JSON.parse(quiet.stdout.trim().split('\n').pop() ?? '') as { failed:number }).failed,0);
  assert.ok(loud.stdout.includes('"event":"test"'));
});

test('urlcode test still runs where no temporary data directory can be created',async t => {
  const root = await project(t,{});
  const target = join(root,'app');
  await initProject(target);
  const run = spawnSync(process.execPath,[cli,'test','--project',target],{ encoding:'utf8',timeout:20000,env:{ ...process.env,TMPDIR:join(root,'missing','tmp') } });
  assert.equal(run.status,0);
  assert.equal((JSON.parse(run.stdout.trim().split('\n').pop() ?? '') as { failed:number }).failed,0);
});

test('--version/-v print the running core version and doctor reports it too (#589)', async () => {
  const pkg = JSON.parse(await readFile(fileURLToPath(new URL('../package.json',import.meta.url)),'utf8')) as { version:string };
  for (const flag of ['--version','-v']) {
    const result = spawnSync(process.execPath,[cli,flag],{ encoding:'utf8',timeout:10000 });
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),`urlcode ${pkg.version}`);
  }
  const doctor = JSON.parse(spawnSync(process.execPath,[cli,'doctor'],{ encoding:'utf8',timeout:10000 }).stdout) as { version:string };
  assert.equal(doctor.version,pkg.version);
});
test('--help is grouped, lists init/dev/validate/test first, has no duplicate test entry, and urlcode <cmd> --help scopes to one command (#589)', async () => {
  const full = spawnSync(process.execPath,[cli,'--help'],{ encoding:'utf8',timeout:10000 });
  assert.equal(full.status,0);
  for (const group of ['Start:','Author:','Check:','Deploy:','Extensions:','Agent tooling:']) assert.ok(full.stdout.includes(group),`--help is missing the ${group} section`);
  const start = full.stdout.indexOf('Start:');
  const order = ['urlcode init','urlcode dev','urlcode validate','urlcode test'].map(command => full.stdout.indexOf(command,start));
  assert.ok(order.every(index => index !== -1),'--help must list init, dev, validate and test');
  assert.deepEqual(order,[...order].sort((a,b) => a-b),'init/dev/validate/test must be listed first, in that order');
  assert.equal(full.stdout.split('urlcode test [').length,2,'`urlcode test` must appear exactly once (#589 duplicate entry)');
  const scoped = spawnSync(process.execPath,[cli,'dev','--help'],{ encoding:'utf8',timeout:10000 });
  assert.equal(scoped.status,0);
  assert.ok(scoped.stdout.includes('urlcode dev'));
  assert.ok(!scoped.stdout.includes('urlcode init'),'`urlcode dev --help` must not print other commands');
  assert.ok(scoped.stdout.includes('--policy'),'dev --help must mention --policy, which it accepts');
  assert.ok(!full.stdout.includes('urlcode init unused'),'--help must not include stray flag examples'); // sanity: no leftover template artifacts
  const unknown = spawnSync(process.execPath,[cli,'not-a-command','--help'],{ encoding:'utf8',timeout:10000 });
  assert.equal(unknown.status,0);
  assert.ok(unknown.stdout.includes('Unknown command'));
});
test('init prints the created path in its JSON event (#589)', async t => {
  const root = await project(t,{});
  const target = join(root,'named');
  const result = spawnSync(process.execPath,[cli,'init',target],{ encoding:'utf8',timeout:20000 });
  assert.equal(result.status,0,result.stderr);
  const event = JSON.parse(result.stdout.trim()) as { event:string; path:string };
  assert.equal(event.event,'created');
  assert.equal(event.path,target);
});
test('urlcode extension-bundles list discovers the installable first-party bundles with no network call', async () => {
  const text = spawnSync(process.execPath,[cli,'extension-bundles','list'],{ encoding:'utf8',timeout:10000 });
  assert.equal(text.status,0);
  for (const name of ['ui','auth','admin','store','forms']) assert.ok(text.stdout.includes(name),`extension-bundles list is missing ${name}`);
  assert.ok(text.stdout.includes('init'),'extension-bundles list should point at how to install');
  const json = spawnSync(process.execPath,[cli,'extension-bundles','list','--json'],{ encoding:'utf8',timeout:10000 });
  const parsed = JSON.parse(json.stdout) as { name:string; description:string }[];
  assert.deepEqual(parsed.map(item => item.name).sort(),['admin','auth','forms','store','ui']);
  for (const item of parsed) assert.ok(item.description.length > 0);
  assert.ok(spawnSync(process.execPath,[cli,'--help'],{ encoding:'utf8',timeout:10000 }).stdout.includes('extension-bundles list'));
});
