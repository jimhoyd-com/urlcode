import { mkdtemp, writeFile, readFile, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { supportsConcurrentWal } from '../src/sqlite-version.ts';
// `npm pack --json` output, as far as the smoke test reads it.
interface PackReport { version: string; filename: string; files: { path: string }[] }
const root = await mkdtemp(join(tmpdir(),'urlcode-package-'));
const npm = process.env.npm_execpath;
assert.ok(npm, 'Run through npm run test:package');
function command(bin: string,args: string[],cwd=process.cwd()): string {
  const result = spawnSync(bin === npm ? process.execPath : bin,bin === npm ? [npm,...args] : args,{ cwd,encoding:'utf8',timeout:120000 });
  assert.equal(result.status,0,result.stderr || result.error?.message); return result.stdout;
}
try {
  // child-process boundary: npm's JSON report.
  const [pack] = JSON.parse(command(npm,['pack','--ignore-scripts','--json','--pack-destination',root])) as PackReport[];
  assert.ok(pack, 'npm pack reported no package');
  for (const file of pack.files) assert.ok(!/(?:^|\/)\.env(?:$|\.(?!example$))/.test(file.path), 'Secret file in package');
  assert.equal(pack.version,'0.1.0');
  assert.ok(pack.files.some(f => f.path === 'LICENSE'),'Missing Apache-2.0 license');
  assert.ok(pack.files.some(f => f.path === 'starters/default/gitignore.template'));
  for (const path of ['llms.txt','docs/AI-AUTHORING.md','docs/YAML-REFERENCE.md','examples/cookbook/urlcode.yaml','data/agents/index.js','data/agents/LICENSES/ai-robots-txt.txt','NOTICE']) assert.ok(pack.files.some(f => f.path === path), `Missing authoring resource: ${path}`);
  // Install the actual archive, not a symlink to the working tree.
  const install = join(root,'install'); await mkdir(install);
  command(npm,['install','--ignore-scripts','--no-audit','--no-fund','--prefix',install,join(root,pack.filename)]);
  const cli = join(install,'node_modules','urlcode','dist','cli.js');
  {
    const project = join(root,'app');
    command(process.execPath,[cli,'init',project]);
    assert.ok((await readFile(join(project,'.gitignore'),'utf8')).includes('.env.*'));
    command(process.execPath,[cli,'test','--project',project]);
    command(process.execPath,[cli,'audit','--project',project,'--expect-routes','2']);
    command(process.execPath,[cli,'benchmark','--project',project,'--requests','10']);
    // The unmodified starter source is also usable as a copied/cloned app.
    const copied = join(root,'app-copy');
    await cp(resolve('starters','default'),copied,{recursive:true});
    command(process.execPath,[cli,'test','--project',copied]);
  }
  const scaffold = join(root,'scaffold'); await mkdir(scaffold);
  await writeFile(join(scaffold,'urlcode.yaml'),'version: "1"\nroutes:\n  /hello:\n    function:\n      source: functions/hello.mjs\n');
  const preview=JSON.parse(command(process.execPath,[cli,'scaffold','--project',scaffold,'--dry-run'])) as { created: string[] }; // child-process boundary: the CLI's JSON preview
  assert.ok(preview.created.includes('functions/hello.mjs'));
  command(process.execPath,[cli,'scaffold','--project',scaffold]);
  command(process.execPath,[cli,'validate','--project',scaffold]);
  const cookbook = join(install,'node_modules','urlcode','examples','cookbook');
  command(process.execPath,[cli,'test','--project',cookbook]);
  command(process.execPath,[cli,'audit','--project',cookbook,'--expect-routes','25']);
  {
    // The build helper is a documented package export, and the shipped recipe
    // must run against the installed package exactly as an application would.
    const example = join(install,'node_modules','urlcode','examples','prerender');
    const recipeOut = join(root,'recipe-dist');
    command(process.execPath,[join(example,'prerender.mjs'),example,recipeOut]);
    command(process.execPath,[cli,'test','--project',recipeOut]);
    command(process.execPath,[cli,'audit','--project',recipeOut,'--expect-routes','3']);
    // An application consuming the helper directly, by its package subpath.
    const dist = join(root,'prerendered');
    const consumer = join(install,'build.mjs');
    await writeFile(consumer,`import {prerenderPages, assertNativeProject, pageFileName} from 'urlcode/prerender';
const rendered = await prerenderPages(${JSON.stringify(example)},${JSON.stringify(dist)});
process.stdout.write(JSON.stringify({count:rendered.count, fixtures:rendered.fixtures.length, files:rendered.pages.map(page => page.file),
  root:pageFileName('/'), native:(await assertNativeProject(${JSON.stringify(recipeOut)},{allow:['page']})).length}));`);
    const report: unknown = JSON.parse(command(process.execPath,[consumer],install));
    assert.deepEqual(report,{count:3,fixtures:6,files:['index.html','guide.html','about.html'],root:'index.html',native:3});
    assert.ok((await readFile(join(dist,'index.html'),'utf8')).startsWith('<!doctype html>'));
  }
  {
    // The shipped declarations must type-check for a consumer: every subpath
    // resolves through the `types` condition, and one type from each is usable.
    // The consumer borrows the repo's typescript and @types/node, as any Node
    // application would have installed its own.
    const tsc = resolve('node_modules','typescript','bin','tsc');
    if (existsSync(tsc)) {
      await writeFile(join(install,'consumer.ts'),`import { createRuntime, startServer, loadDocument, type Runtime, type RuntimeOptions, type Server } from 'urlcode';
import { createLambdaHandler, type LambdaEvent, type LambdaHandler } from 'urlcode/aws';
import { createFetchHandler, rehydrate, type Artifact, type WorkerRoute } from 'urlcode/cloudflare';
import { prerenderPages, assertNativeProject, type PrerenderOptions, type PrerenderedPage } from 'urlcode/prerender';
import { createVercelHandler, type VercelHandler } from 'urlcode/vercel';
import { validatePlugins, activatePlugins, type Plugin, type PluginRuntime } from 'urlcode/plugins';
import { registry, compilePolicies, type PolicyRegistry, type PolicyRequestInput } from 'urlcode/policies';
import { createObserverSink, createMetrics, type Observer, type ObserverEvent } from 'urlcode/observability';
import { runCompliance, loadComplianceRules, type Standard, type ComplianceReport } from 'urlcode/compliance';
declare const runtime: Runtime; declare const options: RuntimeOptions; declare const server: Server;
declare const event: LambdaEvent; declare const lambda: LambdaHandler;
declare const artifact: Artifact; declare const route: WorkerRoute;
declare const prerender: PrerenderOptions; declare const page: PrerenderedPage;
declare const vercel: VercelHandler;
declare const plugin: Plugin; declare const host: PluginRuntime;
declare const policies: PolicyRegistry; declare const input: PolicyRequestInput;
declare const observer: Observer; declare const observerEvent: ObserverEvent;
declare const standard: Standard; declare const report: ComplianceReport;
const runtimeOf: (project: string, options?: RuntimeOptions) => Promise<Runtime> = createRuntime;
void [startServer, loadDocument, createLambdaHandler, createFetchHandler, rehydrate, prerenderPages, assertNativeProject, createVercelHandler,
  validatePlugins, activatePlugins, registry, compilePolicies, createObserverSink, createMetrics, runCompliance, loadComplianceRules, runtimeOf,
  runtime, options, server, event, lambda, artifact, route, prerender, page, vercel, plugin, host, policies, input, observer, observerEvent, standard, report];
`);
      await writeFile(join(install,'tsconfig.json'),JSON.stringify({ compilerOptions:{ module:'NodeNext', moduleResolution:'NodeNext', target:'ES2024', lib:['ES2024','DOM'], strict:true, exactOptionalPropertyTypes:true, noEmit:true, typeRoots:[resolve('node_modules','@types')], types:['node'] }, files:['consumer.ts'] }));
      command(process.execPath,[tsc,'-p',join(install,'tsconfig.json')]);
    } else console.log('Declaration consumer check skipped: the typescript devDependency is not installed (run npm ci)');
  }
  // Live links need a Node build carrying the patched SQLite WAL fix. Packaging
  // itself does not, so an unpatched build reports the skip rather than failing a
  // contributor's run for a reason their change did not cause.
  const liveLinks = supportsConcurrentWal(process.versions.sqlite);
  if (liveLinks) {
    const live = join(install,'node_modules','urlcode','examples','live-links');
    const store = join(root,'links.sqlite');
    command(process.execPath,[cli,'links','create','--project',live,'--store',store,'--code','demo','--destination','https://example.com/demo']);
    command(process.execPath,[cli,'test','--project',live,'--link-store',`links=${store}`]);
    command(process.execPath,[cli,'audit','--project',live,'--link-store',`links=${store}`,'--expect-routes','2']);
  }
  console.log(liveLinks
    ? 'Packed installation, starter/cookbook and persistent live-link checks passed'
    : `Packed installation and starter/cookbook checks passed; live-link checks skipped because Node ${process.version} bundles SQLite ${process.versions.sqlite} without the patched WAL fix`);
} finally { await rm(root,{ recursive:true,force:true }); }
