// Disposable local proof, never a claim about the production deployment.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,copyFile,rm,statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openLinkStore} from '../src/link-store.js';
import {startServer} from '../src/server.js';
const seconds=Number(process.env.URLCODE_SOAK_SECONDS||5);
assert(Number.isInteger(seconds)&&seconds>=1&&seconds<=3600,'Soak must be 1–3600 seconds');
const directory=await mkdtemp(join(tmpdir(),'urlcode-drills-')),project=join(directory,'app');
let store,app;
try {
 await mkdir(project);
 const config='version: "1"\ndynamicLinks: true\nroutes:\n  /go:\n    redirect: {url: "https://example.com/v1"}\n  /function:\n    function: {source: f.mjs}\n  /live/{code}:\n    parameters:\n      - {name: code, in: path, required: true, schema: {type: string}}\n    link: {collection: links, code: {from: path, name: code}}\n';
 await writeFile(join(project,'urlcode.yaml'),config);
 await writeFile(join(project,'f.mjs'),'export default () => new Response("isolated");');
 const file=join(directory,'links.sqlite');
 store=await openLinkStore({file,project});let row=await store.create('links',{url:'https://example.com/live'},'demo');
 app=await startServer({project,port:0,linkStore:{collection:'links',file},log:()=>{}});
 const get=async path=>{const r=await fetch(`http://127.0.0.1:${app.address.port}${path}`,{redirect:'manual'});const body=await r.text();return {status:r.status,location:r.headers.get('location'),body};};
 const start=performance.now(),samples=[];let requests=0;
 while(performance.now()-start<seconds*1000){
   const before=performance.now();const responses=await Promise.all(['/go','/function','/live/demo'].map(get));
   assert.deepEqual(responses.map(r=>r.status),[302,200,302]);assert.equal(responses[1].body,'isolated');
   assert.equal(responses[2].location,row.url);samples.push(performance.now()-before);requests+=3;
   if(requests%30===0)row=await store.update('links','demo',{url:`https://example.com/live-${requests}`},row.version);
 }
 await writeFile(join(project,'urlcode.yaml'),'invalid: configuration');assert.equal(await app.reload(),false);assert.equal((await get('/go')).location,'https://example.com/v1');
 await writeFile(join(project,'urlcode.yaml'),config.replace('/v1','/v2'));assert.equal(await app.reload(),true);assert.equal((await get('/go')).location,'https://example.com/v2');
 await writeFile(join(project,'urlcode.yaml'),config);assert.equal(await app.reload(),true);assert.equal((await get('/go')).location,'https://example.com/v1');
 await app.close();app=undefined;await store.close();store=undefined;
 // Quiesced, fully closed SQLite database: safe to copy the main file alone.
 const restoreStart=performance.now(),backup=join(directory,'restored.sqlite');await copyFile(file,backup);
 store=await openLinkStore({file:backup,project,readOnly:true});assert.deepEqual(await store.get('links','demo'),row);
 const db=new DatabaseSync(backup,{readOnly:true});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('SELECT max(revision) AS revision FROM urlcode_link_audit').get().revision,row.version);db.close();
 samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({event:'local-operational-proof',seconds,requests,batchP99Ms:samples[Math.floor(samples.length*.99)],rssBytes:process.memoryUsage().rss,restoreMs:performance.now()-restoreStart,checks:['mixed HTTP load','invalid reload preserves last-good','configuration rollback','quiesced backup/restore including audit'],deploymentProof:false}));
 await store.close();store=undefined;
 // Only enable inside a disposable, size-limited mount (CI uses 16 MiB tmpfs).
 if(process.argv[2]==='--disk-full-dir'){
   const volume=resolve(process.argv[3]);const isolated=await mkdtemp(join(volume,'urlcode-full-'));
   try {
     const reserve=join(isolated,'reserve');await writeFile(reserve,Buffer.alloc(4*1024*1024));
     const fullFile=join(isolated,'full.sqlite');store=await openLinkStore({file:fullFile,project});let full=false,committed=0;
     for(let i=0;i<12000;i++){
       try{await store.create('links',{url:'https://example.com/'+ 'x'.repeat(7000)},'code-'+i);committed++;}
       catch(error){assert.equal(error.status,503);full=true;break;}
     }
     assert(full,'Disposable volume did not fill within the 84 MiB write budget');
     const space=await statfs(isolated);assert(space.bavail*space.bsize<1024*1024,'Expected actual volume exhaustion');
     await rm(reserve);await store.create('links',{url:'https://example.com/recovered'},'recovered');committed++;
     await store.close();store=undefined;
     const check=new DatabaseSync(fullFile,{readOnly:true});
     assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
     assert.equal(check.prepare('SELECT count(*) AS n FROM urlcode_links').get().n,committed);
     assert.equal(check.prepare('SELECT count(*) AS n FROM urlcode_link_audit').get().n,committed);check.close();
     console.log(JSON.stringify({event:'disposable-volume-exhaustion',committed,integrity:'ok',auditAtomic:true}));
   }finally{await store?.close();store=undefined;await rm(isolated,{recursive:true,force:true});}
 }
} finally {await app?.close();await store?.close();await rm(directory,{recursive:true,force:true});}
