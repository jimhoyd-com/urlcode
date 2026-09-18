import {basename} from 'node:path';
import {assert} from './errors.ts';
import {readConversionInput} from './interchange-cli.ts';

interface Options {
  json?:boolean|undefined;project:string;out?:string|undefined;format?:string|undefined;input?:string|undefined;
  target?:string|undefined;origin?:string|undefined;'dry-run'?:boolean|undefined;
  'timeout-ms'?:string|undefined;release?:string|undefined;'git-commit'?:string|undefined;'allow-authoring'?:boolean|undefined;
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
    assert(args.length===0,'Unexpected MCP arguments');
    const {serveMcp}=await import('./mcp.ts');
    // The flag reaches the server from parsed argv only; no tool argument or environment variable can set it.
    await serveMcp({project:options.project,...(options.origin===undefined?{}:{origin:options.origin}),...(options['allow-authoring']?{allowAuthoring:true}:{})});
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
