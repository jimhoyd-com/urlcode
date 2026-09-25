import {basename} from 'node:path';
import {assert} from './errors.ts';
import {readConversionInput} from './interchange-cli.ts';

interface Options {
  json?:boolean|undefined;project:string;out?:string|undefined;format?:string|undefined;input?:string|undefined;
  target?:string|undefined;origin?:string|undefined;'dry-run'?:boolean|undefined;
  'timeout-ms'?:string|undefined;release?:string|undefined;'git-commit'?:string|undefined;'allow-authoring'?:boolean|undefined;'host-file'?:string|undefined;
  global?:boolean|undefined;
}
export async function runEcosystemCommand(command:string,args:string[],options:Options,print:(value:unknown)=>unknown):Promise<void> {
  if(command==='recipes'||command==='recipe'){
    const {listRecipes,showRecipe,searchRecipes,addRecipe}=await import('./recipes.ts');
    const [operation='list',name]=args;
    assert(args.length<=2,'Unexpected recipe arguments');
    if(operation==='list'){assert(name===undefined,'Unexpected recipe name');const recipes=await listRecipes();print(options.json?recipes:formatCatalog(recipes));}
    else if(operation==='search'){assert(name,'Provide search text');const found=await searchRecipes(name);print(options.json?found:formatSearch(found.query,found.results));}
    else if(operation==='show'){assert(name,'Provide a recipe name');const recipe=await showRecipe(name);print(options.json?recipe:formatMetadata(recipe)+Object.entries(recipe.content).map(([file,text])=>`\n--- ${file}\n${text}`).join(''));}
    else if(operation==='add'){assert(name && options.out,'Provide a recipe name and --out new-directory');print(await addRecipe(name,options.out,{dryRun:options['dry-run']}));}
    else assert(false,'Use recipes list, search, show or add');
  }else if(command==='examples'||command==='example'){
    const {listExamples,searchExamples}=await import('./examples.ts');
    const [operation='list',text]=args;
    assert(args.length<=2,'Unexpected example arguments');
    if(operation==='list'){assert(text===undefined,'Unexpected example name');const examples=await listExamples();print(options.json?examples:formatCatalog(examples));}
    else if(operation==='search'){
      assert(text,'Provide search text');const found=await searchExamples(text);
      if(options.json)print(found);
      else{
        const lines=[formatSearch(found.query,found.results)];
        if(found.best)lines.push(`\nSmallest runnable match: examples/${found.best.id} (${found.best.routes??0} routes)`+(found.best.route?`, route ${found.best.route.path} in ${found.best.route.file}`:''));
        for(const result of found.results)for(const route of result.matchedRoutes.slice(0,5))lines.push(`  ${result.id} ${route.path.padEnd(24)} ${route.file}  ${route.tags.join(' ')}`);
        print(lines.join('\n')+'\n');
      }
    }
    else assert(false,'Use examples list or search');
  }else if(command==='docs'){
    const [operation,text]=args;
    assert(operation==='search' && args.length===2,'Use docs search <text>');
    const {searchDocs}=await import('./agent-context.ts');
    const found=await searchDocs(text!,{project:options.project});
    if(options.json)print(found);
    else {
      const lines=found.results.map(hit=>`## ${hit.id}: ${hit.title}${hit.package?` (${hit.package}, installed)`:''}\n${hit.summary}\nmatched: ${hit.matched.join(' ')}${hit.section?`\nsection: ${hit.section}`:''}${hit.configPath?`\nconfig path: ${hit.configPath}`:''}\n\n${hit.excerpt}\n\nnext: ${hit.next}\n`);
      if(!found.results.length)lines.push(`No match for "${found.query}" in the searched sources. ${found.note??''}\n`);
      for(const match of found.catalog)lines.push(`catalog: ${match.name} (${match.kind}) ${match.installedInProject===true?'installed in this site':'in the release catalog; not evidence this project has it'}`);
      lines.push(`\nsearched: ${[...found.coverage.searched.core,...found.coverage.searched.installed.map(item=>`${item.package} (${item.files.join(', ')})`),...(found.coverage.searched.catalog?[found.coverage.searched.catalog]:[])].join('; ')}`);
      lines.push(`not searched: ${found.coverage.notSearched.map(gap=>gap.names?`${gap.source}: ${gap.names.join(', ')}`:gap.source).join('; ')}`);
      if(found.next.length)lines.push(`next:\n${found.next.map(step=>`- ${step}`).join('\n')}`);
      print(lines.join('\n')+'\n');
    }
  }else if(command==='build-typescript'){
    assert(args.length===0 && options.out,'Provide --out new-directory');
    const {buildTypeScriptProject}=await import('./typescript-authoring.ts');
    print(await buildTypeScriptProject(options.project,options.out,{dryRun:options['dry-run']}));
  }else if(command==='bulk-import'){
    const format=options.format??args[0],input=options.input??args[options.format?0:1];
    assert(args.length<=(options.format?1:2),'Unexpected bulk import arguments');
    assert(format==='csv'||format==='json'||format==='yaml','Use bulk-import csv|json|yaml <file> --out new-directory');
    assert(input && options.out,'Provide an input file and --out new-directory');
    const {importBulkProject}=await import('./bulk.ts');
    const report=await importBulkProject(await readConversionInput(input),format,options.out,{dryRun:options['dry-run'],source:basename(input)});
    print(report);if(!report.ok)process.exitCode=1;
  }else if(command==='verify-provider'){
    assert(args.length===0,'Unexpected provider verification arguments');
    const target=options.target;
    assert(target==='self-hosted'||target==='aws'||target==='vercel'||target==='cloudflare','Provide --target self-hosted|aws|vercel|cloudflare');
    assert(options.origin,'Provide --origin https://owned-fixture.example');
    assert(options['timeout-ms']===undefined || /^\d{1,5}$/.test(options['timeout-ms']),'Invalid --timeout-ms');
    const {verifyProviderDeployment}=await import('./provider-verification.ts');
    const report=await verifyProviderDeployment(target,options.origin,{
      ...(options['timeout-ms']===undefined?{}:{timeoutMs:Number(options['timeout-ms'])}),
      ...(options.release===undefined?{}:{release:options.release}),
      ...(options['git-commit']===undefined?{}:{gitCommit:options['git-commit']}),
    });
    print(report);if(!report.pass)process.exitCode=1;
  }else if(command==='mcp'){
    if(args[0]==='print-config'){
      // Pre-session bootstrap (#542): a human registers this output as `.mcp.json` in an empty/not-yet-initialized
      // directory BEFORE starting an agent session there, so a project-scoped MCP client (Claude Code, Codex) loads
      // the `urlcode` server from that session's very first turn — before the agent ever runs `urlcode init`. The
      // server starts fine against an empty directory (tools/list works; a project-reading tool such as get_context
      // returns the same actionable "run urlcode init" error the CLI prints); `urlcode init` then keeps this exact
      // file rather than regenerating it. Defaults to the portable `npx --no --package` form so it works whether or
      // not @jimhoyd/urlcode ends up pinned in a package.json; --global prints the bare `urlcode` command instead,
      // for an operator who installed the runtime globally.
      assert(args.length<=2,'Use urlcode mcp print-config [project] [--global]');
      const {renderMcpConfig}=await import('./agents-guide.ts');
      // The default is the site's route project, `app/`, which is where `urlcode init` puts it.
      print(renderMcpConfig(args[1]??'app',{local:!options.global}));
    }else{
      assert(args.length===0,'Unexpected MCP arguments');
      const {serveMcp}=await import('./mcp.ts');
      // The flags reach the server from parsed argv only; no tool argument or environment variable can set them.
      await serveMcp({project:options.project,...(options.origin===undefined?{}:{origin:options.origin}),...(options['allow-authoring']?{allowAuthoring:true}:{}),...(options['host-file']===undefined?{}:{hostFile:options['host-file']})});
    }
  }else assert(false,'Unknown ecosystem command');
}

interface Summary {id:string;description:string;complexity:string;tags:string[];capabilities?:string[]|undefined;targets?:Record<string,string>|undefined;routes?:number|undefined;runnable?:boolean|undefined;services?:{name:string;description:string}[]|undefined;grants?:{kind:string;description:string}[]|undefined;inputs?:{name:string;file:string;description:string}[]|undefined;files:string[];tests?:{fixtures?:string|undefined;commands:string[]}|undefined;behavior?:string[]|undefined}
function formatCatalog(entries:Summary[]):string {
  return entries.map(entry=>`${entry.id.padEnd(24)} ${entry.complexity.padEnd(13)} ${String(entry.routes??'-').padStart(2)} routes  ${entry.description}`).join('\n')+'\n';
}
function formatSearch(query:string,results:(Summary&{score:number;matched:string[]})[]):string {
  if(!results.length)return `No match for "${query}"\n`;
  return results.map(entry=>`${entry.id.padEnd(24)} score ${String(entry.score).padStart(2)}  ${entry.description}\n${''.padEnd(24)} tags: ${entry.tags.join(' ')}`).join('\n')+'\n';
}
/** Metadata first, so a reader sees what a recipe needs before its files scroll past. */
function formatMetadata(entry:Summary):string {
  const lines=[`${entry.id}: ${entry.description}`,`complexity: ${entry.complexity}   routes: ${entry.routes??'-'}   runnable: ${entry.runnable!==false}`,`tags: ${entry.tags.join(' ')}`];
  if(entry.capabilities?.length)lines.push(`capabilities: ${entry.capabilities.join(' ')}`);
  if(entry.targets)lines.push(`targets: ${Object.entries(entry.targets).map(([target,verdict])=>`${target}=${verdict}`).join(' ')}`);
  for(const [title,items] of [['services',entry.services],['grants',entry.grants]] as const)if(items?.length)lines.push(`${title}:`,...items.map(item=>`  - ${'kind' in item?item.kind:item.name}: ${item.description}`));
  if(entry.inputs?.length)lines.push('inputs:',...entry.inputs.map(input=>`  - ${input.name} (${input.file}): ${input.description}`));
  if(entry.tests)lines.push('tests:',...(entry.tests.fixtures?[`  fixtures: ${entry.tests.fixtures}`]:[]),...entry.tests.commands.map(command=>`  $ ${command}`));
  if(entry.behavior?.length)lines.push('behavior:',...entry.behavior.map(line=>`  - ${line}`));
  lines.push(`files: ${entry.files.join(' ')}`);
  return lines.join('\n')+'\n';
}
