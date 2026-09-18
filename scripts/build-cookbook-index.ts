import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {buildRouteIndex,routeIndexFile} from '../src/examples.ts';
// Generates examples/cookbook/route-index.json, the per-route tag index that
// `urlcode examples search` reads. Tags are derived from the loaded routes
// (handler, methods, capabilities, policies, middleware modules), never hand-written,
// so `--check` fails when the cookbook changes and the index was not regenerated.
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const project=resolve(root,'examples/cookbook'),file=resolve(project,routeIndexFile);
const index=await buildRouteIndex(project,'examples/cookbook');
const text=JSON.stringify(index,null,2)+'\n';
if(process.argv.includes('--check')){
  let current='';try{current=await readFile(file,'utf8');}catch{/* missing counts as stale */}
  if(current!==text){console.error(`${file} is stale; run npm run docs:cookbook-index`);process.exit(1);}
  console.log(`Cookbook route index is current: ${index.routes} routes`);
}else{await writeFile(file,text);console.log(`Wrote ${file}: ${index.routes} routes`);}
