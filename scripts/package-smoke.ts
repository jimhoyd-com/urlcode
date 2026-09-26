import { mkdtemp, writeFile, readFile, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parsePackJson } from './pack-json.ts';
import { unpublishedScripts, withPublishedManifest } from './published-manifest.mjs';
import { addons } from './workspaces.ts';
// `npm pack --json` output, as far as the smoke test reads it.
interface PackReport { name: string; version: string; filename: string; files: { path: string }[] }
const root = await mkdtemp(join(tmpdir(),'urlcode-package-'));
const npm = process.env.npm_execpath;
// Package installation and the TypeScript consumer are deliberately real
// subprocesses. GitHub-hosted Windows runners can take longer than two minutes
// under normal contention, but a five-minute ceiling still turns a true hang
// into a bounded, diagnosable failure.
const childTimeoutMs = 5 * 60_000;
assert.ok(npm, 'Run through npm run test:package');
const manifest = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as { version: string; devDependencies: Record<string,string> };
function command(bin: string,args: string[],cwd=process.cwd(),input?: string): string {
  const executable = bin === npm ? process.execPath : bin;
  const commandArgs = bin === npm ? [npm,...args] : args;
  const start = performance.now();
  const result = spawnSync(executable,commandArgs,{ cwd,input,encoding:'utf8',timeout:childTimeoutMs });
  const elapsedMs = Math.round(performance.now() - start);
  const details = result.stderr || result.stdout || result.error?.message || 'no child-process output';
  const diagnostic = `Command ${JSON.stringify([executable, ...commandArgs])} exited with status ${result.status}, signal ${result.signal} after ${elapsedMs} ms (timeout ${childTimeoutMs} ms)`;
  assert.equal(result.status,0,`${diagnostic}\n${details}`); return result.stdout;
}
try {
  // child-process boundary: npm's JSON report.
  const [pack] = parsePackJson<PackReport>(await withPublishedManifest(resolve('.'),() => command(npm,['pack','--ignore-scripts','--json','--pack-destination',root])));
  assert.ok(pack, 'npm pack reported no package');
  for (const file of pack.files) assert.ok(!/(?:^|\/)\.env(?:$|\.(?!example$))/.test(file.path), 'Secret file in package');
  // Compared against package.json, not a literal: a hardcoded version turns
  // every release into a smoke-test edit, and the edit is what gets forgotten.
  assert.equal(pack.version,manifest.version);
  assert.ok(pack.files.some(f => f.path === 'LICENSE'),'Missing Apache-2.0 license');
  assert.ok(pack.files.some(f => f.path === 'starters/default/gitignore.template'));
  assert.ok(pack.files.some(f => f.path === 'starters/default/.github/workflows/urlcode.yml'),'The starter CI template must ship with the package');
  for (const path of ['llms.txt','llms-full.txt','examples/cookbook/urlcode.yaml','data/agents/index.js','data/agents/LICENSES/ai-robots-txt.txt','NOTICE','recipes/redirect/urlcode.yaml','recipes/json-api/functions/echo.mjs','recipes/typescript/functions/hello.ts','skills/urlcode/SKILL.md','.claude/skills/urlcode-authoring/SKILL.md','.claude/skills/urlcode-operations/SKILL.md','starters/default/AGENTS.md','starters/default/.mcp.json']) assert.ok(pack.files.some(f => f.path === path), `Missing runtime resource: ${path}`);
  // Install the actual archive, not a symlink to the working tree.
  const install = join(root,'install'); await mkdir(install);
  command(npm,['install','--omit=dev','--omit=optional','--ignore-scripts','--no-audit','--no-fund','--prefix',install,join(root,pack.filename)]);
  // Split the packed name so a scope lands as its own directory, the way npm
  // installs it; a literal path here breaks silently on the next rename.
  const packageRoot = join(install,'node_modules',...pack.name.split('/'));
  const cli = join(packageRoot,'dist','cli.js');
  // The archive ships dist/ but not its build scripts, so it must not declare the prepare lifecycle that builds it (#592).
  const installedManifest = JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8')) as { scripts?: Record<string,string> };
  for (const name of unpublishedScripts) assert.equal(installedManifest.scripts?.[name],undefined,`The packed manifest declares ${name}`);
  assert.ok((JSON.parse(await readFile(resolve('package.json'),'utf8')) as { scripts: Record<string,string> }).scripts.prepare,'the source manifest keeps prepare for dependency installs from source');
  // Git dependencies receive source rather than the npm archive, so dist/ is
  // absent until the package's prepare lifecycle builds it. Exercise that
  // installation path separately from the archive smoke test above.
  const gitInstall = join(root,'git-install'); await mkdir(gitInstall);
  // Clone and commit the current lifecycle inputs into a throwaway repository.
  // That keeps this check meaningful before a developer's work is committed too.
  const gitRepository = join(root,'git-source');
  command('git',['clone','--local','--no-hardlinks',resolve('.'),gitRepository]);
  await cp(resolve('package.json'),join(gitRepository,'package.json'));
  await cp(resolve('scripts','build.ts'),join(gitRepository,'scripts','build.ts'));
  await cp(resolve('scripts','prepare.ts'),join(gitRepository,'scripts','prepare.ts'));
  await cp(resolve('packages','core','src'),join(gitRepository,'packages','core','src'),{recursive:true});
  command('git',['add','package.json','scripts/build.ts','scripts/prepare.ts','packages/core/src'],gitRepository);
  command('git',['-c','user.name=URLCode package smoke','-c','user.email=urlcode@example.test','commit','--allow-empty','--quiet','-m','package smoke Git source'],gitRepository);
  const revision = command('git',['rev-parse','HEAD'],gitRepository).trim();
  const gitSource = `git+file://${gitRepository}#${revision}`;
  command(npm,['install','--omit=dev','--omit=optional','--no-audit','--no-fund','--prefix',gitInstall,gitSource]);
  const gitCli = join(gitInstall,'node_modules',...pack.name.split('/'),'dist','cli.js');
  assert.ok(existsSync(gitCli),'Git installation did not build the declared CLI');
  command(process.execPath,[gitCli,'--help']);
  const capabilities = JSON.parse(command(process.execPath,[cli,'capabilities','--target','cloudflare','--json'])) as { format: number; targets: { deployment: string }[] };
  assert.equal(capabilities.format,1);
  assert.equal(capabilities.targets[0]?.deployment,'unverified');
  {
    const recipes = JSON.parse(command(process.execPath,[cli,'recipes','list','--json'])) as {name:string}[];
    assert.ok(recipes.some(recipe=>recipe.name==='typescript'));
    const shown = JSON.parse(command(process.execPath,[cli,'recipes','show','redirect','--json'])) as {content:Record<string,string>};
    assert.ok(shown.content['urlcode.yaml']);
    const source = join(root,'typed-source'),output = join(root,'typed-output');
    command(process.execPath,[cli,'recipes','add','typescript','--out',source,'--dry-run']);
    assert.ok(!existsSync(source));
    command(process.execPath,[cli,'recipes','add','typescript','--out',source]);
    assert.ok(!existsSync(join(install,'node_modules','typescript')),'Optional TypeScript compiler was installed by default');
    const unavailable = spawnSync(process.execPath,[cli,'build-typescript','--project',source,'--out',output],{encoding:'utf8',timeout:childTimeoutMs});
    assert.notEqual(unavailable.status,0,'TypeScript authoring unexpectedly worked without its optional compiler');
    assert.match(unavailable.stderr+unavailable.stdout,/requires the optional typescript package/);
    command(npm,['install','--no-save','--ignore-scripts','--no-audit','--no-fund','--prefix',install,`typescript@${manifest.devDependencies.typescript}`]);
    command(process.execPath,[cli,'build-typescript','--project',source,'--out',output]);
    command(process.execPath,[cli,'validate','--local','--project',output]);
    assert.ok(existsSync(join(output,'functions','hello.js')));
    assert.ok(existsSync(join(install,'node_modules','typescript','lib','typescript.js')),'Optional TypeScript compiler was not installed');
    const input = join(root,'redirects.csv');
    await writeFile(input,'path,url,status\n/docs,https://example.com/docs,301\n');
    const bulk = join(root,'bulk');
    command(process.execPath,[cli,'bulk-import','csv',input,'--out',bulk,'--dry-run']);assert.ok(!existsSync(bulk));
    command(process.execPath,[cli,'bulk-import','csv',input,'--out',bulk]);
    command(process.execPath,[cli,'validate','--local','--project',bulk]);
    assert.ok(existsSync(join(bulk,'provenance.json')));
    const imported = join(root,'imported.yaml');
    command(process.execPath,[cli,'import',input,'--format','csv','--out',imported]);
    const importedProject=join(root,'imported-project');await mkdir(importedProject);await cp(imported,join(importedProject,'urlcode.yaml'));
    const exported = join(root,'exported.csv');
    command(process.execPath,[cli,'export','--project',importedProject,'--target','csv','--out',exported]);
    assert.equal(await readFile(exported,'utf8'),'path,url,status\n/docs,https://example.com/docs,301\n');
    const messages=[
      {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'package-smoke',version:'1'}}},
      {jsonrpc:'2.0',method:'notifications/initialized'},
      {jsonrpc:'2.0',id:2,method:'tools/list'},
      {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'validate',arguments:{}}},
    ].map(value=>JSON.stringify(value)).join('\n')+'\n';
    const replies=command(process.execPath,[cli,'mcp','--project',output],process.cwd(),messages).trim().split('\n').map(line=>JSON.parse(line) as {id:number;result?:{tools?:{name:string}[];isError?:boolean}});
    assert.ok(replies.find(reply=>reply.id===2)?.result?.tools?.some(tool=>tool.name==='inspect'));
    const validated=replies.find(reply=>reply.id===3);assert.ok(validated?.result);assert.equal(validated.result.isError,undefined);
  }
  {
    // init always writes the site layout: the route project in app/, host.mjs, package.json and agent files beside it.
    const site = join(root,'site'), project = join(site,'app');
    command(process.execPath,[cli,'init',site]);
    assert.ok((await readFile(join(site,'.gitignore'),'utf8')).includes('.env.*'));
    assert.ok((await readFile(join(site,'.github','workflows','urlcode.yml'),'utf8')).includes('jimhoyd-com/urlcode/action@'));
    assert.ok((await readFile(join(site,'AGENTS.md'),'utf8')).includes('urlcode audit --expect-routes 0'));
    assert.ok(existsSync(join(site,'host.mjs')) && existsSync(join(site,'package.json')));
    assert.deepEqual(JSON.parse(await readFile(join(site,'.mcp.json'),'utf8')),{ mcpServers:{ urlcode:{ command:'npx',args:['--no','--package','@jimhoyd/urlcode','urlcode','mcp','--project','app'] } } });
    command(process.execPath,[cli,'test','--project',project]);
    const emptyAudit=spawnSync(process.execPath,[cli,'audit','--project',project,'--expect-routes','0'],{encoding:'utf8',timeout:childTimeoutMs});
    assert.equal(emptyAudit.status,1,'A project with no active routes is intentionally not ready');
    const emptyReport=JSON.parse(emptyAudit.stdout.trim().split('\n').at(-1) ?? '') as {ready:boolean;notReadyReasons:string[]};
    assert.equal(emptyReport.ready,false);assert.deepEqual(emptyReport.notReadyReasons,['no-active-routes']);
    const emptyBenchmark=spawnSync(process.execPath,[cli,'benchmark','--project',project,'--requests','10'],{encoding:'utf8',timeout:childTimeoutMs});
    assert.equal(emptyBenchmark.status,1,'A project with no successful request fixture cannot provide a benchmark workload');
    assert.match(emptyBenchmark.stderr+emptyBenchmark.stdout,/No GET\/HEAD workload/);
    // The unmodified starter source is also usable as a copied/cloned app.
    const copied = join(root,'app-copy');
    await cp(resolve('starters','default'),copied,{recursive:true});
    command(process.execPath,[cli,'test','--project',join(copied,'app')]);
  }
  {
    // Every packaged example with fixtures, copied the way a consumer copies it, runs
    // its listed tests.commands verbatim from that copy (#789): `urlcode` is the
    // installed CLI and `/operator/` a scratch directory outside the project. The
    // copies sit under the install so prerender.mjs resolves the package as a consumer's would.
    const examples = JSON.parse(command(process.execPath,[cli,'examples','list','--json'])) as { id:string; runnable?:boolean; tests?:{ fixtures?:string; commands:string[] } }[];
    const copies = join(install,'examples'), operator = join(root,'operator'); await mkdir(copies); await mkdir(operator);
    const refused = spawnSync(process.execPath,[cli,'examples','add','monitoring','--out',join(copies,'monitoring')],{ encoding:'utf8',timeout:childTimeoutMs });
    assert.notEqual(refused.status,0,'A non-runnable example must not be added as a project');
    let ran = 0;
    for (const example of examples) {
      if (!example.tests?.fixtures) continue;
      const project = join(copies,example.id);
      command(process.execPath,[cli,'examples','add',example.id,'--out',project]);
      for (const line of example.tests.commands) {
        assert.doesNotMatch(line,/["'<]/,`${example.id} has fixtures, so its commands must run without operator input: ${line}`);
        const words = line.split(/\s+/).map(word => word.startsWith('/operator/') ? join(operator,word.slice('/operator/'.length)) : word);
        const environment: Record<string,string> = {};
        while (/^[A-Z_][A-Z0-9_]*=/.test(words[0] ?? '')) { const [name,...value] = words.shift()!.split('='); environment[name!] = value.join('='); }
        const redirect = words.indexOf('>'), output = redirect === -1 ? undefined : words[redirect+1];
        if (redirect !== -1) words.splice(redirect,2);
        const [program,...args] = words;
        assert.ok(program === 'urlcode' || program === 'node',`${example.id}: ${line}`);
        const result = spawnSync(process.execPath,program === 'urlcode' ? [cli,...args] : args,{ cwd:project,encoding:'utf8',timeout:childTimeoutMs,env:{ ...process.env,...environment } });
        assert.equal(result.status,0,`examples/${example.id}: ${line}\n${result.stderr || result.stdout}`);
        if (output) await writeFile(output,result.stdout);
        ran++;
      }
    }
    assert.ok(ran > 0,'No packaged example command ran');
    console.log(`${ran} packaged example commands ran from consumer copies`);
  }
  const scaffold = join(root,'scaffold'); await mkdir(scaffold);
  await writeFile(join(scaffold,'urlcode.yaml'),'version: "1"\nroutes:\n  /hello:\n    function:\n      source: functions/hello.mjs\n');
  const preview=JSON.parse(command(process.execPath,[cli,'scaffold','--project',scaffold,'--dry-run'])) as { created: string[] }; // child-process boundary: the CLI's JSON preview
  assert.ok(preview.created.includes('functions/hello.mjs'));
  command(process.execPath,[cli,'scaffold','--project',scaffold]);
  command(process.execPath,[cli,'validate','--project',scaffold]);
  const cookbook = join(packageRoot,'examples','cookbook');
  command(process.execPath,[cli,'test','--project',cookbook]);
  command(process.execPath,[cli,'audit','--project',cookbook,'--expect-routes','40']);
  {
    // The build helper is a documented package export, and the shipped recipe
    // must run against the installed package exactly as an application would.
    const example = join(packageRoot,'examples','prerender');
    const recipeOut = join(root,'recipe-dist');
    command(process.execPath,[join(example,'prerender.mjs'),example,recipeOut]);
    command(process.execPath,[cli,'test','--project',recipeOut]);
    command(process.execPath,[cli,'audit','--project',recipeOut,'--expect-routes','3']);
    // An application consuming the helper directly, by its package subpath.
    const dist = join(root,'prerendered');
    const consumer = join(install,'build.mjs');
    await writeFile(consumer,`import {prerenderPages, assertNativeProject, pageFileName} from '@jimhoyd/urlcode/prerender';
const rendered = await prerenderPages(${JSON.stringify(example)},${JSON.stringify(dist)});
process.stdout.write(JSON.stringify({count:rendered.count, fixtures:rendered.fixtures.length, files:rendered.pages.map(page => page.file),
  root:pageFileName('/'), native:(await assertNativeProject(${JSON.stringify(recipeOut)},{allow:['page']})).length}));`);
    const report: unknown = JSON.parse(command(process.execPath,[consumer],install));
    assert.deepEqual(report,{count:3,fixtures:6,files:['index.html','guide.html','about.html'],root:'index.html',native:3});
    assert.ok((await readFile(join(dist,'index.html'),'utf8')).startsWith('<!doctype html>'));
  }
  {
    // The agent-context helpers (docs search, YAML validation, error
    // remediation) are a documented package export; exercise the installed
    // package's own runtime, not just its declarations, exactly as a host
    // building its own MCP server would (this package's own serveMcp does
    // the same import, see packages/core/src/mcp.ts).
    const consumer = join(install,'agent-context-consumer.mjs');
    await writeFile(consumer,`import {searchDocs, validateYaml, explainError, readAddonCatalog, suggestFixtures, summarizeYamlChange} from '@jimhoyd/urlcode/agent-context';
const found = await searchDocs('sandbox');
const valid = validateYaml('version: "1"\\nroutes: {}\\n');
const guidance = explainError('Invalid configuration at /routes');
const catalog = await readAddonCatalog();
const routed = 'version: "1"\\nroutes:\\n  /go: {redirect: {url: https://example.com/}}\\n';
const kinds = suggestFixtures(routed).cases.map(item => item.kind);
const added = summarizeYamlChange('version: "1"\\nroutes: {}\\n', routed).routes.added.map(entry => entry.route);
process.stdout.write(JSON.stringify({resultCount:found.results.length, valid:valid.valid, nextTools:guidance.nextTools, kinds, added, catalog:{scope:catalog.scope, version:catalog.version, addons:catalog.addons.map(addon => addon.name)}}));`);
    const report = JSON.parse(command(process.execPath,[consumer],install)) as {resultCount:number;valid:boolean;nextTools:string[];kinds:string[];added:string[];catalog:{scope:string;version:string;addons:string[]}};
    // Fixture suggestions and YAML change summaries (#722) run from the installed package.
    assert.deepEqual(report.kinds,['redirect','method-refusal','unknown-path']);
    assert.deepEqual(report.added,['/go']);
    assert.ok(report.resultCount>0,'searchDocs found no results against the installed package');
    assert.equal(report.valid,true);
    assert.deepEqual(report.nextTools,['get_schema','get_capability','validate']);
    // The release-wide add-on agent catalog (#721) ships beside dist/addons.json and lists every add-on.
    assert.deepEqual(report.catalog,{scope:'release',version:manifest.version,addons:(await addons()).map(addon => addon.name).sort()});
  }
  {
    // `@jimhoyd/urlcode/skills` (issue #574) is the supported way for a host
    // to read shipped skill text, replacing reads of internal package-layout
    // paths such as `.claude/skills/urlcode-authoring/SKILL.md` directly.
    // Exercise the installed package's own runtime and check the result
    // against the real files the tarball packed.
    const consumer = join(install,'skills-consumer.mjs');
    await writeFile(consumer,`import {listShippedSkills} from '@jimhoyd/urlcode/skills';
const skills = await listShippedSkills();
process.stdout.write(JSON.stringify(skills.map(skill => ({name:skill.name, version:skill.version, length:skill.text.length, startsFrontmatter:skill.text.startsWith('---\\nname: ')}))));`);
    const report = JSON.parse(command(process.execPath,[consumer],install)) as {name:string;version:string;length:number;startsFrontmatter:boolean}[];
    assert.deepEqual(report.map(skill => skill.name).sort(),['urlcode','urlcode-authoring','urlcode-operations']);
    for (const skill of report) {
      assert.equal(skill.version,manifest.version,`${skill.name} version must be the package version`);
      assert.ok(skill.length>0,`${skill.name} text must not be empty`);
      assert.ok(skill.startsFrontmatter,`${skill.name} text must include SKILL.md frontmatter`);
    }
  }
  {
    // The shipped declarations must type-check for a consumer: every subpath
    // resolves through the `types` condition, and one type from each is usable.
    // The consumer borrows the repo's typescript and @types/node, as any Node
    // application would have installed its own.
    const tsc = resolve('node_modules','typescript','bin','tsc');
    if (existsSync(tsc)) {
      await writeFile(join(install,'consumer.ts'),`import { getCapabilities, analyzeProjectCapabilities, type CapabilityCatalog, createRuntime, startServer, loadDocument, type Runtime, type RuntimeOptions, type Server } from '@jimhoyd/urlcode';
const catalog: CapabilityCatalog = getCapabilities('cloudflare');
void catalog; void analyzeProjectCapabilities;
import {listRecipes, showRecipe, addRecipe, buildTypeScriptProject, importBulkProject, inspectProject, validateProject, explainRoute, previewImport, previewExport, serveMcp, providerConformanceCases, runProviderConformance, verifyProviderDeployment, matchesRoute, importRoutes, exportRoutes, type BulkImportReport, type TypeScriptBuildReport, type RecipeSummary, type McpOptions, type RouteMatch} from '@jimhoyd/urlcode';
import {buildCloudflare, runProjectTests, scaffoldProject, initProject, addRedirect, type CloudflareBuildOptions, type CloudflareBuildReport, type ProjectTestOptions, type ProjectTestResult, type ScaffoldReport, type ScaffoldUnresolved, type ConversionCounts} from '@jimhoyd/urlcode';
const compile: (project: string, options?: CloudflareBuildOptions) => Promise<CloudflareBuildReport> = buildCloudflare;
const testProject: (project: string, options?: ProjectTestOptions) => Promise<ProjectTestResult> = runProjectTests;
declare const scaffold: ScaffoldReport; declare const unresolved: ScaffoldUnresolved; declare const counts: ConversionCounts;
void [compile, testProject, scaffoldProject, initProject, addRedirect, scaffold, unresolved, counts];
declare const bulkReport: BulkImportReport; declare const buildReport: TypeScriptBuildReport;
declare const recipe: RecipeSummary; declare const mcp: McpOptions; declare const match: RouteMatch;
void [listRecipes, showRecipe, addRecipe, buildTypeScriptProject, importBulkProject, inspectProject, validateProject, explainRoute, previewImport, previewExport, serveMcp, providerConformanceCases, runProviderConformance, verifyProviderDeployment, matchesRoute, importRoutes, exportRoutes, bulkReport, buildReport, recipe, mcp, match];
import { createLambdaHandler, type LambdaEvent, type LambdaHandler } from '@jimhoyd/urlcode/aws';
import { createFetchHandler, rehydrate, type Artifact, type WorkerRoute } from '@jimhoyd/urlcode/cloudflare';
import { prerenderPages, assertNativeProject, type PrerenderOptions, type PrerenderedPage } from '@jimhoyd/urlcode/prerender';
import { createVercelHandler, type VercelHandler } from '@jimhoyd/urlcode/vercel';
import { inspectExtensionRevision, type RuntimeExtension } from '@jimhoyd/urlcode/extensions';
import { validatePlugins, activatePlugins, type Plugin, type PluginRuntime } from '@jimhoyd/urlcode/plugins';
import { registry, compilePolicies, type PolicyRegistry, type PolicyRequestInput } from '@jimhoyd/urlcode/policies';
import { createObserverSink, createMetrics, type Observer, type ObserverEvent } from '@jimhoyd/urlcode/observability';
import { runCompliance, loadComplianceRules, type Standard, type ComplianceReport } from '@jimhoyd/urlcode/compliance';
import { SandboxPool, functionFile, type SandboxPoolOptions, type SandboxInvocation } from '@jimhoyd/urlcode/sandbox';
import { listSkills, getSkill, searchDocs, getExample, validateYaml, explainError, readAddonCatalog, suggestFixtures, summarizeYamlChange, type FixtureSuggestions, type YamlChangeSummary } from '@jimhoyd/urlcode/agent-context';
import type { AddonCatalog } from '@jimhoyd/urlcode';
import { listShippedSkills, type ShippedSkill } from '@jimhoyd/urlcode/skills';
declare const runtime: Runtime; declare const options: RuntimeOptions; declare const server: Server;
declare const event: LambdaEvent; declare const lambda: LambdaHandler;
declare const artifact: Artifact; declare const route: WorkerRoute;
declare const prerender: PrerenderOptions; declare const page: PrerenderedPage;
declare const vercel: VercelHandler;
declare const plugin: Plugin; declare const host: PluginRuntime;
const credentialPlugin: Plugin = { name: 'credential-boundary', version: '1', targets: ['node'], credentialHeaders: ['cookie', 'authorization'], onRequest() {} };
void credentialPlugin;
declare const extension: RuntimeExtension;
void [extension, inspectExtensionRevision];

declare const policies: PolicyRegistry; declare const input: PolicyRequestInput;
declare const observer: Observer; declare const observerEvent: ObserverEvent;
declare const standard: Standard; declare const report: ComplianceReport;
declare const sandboxPoolOptions: SandboxPoolOptions; declare const sandboxInvocation: SandboxInvocation;
declare const shippedSkill: ShippedSkill;
const runtimeOf: (project: string, options?: RuntimeOptions) => Promise<Runtime> = createRuntime;
void [startServer, loadDocument, createLambdaHandler, createFetchHandler, rehydrate, prerenderPages, assertNativeProject, createVercelHandler,
  validatePlugins, activatePlugins, registry, compilePolicies, createObserverSink, createMetrics, runCompliance, loadComplianceRules, runtimeOf,
  SandboxPool, functionFile, sandboxPoolOptions, sandboxInvocation,
  listSkills, getSkill, searchDocs, getExample, validateYaml, explainError,
  suggestFixtures as (yaml: string) => FixtureSuggestions, summarizeYamlChange as (before: string, after: string) => YamlChangeSummary,
  readAddonCatalog as () => Promise<AddonCatalog>,
  listShippedSkills, shippedSkill,
  runtime, options, server, event, lambda, artifact, route, prerender, page, vercel, plugin, host, policies, input, observer, observerEvent, standard, report];
`);
      await writeFile(join(install,'tsconfig.json'),JSON.stringify({ compilerOptions:{ module:'NodeNext', moduleResolution:'NodeNext', target:'ES2024', lib:['ES2024','DOM'], strict:true, exactOptionalPropertyTypes:true, noEmit:true, typeRoots:[resolve('node_modules','@types')], types:['node'] }, files:['consumer.ts'] }));
      command(process.execPath,[tsc,'-p',join(install,'tsconfig.json')]);
    } else console.log('Declaration consumer check skipped: the typescript devDependency is not installed (run npm ci)');
  }
  console.log('Packed installation and starter/cookbook checks passed');
} finally { await rm(root,{ recursive:true,force:true }); }
