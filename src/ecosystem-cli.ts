import {basename} from 'node:path';
import {assert} from './errors.ts';
import {readConversionInput} from './interchange-cli.ts';

interface Options {
  project:string;out?:string|undefined;format?:string|undefined;input?:string|undefined;
  target?:string|undefined;origin?:string|undefined;'dry-run'?:boolean|undefined;
  'timeout-ms'?:string|undefined;release?:string|undefined;'git-commit'?:string|undefined;'allow-authoring'?:boolean|undefined;'host-file'?:string|undefined;
}
export async function runEcosystemCommand(command:string,args:string[],options:Options,print:(value:unknown)=>unknown):Promise<void> {
  if(command==='recipes'||command==='recipe'){
    const {listRecipes,showRecipe,addRecipe}=await import('./recipes.ts');
    const [operation='list',name]=args;
    assert(args.length<=2,'Unexpected recipe arguments');
    if(operation==='list'){assert(name===undefined,'Unexpected recipe name');print(listRecipes());}
    else if(operation==='show'){assert(name,'Provide a recipe name');print(await showRecipe(name));}
    else if(operation==='add'){assert(name && options.out,'Provide a recipe name and --out new-directory');print(await addRecipe(name,options.out,{dryRun:options['dry-run']}));}
    else assert(false,'Use recipes list, show or add');
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
    // The flags reach the server from parsed argv only; no tool argument or environment variable can set them.
    await serveMcp({project:options.project,...(options.origin===undefined?{}:{origin:options.origin}),...(options['allow-authoring']?{allowAuthoring:true}:{}),...(options['host-file']===undefined?{}:{hostFile:options['host-file']})});
  }else assert(false,'Unknown ecosystem command');
}
