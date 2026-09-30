import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {relative,resolve} from 'node:path';
import {parse} from 'yaml';
import {buildRouteIndex,routeIndexFile} from '../packages/core/src/examples.ts';
// Generates the cookbook's derived files:
// - examples/cookbook/route-index.json, the per-route tag index that `urlcode examples search` reads. Tags are derived
//   from the loaded routes (handler, methods, capabilities, policies, middleware modules), never hand-written.
// - the middleware recipe's copies of the cookbook modules (#1095): every `middleware/` or `functions/` file that
//   recipes/middleware/recipe.yaml lists is copied byte for byte from examples/cookbook/, the one authored source, so
//   the shipped recipe stays standalone without a second hand-maintained copy.
// `--check` fails when the cookbook changes and a derived file was not regenerated.
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const project=resolve(root,'examples/cookbook'),recipe=resolve(root,'recipes/middleware');
const index=await buildRouteIndex(project,'examples/cookbook');
const derived=new Map<string,string>([[resolve(project,routeIndexFile),JSON.stringify(index,null,2)+'\n']]);
const {files}=parse(await readFile(resolve(recipe,'recipe.yaml'),'utf8')) as {files:string[]};
for(const file of files.filter(path=>path.startsWith('middleware/')||path.startsWith('functions/')))
  derived.set(resolve(recipe,file),await readFile(resolve(project,file),'utf8'));
const check=process.argv.includes('--check'),stale:string[]=[];
for(const [file,text] of derived){
  if(check){
    let current='';try{current=await readFile(file,'utf8');}catch{/* missing counts as stale */}
    if(current!==text)stale.push(relative(root,file));
  }else await writeFile(file,text);
}
if(stale.length>0){console.error(`Derived cookbook files are stale; edit examples/cookbook/, then run npm run docs:cookbook-index:\n  ${stale.join('\n  ')}`);process.exit(1);}
console.log(`${check?'Cookbook derived files are current':'Wrote the cookbook derived files'}: ${index.routes} indexed routes, ${derived.size-1} middleware recipe copies`);
