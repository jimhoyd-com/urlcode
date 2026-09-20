import {realpath,readdir,mkdtemp,rm} from 'node:fs/promises';
import {join,posix} from 'node:path';
import {tmpdir} from 'node:os';
import type * as TypeScript from 'typescript';
import {init,parse} from 'es-module-lexer';
import {stringify} from 'yaml';
import {loadDocument} from './config.ts';
import {collectFunctionSources,routeFunctions} from './function-sources.ts';
import {authoringPath,authoringFile,readAuthoringFile,publishAuthoringProject} from './authoring-files.ts';
import {assert,ConfigError} from './errors.ts';

export interface TypeScriptBuildReport { output: string; dryRun: boolean; modules: string[]; files: string[]; typeChecked: false }
const emitted=(path: string)=>path.replace(/\.ts$/,'.js');
// Sandboxed-guest budget (docs/FUNCTION-SECURITY.md): what one QuickJS snapshot
// may cost. Trusted (non-`sandbox: true`) routes run through Node's own module
// resolution at serve time, so neither this budget nor the relative/static
// import-only rule below applies to them; only their file-read size is capped,
// generously, to bound authoring-time memory use.
const SANDBOX_MODULE_LIMIT=128,SANDBOX_MODULE_BYTE_LIMIT=1048576,SANDBOX_TOTAL_BYTE_LIMIT=4194304,TRUSTED_MODULE_BYTE_LIMIT=16*1048576;

/** Transpile a project snapshot ahead of runtime. No project compiler settings,
 * plugins, package resolution, subprocesses or guest code execution are used. */
export async function buildTypeScriptProject(project: string,output: string,{dryRun=false}: {dryRun?: boolean|undefined}={}): Promise<TypeScriptBuildReport> {
  const root=await realpath(project),loaded=await loadDocument(root),files=new Map<string,Buffer|string>(),modules=new Map<string,string>();
  const ts=await import('typescript').then(module=>module.default).catch(()=>{
    throw new ConfigError('TypeScript authoring requires the optional typescript package (npm install --save-dev --save-exact typescript@6.0.3)');
  });
  // Which trust levels a module has already been visited under, so a graph
  // reachable from both a sandboxed and a trusted route is validated under each
  // route's own rules exactly once instead of being refused outright. The
  // module is still emitted once; `emittedBy` keeps target-name collisions
  // between *different* sources refused.
  const moduleTrust=new Map<string,Set<boolean>>(),emittedBy=new Map<string,string>();
  let sandboxedSourceBytes=0,sandboxedModuleCount=0,assetBytes=0;
  await init;
  async function collect(path: string,sandboxed: boolean): Promise<void> {
    authoringPath(path);assert(/\.(?:ts|js|mjs)$/.test(path) && !path.endsWith('.d.ts'),'Guest source must be .ts, .js or .mjs');
    let visited=moduleTrust.get(path);
    if(!visited){visited=new Set();moduleTrust.set(path,visited);}
    if(visited.has(sandboxed))return;
    visited.add(sandboxed);
    let bytes: Buffer;
    if(sandboxed){
      assert(sandboxedModuleCount<SANDBOX_MODULE_LIMIT,'Function module limit exceeded');sandboxedModuleCount++;
      bytes=await readAuthoringFile(root,path,SANDBOX_MODULE_BYTE_LIMIT);sandboxedSourceBytes+=bytes.length;
      assert(sandboxedSourceBytes<=SANDBOX_TOTAL_BYTE_LIMIT,'Function source limit exceeded');
    } else {
      bytes=await readAuthoringFile(root,path,TRUSTED_MODULE_BYTE_LIMIT);
    }
    const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    modules.set(path,emitted(path));
    let code=source;
    if(path.endsWith('.ts')){
      const ast=ts.createSourceFile(path,source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
      // Bare imports are forbidden even if they would be erased as type-only —
      // but only for the sandboxed guest surface; a trusted route resolves
      // them through Node like any other module once served.
      const inspect=(node: TypeScript.Node): void=>{
        assert(!ts.isImportEqualsDeclaration(node) && !(ts.isExportAssignment(node) && node.isExportEquals),'CommonJS TypeScript module syntax is unsupported');
        if(sandboxed && (ts.isImportDeclaration(node)||ts.isExportDeclaration(node)) && node.moduleSpecifier){
          assert(ts.isStringLiteral(node.moduleSpecifier),'Only literal relative imports are supported');
          const name=node.moduleSpecifier.text;
          assert((name.startsWith('./')||name.startsWith('../')) && /\.(?:ts|js|mjs)$/.test(name),'Only relative guest module imports are supported');
        }
        ts.forEachChild(node,inspect);
      };
      inspect(ast);
      const result=ts.transpileModule(source,{fileName:path,reportDiagnostics:true,compilerOptions:{
        target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,isolatedModules:true,verbatimModuleSyntax:true,
        sourceMap:false,inlineSourceMap:false,removeComments:false,
      }});
      assert(!result.diagnostics?.some(d=>d.category===ts.DiagnosticCategory.Error),'Invalid TypeScript guest source');
      code=result.outputText;
    }
    const [imports]=parse(code);const edits: {start:number;end:number;value:string}[]=[];
    for(const item of imports){
      if(sandboxed){
        assert(item.type==='static' && typeof item.specifier==='string' && !item.attributes && !item.phase,'Dynamic imports and import.meta are unsupported in sandbox functions');
        assert(item.specifier.startsWith('./')||item.specifier.startsWith('../'),'Only relative guest module imports are supported');
        assert(!/[\\\u0000-\u001f]/u.test(item.specifier),'Invalid guest import path');
        const dependency=posix.normalize(posix.join(posix.dirname(path),item.specifier));
        await collect(dependency,true);
        edits.push({start:item.start-1,end:item.end+1,value:JSON.stringify(emitted(item.specifier))});
      } else {
        // Trusted routes get full Node module resolution at serve time: bare/
        // npm specifiers, dynamic import() and import.meta pass through
        // untouched. Only literal relative imports of project .ts/.js/.mjs
        // modules are rewritten and recursively collected.
        if(typeof item.specifier!=='string')continue;
        if(!(item.specifier.startsWith('./')||item.specifier.startsWith('../')))continue;
        assert(!/[\\\u0000-\u001f]/u.test(item.specifier),'Invalid guest import path');
        if(!/\.(?:ts|js|mjs)$/.test(item.specifier))continue;
        const dependency=posix.normalize(posix.join(posix.dirname(path),item.specifier));
        await collect(dependency,false);
        // A static specifier's start/end exclude its quotes; a dynamic
        // import()'s already include them (es-module-lexer's own asymmetry).
        const [start,end]=item.type==='dynamic'?[item.start,item.end]:[item.start-1,item.end+1];
        edits.push({start,end,value:JSON.stringify(emitted(item.specifier))});
      }
    }
    for(const edit of edits.sort((a,b)=>b.start-a.start))code=code.slice(0,edit.start)+edit.value+code.slice(edit.end);
    // A module reachable from both trust levels is transpiled twice (once per
    // rule set) but emitted once. The two results agree: the sandbox rules are
    // strictly stricter, so anything the trusted pass would leave alone —
    // bare/dynamic specifiers, `import.meta` — fails the sandboxed pass and
    // aborts the whole build before either emission is published.
    const target=emitted(path),previous=emittedBy.get(target);
    assert(previous===undefined||previous===path,'Guest output module collision');
    emittedBy.set(target,path);files.set(target,code);
  }
  for(const route of Object.values(loaded.routes))for(const definition of routeFunctions(route)){
    await collect(definition.source,!!route.sandbox);definition.source=emitted(definition.source);
  }
  async function asset(path: string): Promise<void> {
    if(files.has(path))return;assert(files.size<10000,'Authoring file limit exceeded');
    const bytes=await readAuthoringFile(root,path,16*1048576);assetBytes+=bytes.length;
    assert(assetBytes<=64*1048576,'Authoring asset limit exceeded');files.set(path,bytes);
  }
  async function directory(path: string): Promise<void> {
    const absolute=await authoringFile(root,path,true);
    const entries=await readdir(absolute,{withFileTypes:true});
    assert(entries.length>0,'Empty static directories need an asset before authoring build');
    for(const entry of entries){
      const child=path+'/'+entry.name;authoringPath(child);
      assert(!entry.isSymbolicLink(),'Authoring through symlinks is forbidden');
      if(entry.isDirectory())await directory(child);else await asset(child);
    }
  }
  for(const route of Object.values(loaded.routes)){
    for(const ref of [route.page,route.download])if(ref)await asset(ref.file);
    if(route.static)await directory(route.static.directory);
  }
  for(const ref of [loaded.document.site?.favicon,loaded.document.site?.llms,loaded.document.site?.notFound])if(ref)await asset(ref);
  // Request fixtures describe behavior the emitted project must keep, so they travel with it.
  try{await asset('tests/requests.json');}catch(error){if(!(error instanceof Error && 'code' in error && error.code==='ENOENT'))throw error;}
  // Flatten includes using the loader's duplicate-checked route table. Original
  // project metadata stays in the entry; executable sources are the only edits.
  const document={...loaded.document,routes:loaded.routes};delete document.includes;
  assert(!files.has('urlcode.yaml'),'Guest source conflicts with entry configuration');
  files.set('urlcode.yaml',stringify(document));
  // Reuse the exact runtime module parser/path/source-budget validation on the
  // emitted snapshot before touching the requested destination. This is the
  // sandboxed guest's own parser/budget contract, so it only applies to
  // `sandbox: true` routes; a trusted route's emitted module runs through
  // Node's own resolution and carries none of that budget.
  const temporary=await mkdtemp(join(tmpdir(),'urlcode-ts-'));
  try {
    const validation=await publishAuthoringProject(join(temporary,'project'),files);
    await collectFunctionSources(Object.values(loaded.routes).filter(route=>route.sandbox).map(route=>({
      middleware:(route.middleware||[]).map(def=>({source:join(validation,def.source),export:def.export||'default'})),
      ...(route.function?{function:{source:join(validation,route.function.source),export:route.function.export||'default'}}:{}),
    })),validation);
  }finally{await rm(temporary,{recursive:true,force:true});}
  return {output:await publishAuthoringProject(output,files,dryRun),dryRun,modules:[...modules.values()].sort(),files:[...files.keys()].sort(),typeChecked:false};
}
