// Disposable local proof, never a claim about the production deployment.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../packages/core/src/server.ts';
import type {Server} from '../packages/core/src/server.ts';

const seconds=Number(process.env.URLCODE_SOAK_SECONDS||5);
assert(Number.isInteger(seconds)&&seconds>=1&&seconds<=3600,'Soak must be 1–3600 seconds');
const directory=await mkdtemp(join(tmpdir(),'urlcode-drills-')),project=join(directory,'app');
let app: Server|undefined;
try {
 await mkdir(project);
 const config='version: "1"\nroutes:\n  /go:\n    redirect: {url: "https://example.com/v1"}\n  /function:\n    function: {source: f.mjs}\n';
 await writeFile(join(project,'urlcode.yaml'),config);
 await writeFile(join(project,'f.mjs'),'export default () => new Response("isolated");');
 app=await startServer({project,port:0,log:()=>{}});
 const server=app;
 const get=async(path: string)=>{const r=await fetch(`http://127.0.0.1:${server.address.port}${path}`,{redirect:'manual'});const body=await r.text();return {status:r.status,location:r.headers.get('location'),body};};
 const start=performance.now(),samples: number[]=[];let requests=0;
 while(performance.now()-start<seconds*1000){
   const before=performance.now();const responses=await Promise.all(['/go','/function'].map(get));
   assert.deepEqual(responses.map(r=>r.status),[302,200]);assert.equal(responses[1]?.body,'isolated');
   samples.push(performance.now()-before);requests+=2;
 }
 await writeFile(join(project,'urlcode.yaml'),'invalid: configuration');assert.equal(await app.reload(),false);assert.equal((await get('/go')).location,'https://example.com/v1');
 await writeFile(join(project,'urlcode.yaml'),config.replace('/v1','/v2'));assert.equal(await app.reload(),true);assert.equal((await get('/go')).location,'https://example.com/v2');
 await writeFile(join(project,'urlcode.yaml'),config);assert.equal(await app.reload(),true);assert.equal((await get('/go')).location,'https://example.com/v1');
 await app.close();app=undefined;
 samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({event:'local-operational-proof',seconds,requests,batchP99Ms:samples[Math.floor(samples.length*.99)],rssBytes:process.memoryUsage().rss,checks:['mixed HTTP load','invalid reload preserves last-good','configuration rollback'],deploymentProof:false}));
} finally {await app?.close();await rm(directory,{recursive:true,force:true});}
