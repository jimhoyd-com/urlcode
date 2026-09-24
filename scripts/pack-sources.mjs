#!/usr/bin/env node
// Build every URLCode package from one reviewed commit, without resolving
// unpublished peers from a registry. Nothing is published.
//
// Replaces the two near-identical copies that lived in urlcode-auth and
// urlcode-admin. Those took four repository paths (--core --ui --auth --admin),
// asserted the paths were distinct, and cross-checked core's HEAD against a
// peers.json pin. Consolidation made all of them the same path and deleted
// peers.json, so the distinctness assertion rejected the normal case and the
// pin had nowhere to come from.
//
// What an operator verifies is now shorter and stronger: ONE commit identifies
// all six packages (core, ui, auth, admin, store, forms) simultaneously, where
// before it took one revision per repository plus
// trust that the peers.json pins agreed with each other. What is given up is
// building a mix of revisions across packages -- which was the drift vector
// this repository was consolidated to remove.
//
// The old scripts also installed each freshly built tarball as the next
// package's peer, to avoid the registry. That step is no longer needed: the npm
// workspace resolves every sibling to this tree by construction, which is a
// stronger guarantee than installing tarballs that were built from it moments
// earlier. scripts/check-workspace-links.ts enforces that resolution.
//
// The core package ships its two checked-in Claude skills, not the whole local
// `.claude` directory. In particular, Codex worktrees live below the latter
// and are intentionally gitignored; `package.json#files` names `.claude/skills`
// so npm pack cannot scan or accidentally publish those operator worktrees.
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot=fileURLToPath(new URL('../',import.meta.url));
const {values}=parseArgs({options:{
 repo:{type:'string'},revision:{type:'string'},out:{type:'string'},
 offline:{type:'boolean'},'skip-install':{type:'boolean'},help:{type:'boolean'},
}});
if(values.help){
 console.log('node scripts/pack-sources.mjs --revision REVIEWED_COMMIT_SHA --out NEW_DIRECTORY [--repo PATH] [--offline] [--skip-install]\n'+
  '--repo defaults to the repository this script lives in. --revision is required and exact: it is the reviewed commit, not a convenience default.');
 process.exit(0);
}
function run(binary,args,cwd,capture=false){
 if(binary==='npm.cmd'){
  const cli=process.env.URLCODE_NPM_CLI??join(dirname(process.execPath),'node_modules','npm','bin','npm-cli.js');
  if(!isAbsolute(cli))throw new Error('URLCODE_NPM_CLI must be an absolute npm CLI path');
  binary=process.execPath;args=[cli,...args];
 }
 const result=spawnSync(binary,args,{cwd,encoding:'utf8',stdio:capture?'pipe':'inherit',shell:false,maxBuffer:4*1024*1024});
 if(result.error||result.status!==0)throw new Error(`${binary} ${args[0]} failed`);
 return capture?result.stdout.trim():'';
}
try{
 const repo=resolve(values.repo??repoRoot);
 if(!values.out||!/^[a-f0-9]{40}$/.test(values.revision??''))
  throw new Error('Provide --out NEW_DIRECTORY and --revision as the exact 40-character reviewed commit');
 const dirty=()=>run('git',['status','--porcelain','--untracked-files=normal'],repo,true);
 const head=()=>run('git',['rev-parse','HEAD'],repo,true);
 if(head()!==values.revision)throw new Error('Repository does not match the reviewed revision');
 if(dirty())throw new Error('Commit reviewed source changes before creating reproducible packages');
 const rootManifest=JSON.parse(await readFile(join(repo,'package.json'),'utf8'));
 if(!rootManifest.exports?.['./extensions'])throw new Error('Core lacks the extension contract');
 // Dependency order, the same order the root verify uses. Core is the
 // repository root rather than a workspace, so it is named by path, not by
 // workspace name.
 const targets=[{name:rootManifest.name,dir:repo,workspace:undefined},
  ...['ui','auth','admin','store','forms'].map(p=>({dir:join(repo,'packages',p),workspace:`@jimhoyd/urlcode-${p}`}))];
 const output=resolve(values.out);
 await mkdir(output,{mode:0o700});
 const npm=process.platform==='win32'?'npm.cmd':'npm',offline=values.offline?['--offline']:[];
 if(!values['skip-install'])run(npm,['ci','--ignore-scripts',...offline],repo);
 // Generated, gitignored, and typechecked into by auth and admin.
 run(npm,['run','workspace:styles'],repo);
 const packages=[];
 for(const target of targets){
  const scope=target.workspace?['--workspace',target.workspace]:[];
  run(npm,['run','typecheck',...scope],repo);
  run(npm,['run','build',...scope],repo);
  if(dirty())throw new Error('Source changed during build; restart from the reviewed commit');
  const packed=JSON.parse(run(npm,['pack','--ignore-scripts','--json','--pack-destination',output,...scope],repo,true));
  if(packed.length!==1)throw new Error('Unexpected package output');
  if(dirty()||head()!==values.revision)throw new Error('Source changed during packaging; discard output and restart');
  const record=packed[0];
  packages.push({name:record.name,version:record.version,filename:record.filename,integrity:record.integrity});
 }
 await writeFile(join(output,'source-manifest.json'),
  JSON.stringify({schemaVersion:2,revision:values.revision,packages},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(`Built ${packages.length} package(s) from ${values.revision}. Review source-manifest.json; nothing was published.`);
}catch(error){console.error(error instanceof Error?error.message:'Source packaging failed');process.exitCode=1;}
