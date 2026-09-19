#!/usr/bin/env node
// Build reviewed local repositories without resolving unpublished URLCode peers from a registry.
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {realpath,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
const {values}=parseArgs({options:{core:{type:'string'},auth:{type:'string'},ui:{type:'string'},admin:{type:'string'},out:{type:'string'},'core-revision':{type:'string'},offline:{type:'boolean'},'skip-install':{type:'boolean'},help:{type:'boolean'}}});
if(values.help){console.log('node scripts/pack-sources.mjs --core PATH --auth PATH --ui PATH [--admin PATH] [--core-revision REVIEWED_COMMIT_SHA] --out NEW_DIRECTORY [--offline] [--skip-install]\n--core-revision defaults to the urlcode entry of peers.json next to this script.');process.exit(0);}
if(values['core-revision']===undefined){try{values['core-revision']=JSON.parse(await readFile(new URL('../peers.json',import.meta.url),'utf8')).urlcode;}catch{/* peers.json is optional: --core-revision may be supplied instead. */}}
// peers.json is gone: this package is a workspace in core's repository now, so
// there is no separate core revision to pin, and the distinctness check below
// rejects the four source paths for being the same path -- which is exactly
// what a monorepo makes them. Redesigning this changes what operators are able
// to verify, so it is left to a decision rather than patched silently. See
// docs/SPIKE-MONOREPO.md, "What has landed".
if(values['core-revision']===undefined)throw new Error('pack-sources.mjs has not been migrated: it expects four separate repositories and a peers.json core pin, neither of which exists since admin became packages/admin. Pass --core-revision explicitly to run it against separate checkouts, or see docs/SPIKE-MONOREPO.md for the open redesign.');
function run(binary,args,cwd,capture=false){if(binary==='npm.cmd'){const cli=process.env.URLCODE_NPM_CLI??join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');if(!isAbsolute(cli))throw new Error('URLCODE_NPM_CLI must be an absolute npm CLI path');binary=process.execPath;args=[cli,...args];}const result=spawnSync(binary,args,{cwd,encoding:'utf8',stdio:capture?'pipe':'inherit',shell:false,maxBuffer:4*1024*1024});if(result.error||result.status!==0)throw new Error(`${binary} ${args[0]} failed`);return capture?result.stdout.trim():'';}
try{
 if(!values.core||!values.auth||!values.ui||!values.out||!/^[a-f0-9]{40}$/.test(values['core-revision']??''))throw new Error('Provide source paths, new output directory and exact reviewed core commit');
 const core=await realpath(values.core),auth=await realpath(values.auth),ui=await realpath(values.ui),admin=values.admin?await realpath(values.admin):undefined;
 const sources=[core,ui,auth,...(admin?[admin]:[])];if(new Set(sources).size!==sources.length)throw new Error('Source repositories must be distinct');
 const revision=run('git',['rev-parse','HEAD'],core,true);if(revision!==values['core-revision'])throw new Error('Core does not match reviewed revision');
 for(const source of sources)if(run('git',['status','--porcelain','--untracked-files=normal'],source,true))throw new Error('Commit reviewed source changes before creating reproducible packages');
 const metadata=JSON.parse(await readFile(join(core,'package.json'),'utf8'));if(!metadata.exports?.['./extensions'])throw new Error('Core lacks the PR59 extension contract');
 const output=resolve(values.out);await mkdir(output,{mode:0o700});const npm=process.platform==='win32'?'npm.cmd':'npm',offline=values.offline?['--offline']:[];
 const packages=[];
 async function build(source,peers=[]){
  const sourceRevision=run('git',['rev-parse','HEAD'],source,true);
  if(source===core&&sourceRevision!==values['core-revision'])throw new Error('Core changed since revision approval');
  if(!values['skip-install'])run(npm,['ci','--ignore-scripts','--legacy-peer-deps',...offline],source);
  if(peers.length)run(npm,['install','--no-save','--package-lock=false','--ignore-scripts',...offline,...peers],source);
  run(npm,['run','typecheck'],source);run(npm,['run','build'],source);
  if(run('git',['status','--porcelain','--untracked-files=normal'],source,true))throw new Error('Source changed during build; restart from reviewed commits');
  const packed=JSON.parse(run(npm,['pack','--ignore-scripts','--json','--pack-destination',output],source,true));if(packed.length!==1)throw new Error('Unexpected package output');
  if(run('git',['status','--porcelain','--untracked-files=normal'],source,true)||run('git',['rev-parse','HEAD'],source,true)!==sourceRevision)throw new Error('Source changed during packaging; discard output and restart');
  const record=packed[0];packages.push({name:record.name,version:record.version,filename:record.filename,integrity:record.integrity,revision:sourceRevision});return join(output,record.filename);
 }
 const coreTar=await build(core),uiTar=await build(ui),authTar=await build(auth,[coreTar,uiTar]);if(admin)await build(admin,[coreTar,uiTar,authTar]);
 await writeFile(join(output,'source-manifest.json'),JSON.stringify({schemaVersion:1,packages},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Local source packages built. Review source-manifest.json; nothing was published.');
}catch(error){console.error(error instanceof Error?error.message:'Source packaging failed');process.exitCode=1;}
