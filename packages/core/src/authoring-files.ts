import {lstat,realpath,open,mkdir,rm,rename} from 'node:fs/promises';
import {resolve,join,dirname,basename,parse} from 'node:path';
import {assert} from './errors.ts';

/** Authoring output never copies hidden state, package hooks, or credential files. */
export function authoringPath(path: string): string {
  const parts=path.split('/');
  assert(path.length>0 && path.length<=1024 && parts.length<=32 && parts.every(part=>
    part && !part.startsWith('.') && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && !/[\\:*?"<>|\u0000-\u001f\u007f]/u.test(part) &&
    !/^(?:node_modules|package(?:-lock)?\.json|.*\.(?:pem|key|p12|pfx|env))$/i.test(part)), 'Authoring paths must be safe non-sensitive project-relative paths');
  return path;
}
export async function authoringFile(root: string,path: string,directory=false): Promise<string> {
  authoringPath(path);let file=root;
  for(const [index,part] of path.split('/').entries()){
    file=join(file,part);const info=await lstat(file);
    assert(!info.isSymbolicLink(),'Authoring through symlinks is forbidden');
    assert(index<path.split('/').length-1 || directory ? info.isDirectory() : info.isFile() && info.nlink===1,'Authoring requires ordinary files and directories');
  }
  return file;
}
export async function readAuthoringFile(root: string,path: string,limit: number): Promise<Buffer> {
  const file=await authoringFile(root,path),handle=await open(file,'r');
  try {
    const info=await handle.stat();assert(info.isFile() && info.nlink===1 && info.size<=limit,'Authoring source size limit exceeded');
    const bytes=Buffer.alloc(info.size+1);let offset=0;
    while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
    assert(offset<=info.size,'Authoring source changed during read');return bytes.subarray(0,offset);
  }finally{await handle.close();}
}
/** Reserve a fresh directory exclusively, then publish the entry config last.
 * Failed writes remove only the directory created by this invocation. No existing
 * directory (even an empty one) is accepted; consumers see no activatable project
 * until every dependency has been written. Callers must own the output parent.
 */
export async function publishAuthoringProject(output: string,files: ReadonlyMap<string,Buffer|string>,dryRun=false): Promise<string> {
  assert(files.has('urlcode.yaml'),'Authoring output requires urlcode.yaml');
  assert(files.size<=10000,'Authoring file limit exceeded');
  const paths=new Set<string>();
  for(const path of files.keys()){
    authoringPath(path);const key=path.toLowerCase();assert(!paths.has(key),'Conflicting authoring output paths');paths.add(key);
  }
  for(const path of paths){let parent=dirname(path);while(parent!=='.'){assert(!paths.has(parent),'Authoring file/directory conflict');parent=dirname(parent);}}
  const target=resolve(output),parent=dirname(target);assert(target!==parse(target).root,'Invalid authoring output');
  assert(!(await lstat(parent)).isSymbolicLink(),'Authoring output parent must not be a symlink');
  const destination=join(await realpath(parent),basename(target));
  let exists=false;try{await lstat(destination);exists=true;}catch(error){if(!(error instanceof Error && 'code' in error && error.code==='ENOENT'))throw error;}
  assert(!exists,'Authoring output already exists');
  if(dryRun)return destination;
  await mkdir(destination,{mode:0o700});
  try {
    const entries=[...files].sort(([a],[b])=>a==='urlcode.yaml'?1:b==='urlcode.yaml'?-1:a.localeCompare(b));
    for(const [path,content] of entries){
      const file=join(destination,path==='urlcode.yaml'?'.urlcode.yaml.pending':path);await mkdir(dirname(file),{recursive:true,mode:0o700});
      const handle=await open(file,'wx',0o600);try{await handle.writeFile(content);await handle.sync();}finally{await handle.close();}
      if(path==='urlcode.yaml')await rename(file,join(destination,'urlcode.yaml'));
    }
    return destination;
  }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
}
