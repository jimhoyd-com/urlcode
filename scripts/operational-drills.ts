// Disposable local proof, never a claim about the production deployment.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,copyFile,rm,statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openLinkStore} from '../src/link-store.ts';
import {startServer} from '../src/server.ts';
import type {LinkStore} from '../src/link-store.ts';
import type {Server} from '../src/server.ts';
import {HttpError} from '../src/errors.ts';
// The SQLite rows the drills inspect; node:sqlite returns untyped records.
interface CheckpointRow {busy: number; log: number; checkpointed: number}
interface IntegrityRow {integrity_check: string}
interface RevisionRow {revision: number}
interface CountRow {n: number}
// node:sqlite boundary: a single-row query, typed by the caller's expectation.
const row=<T>(db: DatabaseSync,sql: string): T=>{const r=db.prepare(sql).get();assert.ok(r,`${sql} returned no row`);return r as unknown as T;};
const seconds=Number(process.env.URLCODE_SOAK_SECONDS||5);
assert(Number.isInteger(seconds)&&seconds>=1&&seconds<=3600,'Soak must be 1–3600 seconds');
const directory=await mkdtemp(join(tmpdir(),'urlcode-drills-')),project=join(directory,'app');
let store: LinkStore|undefined,app: Server|undefined;
try {
 await mkdir(project);
 const config='version: "1"\ndynamicLinks: true\nroutes:\n  /go:\n    redirect: {url: "https://example.com/v1"}\n  /function:\n    function: {source: f.mjs}\n  /live/{code}:\n    parameters:\n      - {name: code, in: path, required: true, schema: {type: string}}\n    link: {collection: links, code: {from: path, name: code}}\n';
 await writeFile(join(project,'urlcode.yaml'),config);
 await writeFile(join(project,'f.mjs'),'export default () => new Response("isolated");');
 const file=join(directory,'links.sqlite');
 store=await openLinkStore({file,project});let link=await store.create('links',{url:'https://example.com/live'},'demo');
 app=await startServer({project,port:0,linkStore:{collection:'links',file},log:()=>{}});
 const server=app;
 const get=async(path: string)=>{const r=await fetch(`http://127.0.0.1:${server.address.port}${path}`,{redirect:'manual'});const body=await r.text();return {status:r.status,location:r.headers.get('location'),body};};
 const start=performance.now(),samples: number[]=[];let requests=0;
 while(performance.now()-start<seconds*1000){
   const before=performance.now();const responses=await Promise.all(['/go','/function','/live/demo'].map(get));
   assert.deepEqual(responses.map(r=>r.status),[302,200,302]);assert.equal(responses[1]?.body,'isolated');
   assert.equal(responses[2]?.location,link.url);samples.push(performance.now()-before);requests+=3;
   if(requests%30===0)link=await store.update('links','demo',{url:`https://example.com/live-${requests}`},link.version);
 }
 await writeFile(join(project,'urlcode.yaml'),'invalid: configuration');assert.equal(await app.reload(),false);assert.equal((await get('/go')).location,'https://example.com/v1');
 await writeFile(join(project,'urlcode.yaml'),config.replace('/v1','/v2'));assert.equal(await app.reload(),true);assert.equal((await get('/go')).location,'https://example.com/v2');
 await writeFile(join(project,'urlcode.yaml'),config);assert.equal(await app.reload(),true);assert.equal((await get('/go')).location,'https://example.com/v1');
 await app.close();app=undefined;await store.close();store=undefined;
 // A read-only connection may have been the last to close, leaving WAL frames.
 // Quiesce all users, explicitly checkpoint, then close before copying.
 const checkpointDb=new DatabaseSync(file);
 try{const result=row<CheckpointRow>(checkpointDb,'PRAGMA wal_checkpoint(TRUNCATE)');assert.equal(result.busy,0);assert.equal(result.log,0);assert.equal(result.checkpointed,0);}finally{checkpointDb.close();}
 const restoreStart=performance.now(),backup=join(directory,'restored.sqlite');await copyFile(file,backup);
 store=await openLinkStore({file:backup,project,readOnly:true});assert.deepEqual(await store.get('links','demo'),link);
 const db=new DatabaseSync(backup,{readOnly:true});assert.equal(row<IntegrityRow>(db,'PRAGMA integrity_check').integrity_check,'ok');assert.equal(row<RevisionRow>(db,'SELECT max(revision) AS revision FROM urlcode_link_audit').revision,link.version);db.close();
 samples.sort((a,b)=>a-b);
 console.log(JSON.stringify({event:'local-operational-proof',seconds,requests,batchP99Ms:samples[Math.floor(samples.length*.99)],rssBytes:process.memoryUsage().rss,restoreMs:performance.now()-restoreStart,checks:['mixed HTTP load','invalid reload preserves last-good','configuration rollback','quiesced backup/restore including audit'],deploymentProof:false}));
 await store.close();store=undefined;
 // Only enable inside a disposable, size-limited mount (CI uses 16 MiB tmpfs).
 if(process.argv[2]==='--disk-full-dir'){
   const volume=resolve(process.argv[3] ?? '');const isolated=await mkdtemp(join(volume,'urlcode-full-'));
   try {
     const reserve=join(isolated,'reserve');await writeFile(reserve,Buffer.alloc(4*1024*1024));
     const fullFile=join(isolated,'full.sqlite');store=await openLinkStore({file:fullFile,project});let full=false,committed=0;
     for(let i=0;i<12000;i++){
       try{await store.create('links',{url:'https://example.com/'+ 'x'.repeat(7000)},'code-'+i);committed++;}
       catch(error){assert.ok(error instanceof HttpError,'store failure must be an HttpError');assert.equal(error.status,503);full=true;break;}
     }
     assert(full,'Disposable volume did not fill within the 84 MiB write budget');
     const space=await statfs(isolated);assert(space.bavail*space.bsize<1024*1024,'Expected actual volume exhaustion');
     await rm(reserve);await store.create('links',{url:'https://example.com/recovered'},'recovered');committed++;
     await store.close();store=undefined;
     const check=new DatabaseSync(fullFile,{readOnly:true});
     assert.equal(row<IntegrityRow>(check,'PRAGMA integrity_check').integrity_check,'ok');
     assert.equal(row<CountRow>(check,'SELECT count(*) AS n FROM urlcode_links').n,committed);
     assert.equal(row<CountRow>(check,'SELECT count(*) AS n FROM urlcode_link_audit').n,committed);check.close();
     console.log(JSON.stringify({event:'disposable-volume-exhaustion',committed,integrity:'ok',auditAtomic:true}));
   }finally{await store?.close();store=undefined;await rm(isolated,{recursive:true,force:true});}
 }
} finally {await app?.close();await store?.close();await rm(directory,{recursive:true,force:true});}
