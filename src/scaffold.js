import {realpath,lstat,readFile,mkdir,open} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {parseYaml,validateDocument,MAX_CONFIG_BYTES} from './config.js';
import {assert} from './errors.js';

const html='<!doctype html>\n<html lang="en"><meta charset="utf-8"><title>TODO</title><body><h1>TODO: replace this placeholder</h1></body></html>\n';
const sensitive=/^(?:node_modules|package(?:-lock)?\.json|.*\.(?:pem|key|p12|pfx|env))$/i;
function parts(path){
  assert(typeof path==='string' && path.length<=1024,'Invalid scaffold path');
  const values=path.split('/');
  assert(values.length<=21 && values.every(p=>p && !p.startsWith('.') && !sensitive.test(p) && !/[\\:*?"<>|\u0000-\u001f\u007f]/u.test(p)), 'Scaffold paths must be safe project-relative paths');
  return values;
}
async function inspect(root,path,directory=false){
  const segments=parts(path);let file=root;
  for(const [i,part] of segments.entries()){
    file=join(file,part);let info;
    try{info=await lstat(file);}catch(e){if(e.code==='ENOENT')return false;throw e;}
    assert(!info.isSymbolicLink(),'Scaffolding through symlinks is forbidden');
    assert(i<segments.length-1 || directory ? info.isDirectory() : info.isFile() && info.nlink===1,'Scaffold path has an incompatible file type');
  }
  return true;
}
export async function scaffoldProject(project,{dryRun=false}={}){
  const root=await realpath(project),tasks=new Map(),unresolved=[],bindings=new Set(),routes=Object.create(null);
  const add=(path,kind,content)=>{
    parts(path);const previous=tasks.get(path);
    assert(!previous || previous.kind===kind,'Conflicting scaffold references');
    if(!previous)tasks.set(path,{path,kind,content,exports:new Map()});
    assert(tasks.size<=10000,'Scaffold file limit exceeded');return tasks.get(path);
  };
  async function config(path,entry=false){
    assert(/\.ya?ml$/i.test(path),'Includes must be YAML files');
    add(path,'config','version: "1"\nroutes: {}\n');
    if(!await inspect(root,path)){
      assert(!entry,'Create urlcode.yaml before scaffolding');
      unresolved.push({path,reason:'Empty included route file needs definitions'});return;
    }
    const bytes=await readFile(join(root,path));assert(bytes.length<=MAX_CONFIG_BYTES,'Configuration exceeds 32 MiB');
    const doc=validateDocument(parseYaml(bytes.toString('utf8')));
    assert(entry || !doc.includes?.length,'Nested includes are unsupported');
    for(const [path,route] of Object.entries(doc.routes)){
      assert(!Object.hasOwn(routes,path),'Duplicate route across files');routes[path]=route;
    }
    if(entry){const seen=new Set([path]);for(const include of doc.includes||[]){assert(!seen.has(include),'Duplicate include');seen.add(include);await config(include);}}
  }
  await config('urlcode.yaml',true);
  assert(Object.keys(routes).length<=100000,'Maximum 100000 routes per project');
  for(const route of Object.values(routes)){
    for(const [definition,role] of [...(route.middleware||[]).map(m=>[m,'middleware']),...(route.function?[[route.function,'function']]:[])]){
      assert(['.js','.mjs'].includes(extname(definition.source)),'Functions require .js or .mjs sources');
      const task=add(definition.source,'module');const name=definition.export||'default';
      assert(!task.exports.has(name)||task.exports.get(name)===role,'Same export cannot scaffold as both function and middleware');task.exports.set(name,role);
    }
    for(const ref of Object.values(route.env||{}))if(ref.env)bindings.add(ref.env);
    for(const ref of Object.values(route.secrets||{}))bindings.add(ref.secret);
    if(route.link)unresolved.push({reason:'Operator link-store binding and records required',collection:route.link.collection});
    for(const asset of [route.page,route.download].filter(Boolean))add(asset.file,'asset');
    if(route.static){add(route.static.directory,'directory');if(route.static.index)add(route.static.directory+'/'+route.static.index,'asset');}
  }
  // Plan everything before creating anything. Existing files are never edited.
  for(const task of tasks.values()){
    task.exists=await inspect(root,task.path,task.kind==='directory');
    const ancestors=task.path.split('/');ancestors.pop();
    while(ancestors.length){const parent=tasks.get(ancestors.join('/'));assert(!parent || parent.kind==='directory','Scaffold file/directory conflict');ancestors.pop();}
    if(task.exists)continue;
    if(task.kind==='module')task.content=[...task.exports].map(([name,role],i)=>{
      const local='placeholder'+i;
      return `// TODO: implement ${role}; fail closed until replaced.\nconst ${local} = async () => new Response("Not implemented", {status: 501});\nexport { ${local} as ${name} };\n`;
    }).join('\n');
    if(task.kind==='asset'){
      const ext=extname(task.path).toLowerCase();
      task.content=['.html','.htm'].includes(ext)?html:ext==='.json'?'{}\n':['.txt','.md','.csv'].includes(ext)?'TODO: replace this placeholder\n':['.css','.js','.mjs'].includes(ext)?'/* TODO: replace this placeholder */\n':undefined;
      if(task.content===undefined)unresolved.push({path:task.path,reason:'Provide a real binary or unsupported asset; no fake file created'});
    }
  }
  const created=[],preserved=[];
  for(const task of tasks.values()){
    if(task.exists){preserved.push(task.path);continue;}
    if(task.kind!=='directory' && task.content===undefined)continue;
    if(!dryRun){
      const segments=parts(task.path),directories=task.kind==='directory'?segments:segments.slice(0,-1);let prefix='';
      for(const part of directories){prefix=prefix?prefix+'/'+part:part;if(!await inspect(root,prefix,true)){try{await mkdir(join(root,prefix));}catch(e){if(e.code!=='EEXIST')throw e;}await inspect(root,prefix,true);}}
      if(task.kind!=='directory'){
        const file=await open(join(root,task.path),'wx',0o600);
        try{await file.writeFile(task.content);await file.sync();}finally{await file.close();}
      }
    }
    created.push(task.path);
  }
  return {dryRun,created,preserved,unresolved,requiredBindings:[...bindings].sort(),needsImplementation:true};
}
